const OPENAI_ACTION_HARD_LIMIT = 100_000;
const DEFAULT_MAX_CHARS = 72_000;
const HARD_MAX_CHARS = 85_000;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 80;
const DEFAULT_UPSTREAM_NODES = 60;
const MAX_UPSTREAM_NODES = 250;
const DEFAULT_PAGE_NODES = 50;
const MAX_PAGE_NODES = 100;

const COMPACT_PATHS = new Set([
  "/home",
  "/tree",
  "/page",
  "/world/load",
  "/load",
]);

const NOISY_KEYS = new Set([
  "object",
  "parent",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "archived",
  "in_trash",
  "annotations",
  "icon",
  "cover",
]);

function integerParam(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function plainText(richText) {
  if (!Array.isArray(richText)) return "";
  return richText
    .map((item) =>
      item?.plain_text ??
      item?.text?.content ??
      item?.equation?.expression ??
      item?.mention?.page?.id ??
      "",
    )
    .join("");
}

function compactNotionBlock(block, state) {
  state.nodes += 1;
  const type = typeof block.type === "string" ? block.type : "unknown";
  const payload = block[type] && typeof block[type] === "object" ? block[type] : {};
  const result = {};

  if (block.id) result.id = block.id;
  result.type = type;
  if (block.has_children === true) result.hasChildren = true;

  const text = plainText(payload.rich_text);
  if (text) result.text = text;

  if (typeof payload.title === "string" && payload.title) result.title = payload.title;
  if (typeof payload.checked === "boolean") result.checked = payload.checked;
  if (typeof payload.language === "string" && payload.language !== "plain text") {
    result.language = payload.language;
  }
  if (typeof payload.expression === "string") result.expression = payload.expression;
  if (typeof payload.url === "string") result.url = payload.url;
  if (typeof payload.color === "string" && payload.color !== "default") result.color = payload.color;

  if (Array.isArray(payload.caption)) {
    const caption = plainText(payload.caption);
    if (caption) result.caption = caption;
  }

  if (Array.isArray(payload.cells)) {
    result.cells = payload.cells.map((cell) => plainText(cell));
  }

  const externalUrl = payload.external?.url ?? payload.file?.url;
  if (typeof externalUrl === "string") result.url = externalUrl;

  if (block.url && typeof block.url === "string") result.notionUrl = block.url;

  if (Array.isArray(block.children)) {
    result.children = block.children.map((child) => compactAny(child, state, "children"));
  }

  return result;
}

function compactAny(value, state, keyHint = "") {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (value.length <= 12_000) return value;
    state.truncatedStrings += 1;
    return `${value.slice(0, 12_000)}\n…[gateway truncated string]`;
  }

  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    if (keyHint === "rich_text" || keyHint === "caption") return plainText(value);
    return value.map((item) => compactAny(item, state, keyHint));
  }

  if (typeof value.type === "string" && value[value.type] && typeof value[value.type] === "object") {
    return compactNotionBlock(value, state);
  }

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (NOISY_KEYS.has(key)) continue;

    if (key === "rich_text" || key === "caption") {
      const text = plainText(child);
      if (text) result[key === "rich_text" ? "text" : "caption"] = text;
      continue;
    }

    const compacted = compactAny(child, state, key);
    if (compacted === undefined) continue;
    if (Array.isArray(compacted) && compacted.length === 0) continue;
    if (compacted && typeof compacted === "object" && !Array.isArray(compacted) && Object.keys(compacted).length === 0) {
      continue;
    }
    result[key] = compacted;
  }
  return result;
}

function findPrimaryArray(root) {
  const preferred = [
    root?.data?.blocks,
    root?.data?.results,
    root?.data?.pages,
    root?.data?.tree,
    root?.blocks,
    root?.results,
    root?.pages,
    root?.tree,
  ];
  for (const candidate of preferred) {
    if (Array.isArray(candidate)) return candidate;
  }

  let best = null;
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 5) return;
    if (Array.isArray(value)) {
      const looksLikeBlocks = value.some(
        (item) => item && typeof item === "object" && ("id" in item || "type" in item),
      );
      if (looksLikeBlocks && (!best || value.length > best.length)) best = value;
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(root);
  return best;
}

function applyPagination(root, offset, limit) {
  const target = findPrimaryArray(root);
  if (!target) {
    return { offset: 0, limit, returned: 0, total: 0, hasMore: false, nextOffset: null };
  }

  const total = target.length;
  const page = target.slice(offset, offset + limit);
  target.splice(0, target.length, ...page);
  const nextOffset = offset + page.length < total ? offset + page.length : null;
  return {
    offset,
    limit,
    returned: page.length,
    total,
    hasMore: nextOffset !== null,
    nextOffset,
  };
}

function collectShrinkTargets(value, targets, depth = 0) {
  if (!value || typeof value !== "object" || depth > 20) return;
  if (Array.isArray(value)) {
    targets.arrays.push(value);
    for (const item of value) collectShrinkTargets(item, targets, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && child.length > 600) {
      targets.strings.push({ parent: value, key, length: child.length });
    } else {
      collectShrinkTargets(child, targets, depth + 1);
    }
  }
}

function fitToBudget(root, maxChars) {
  let serialized = JSON.stringify(root);
  if (serialized.length <= maxChars) {
    return { value: root, truncated: false, returnedChars: serialized.length };
  }

  let rounds = 0;
  while (serialized.length > maxChars && rounds < 30) {
    const targets = { arrays: [], strings: [] };
    collectShrinkTargets(root, targets);
    const largestArray = targets.arrays
      .filter((array) => array.length > 1)
      .sort((a, b) => b.length - a.length)[0];

    if (largestArray) {
      const keep = Math.max(1, Math.floor(largestArray.length * 0.7));
      largestArray.splice(keep);
    } else {
      const largestString = targets.strings.sort((a, b) => b.length - a.length)[0];
      if (!largestString) break;
      const current = largestString.parent[largestString.key];
      largestString.parent[largestString.key] = `${current.slice(0, Math.max(300, Math.floor(current.length * 0.6)))}…`;
    }
    serialized = JSON.stringify(root);
    rounds += 1;
  }

  if (serialized.length <= maxChars) {
    return { value: root, truncated: true, returnedChars: serialized.length };
  }

  const previewBudget = Math.max(1_000, maxChars - 600);
  const fallback = {
    ok: root?.ok ?? true,
    data: {
      truncated: true,
      preview: serialized.slice(0, previewBudget),
      guidance: "Call the same action again with nextOffset, a smaller limit, or a smaller maxNodes value.",
    },
    requestId: root?.requestId,
  };
  const fallbackText = JSON.stringify(fallback);
  return { value: fallback, truncated: true, returnedChars: fallbackText.length };
}

function addPageReadabilityFields(root) {
  const results = root?.data?.results;
  if (!Array.isArray(results)) return;

  const text = results
    .map((block) => block?.text ?? block?.title ?? block?.caption ?? "")
    .filter(Boolean)
    .join("\n");
  const maxTextChars = 24_000;

  root.data.result_count = results.length;
  root.data.has_content = results.length > 0;
  root.data.content_text = text.slice(0, maxTextChars);
  root.data.content_text_complete = text.length <= maxTextChars;
}

export function compactActionResponse(payload, options = {}) {
  const maxChars = integerParam(options.maxChars, DEFAULT_MAX_CHARS, 5_000, HARD_MAX_CHARS);
  const offset = integerParam(options.offset, 0, 0, 20_000);
  const limit = integerParam(options.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const originalChars = JSON.stringify(payload).length;
  const state = { nodes: 0, truncatedStrings: 0 };
  const compacted = compactAny(payload, state);
  const pagination = applyPagination(compacted, offset, limit);

  addPageReadabilityFields(compacted);

  compacted._gateway = {
    version: "0.5.3",
    compact: true,
    openAiActionHardLimit: OPENAI_ACTION_HARD_LIMIT,
    maxChars,
    originalChars,
    compactedNodes: state.nodes,
    truncatedStrings: state.truncatedStrings,
    pagination,
  };

  // Reserve room for the final gateway metadata added below so the serialized
  // response remains strictly inside the requested budget.
  const fitted = fitToBudget(compacted, Math.max(1_000, maxChars - 512));
  if (!fitted.value._gateway) fitted.value._gateway = {};
  fitted.value._gateway.truncated = fitted.truncated;
  fitted.value._gateway.returnedChars = JSON.stringify(fitted.value).length;

  return fitted.value;
}

function addOrReplaceParameter(parameters, parameter) {
  const index = parameters.findIndex((item) => item?.name === parameter.name && item?.in === parameter.in);
  if (index >= 0) parameters[index] = parameter;
  else parameters.push(parameter);
}

export function patchOpenApi(spec, origin) {
  const patched = structuredClone(spec);
  patched.info = { ...patched.info, version: "0.5.3" };
  patched.servers = [{ url: origin }];

  const tree = patched.paths?.["/tree"]?.get;
  if (tree) {
    tree.summary = "Read a compact, paginated Notion page tree for GPT Actions";
    tree.description = "Gateway compacts raw Notion blocks and keeps every response below the GPT Actions payload limit.";
    tree.parameters = Array.isArray(tree.parameters) ? tree.parameters : [];

    const depth = tree.parameters.find((item) => item?.name === "depth" && item?.in === "query");
    if (depth?.schema) depth.schema.default = 0;

    const maxNodes = tree.parameters.find((item) => item?.name === "maxNodes" && item?.in === "query");
    if (maxNodes?.schema) {
      maxNodes.schema.default = DEFAULT_UPSTREAM_NODES;
      maxNodes.schema.maximum = MAX_UPSTREAM_NODES;
      maxNodes.description = "Upstream safety cap. The gateway clamps this to 250 nodes.";
    }

    addOrReplaceParameter(tree.parameters, {
      name: "offset",
      in: "query",
      description: "Zero-based offset for the compact result page.",
      schema: { type: "integer", minimum: 0, default: 0 },
    });
    addOrReplaceParameter(tree.parameters, {
      name: "limit",
      in: "query",
      description: "Number of compact top-level items returned per call.",
      schema: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
    });
    addOrReplaceParameter(tree.parameters, {
      name: "maxChars",
      in: "query",
      description: "Maximum JSON response characters; gateway hard cap is 85000.",
      schema: { type: "integer", minimum: 5_000, maximum: HARD_MAX_CHARS, default: DEFAULT_MAX_CHARS },
    });
  }

  const page = patched.paths?.["/page"]?.get;
  if (page) {
    page.summary = "Read one compact Notion page batch for GPT Actions";
    page.description = "Use this operation once per 12–29 module. Follow the returned cursor until has_more is false; do not combine modules into one request.";
    page.parameters = Array.isArray(page.parameters) ? page.parameters : [];

    const depth = page.parameters.find((item) => item?.name === "depth" && item?.in === "query");
    if (depth?.schema) depth.schema.default = 0;

    const maxNodes = page.parameters.find((item) => item?.name === "maxNodes" && item?.in === "query");
    if (maxNodes?.schema) {
      maxNodes.schema.default = DEFAULT_PAGE_NODES;
      maxNodes.schema.maximum = MAX_PAGE_NODES;
      maxNodes.description = "Blocks per page batch. Gateway clamps this to 100; use cursor for the next batch.";
    }

    addOrReplaceParameter(page.parameters, {
      name: "maxChars",
      in: "query",
      description: "Maximum compact JSON response characters; gateway hard cap is 85000.",
      schema: { type: "integer", minimum: 5_000, maximum: HARD_MAX_CHARS, default: DEFAULT_MAX_CHARS },
    });
  }

  const worldLoad = patched.paths?.["/world/load"]?.post;
  if (worldLoad) {
    worldLoad.description = "Loads a bounded world profile. Do not use this operation to read all 12–29 rules; call getNotionPage once per module and follow cursor pagination.";
  }

  return patched;
}

export function buildUpstreamRequest(request) {
  const incoming = new URL(request.url);
  const upstream = new URL(`${incoming.pathname}${incoming.search}`, "https://xuanche-engine.internal");

  if (incoming.pathname === "/tree" || incoming.pathname === "/home" || incoming.pathname === "/page") {
    const isPage = incoming.pathname === "/page";
    const offset = integerParam(incoming.searchParams.get("offset"), 0, 0, 20_000);
    const limit = integerParam(incoming.searchParams.get("limit"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const requestedNodes = integerParam(
      incoming.searchParams.get("maxNodes"),
      isPage ? DEFAULT_PAGE_NODES : Math.max(DEFAULT_UPSTREAM_NODES, offset + limit),
      1,
      isPage ? MAX_PAGE_NODES : MAX_UPSTREAM_NODES,
    );
    upstream.searchParams.set("maxNodes", String(requestedNodes));
    if (!upstream.searchParams.has("depth")) upstream.searchParams.set("depth", "0");
  }

  upstream.searchParams.delete("offset");
  upstream.searchParams.delete("limit");
  upstream.searchParams.delete("maxChars");
  upstream.searchParams.delete("compact");

  const init = {
    method: request.method,
    headers: new Headers(request.headers),
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  return new Request(upstream, init);
}

function corsHeaders(headers = new Headers()) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key");
  headers.set("Access-Control-Expose-Headers", "X-Xuanche-Gateway, X-Xuanche-Gateway-Version, X-Xuanche-Page-Batch-Sizing, X-Xuanche-Readable-Page-Payload");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Xuanche-Gateway", "cloudflare-pages");
  headers.set("X-Xuanche-Gateway-Version", "0.5.3");
  headers.set("X-Xuanche-Page-Batch-Sizing", "true");
  headers.set("X-Xuanche-Readable-Page-Payload", "true");
  return headers;
}

function jsonResponse(value, status = 200, headers = new Headers()) {
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers: corsHeaders(headers) });
}

async function fetchUpstream(context, request) {
  if (!context.env?.XUANCHE_ENGINE?.fetch) {
    return jsonResponse(
      { ok: false, error: "Missing Cloudflare Service binding: XUANCHE_ENGINE" },
      500,
    );
  }
  return context.env.XUANCHE_ENGINE.fetch(request);
}

export async function onRequest(context) {
  const request = context.request;
  const incoming = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const upstreamRequest = buildUpstreamRequest(request);
  const upstreamResponse = await fetchUpstream(context, upstreamRequest);

  if (incoming.pathname === "/openapi.json" && upstreamResponse.ok) {
    const spec = await upstreamResponse.json();
    return jsonResponse(patchOpenApi(spec, incoming.origin), upstreamResponse.status);
  }

  const shouldCompact =
    COMPACT_PATHS.has(incoming.pathname) || incoming.searchParams.get("compact") === "true";
  const contentType = upstreamResponse.headers.get("content-type") ?? "";

  if (shouldCompact && upstreamResponse.ok && contentType.includes("application/json")) {
    const payload = await upstreamResponse.json();
    const compacted = compactActionResponse(payload, {
      offset: incoming.searchParams.get("offset"),
      limit: incoming.pathname === "/page"
        ? (incoming.searchParams.get("limit") ?? String(DEFAULT_PAGE_NODES))
        : incoming.searchParams.get("limit"),
      maxChars: incoming.searchParams.get("maxChars"),
    });
    const headers = new Headers(upstreamResponse.headers);
    headers.set("X-Xuanche-Compacted", "true");
    headers.set("X-Xuanche-Returned-Chars", String(JSON.stringify(compacted).length));
    return jsonResponse(compacted, upstreamResponse.status, headers);
  }

  const headers = corsHeaders(new Headers(upstreamResponse.headers));
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}
