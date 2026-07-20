import { PRIVACY_POLICY_HTML } from "./privacy.js";

const OPENAI_ACTION_HARD_LIMIT = 100_000;
const DEFAULT_MAX_CHARS = 72_000;
const HARD_MAX_CHARS = 85_000;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 80;
const DEFAULT_UPSTREAM_NODES = 60;
const MAX_UPSTREAM_NODES = 250;
const DEFAULT_PAGE_NODES = 10;
const MAX_PAGE_NODES = 20;
const GATEWAY_VERSION = "0.6.0";

const WORLD_PAGE_KEYS = [
  "save", "character", "timeline", "knowledge", "relationships",
  "causality", "clues", "events", "director", "experience",
];

const SAFE_PUBLIC_OPERATIONS = [
  { path: "/health", method: "get", operationId: "getEngineHealth" },
  { path: "/tree", method: "get", operationId: "getNotionTree" },
  { path: "/page", method: "get", operationId: "getNotionPage" },
  { path: "/world/initialize", method: "post", operationId: "initializeWorld" },
  { path: "/world/archive-reset", method: "post", operationId: "archiveAndResetWorld" },
  { path: "/world/archive-reset/status", method: "get", operationId: "getArchiveAndResetStatus" },
  { path: "/world/load", method: "post", operationId: "loadWorldProfile" },
  { path: "/world/update", method: "post", operationId: "updateWorldState" },
  { path: "/github/tree", method: "get", operationId: "listGitHubWorldTree" },
  { path: "/github/file", method: "get", operationId: "getGitHubWorldFile" },
];

const GPT_ACTION_PATHS = [
  ["/tree", "get", "getNotionTree", true],
  ["/page", "get", "getNotionPage", true],
  ["/world/load", "post", "loadWorldProfile", true],
  ["/world/initialize", "post", "initializeWorld", true],
  ["/world/archive-reset", "post", "archiveAndResetWorld", true],
  ["/world/archive-reset/status", "get", "getArchiveAndResetStatus", true],
  ["/world/update", "post", "updateWorldState", true],
];

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

  if (
    value.object === "block" &&
    typeof value.type === "string" &&
    value[value.type] &&
    typeof value[value.type] === "object"
  ) {
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

function normalizePageBatch(root) {
  const data = root?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return;

  const items = [data.items, data.results, data.blocks, data.children]
    .find((candidate) => Array.isArray(candidate)) ?? [];
  const hasMore = data.has_more ?? root.has_more ?? false;
  const cursor = data.cursor ?? data.next_cursor ?? root.cursor ?? null;

  data.items = items;
  data.has_more = hasMore === true;
  data.cursor = data.has_more && typeof cursor === "string" && cursor.length > 0
    ? cursor
    : null;

  delete data.results;
  delete data.blocks;
  delete data.children;
  delete data.next_cursor;
  delete root.has_more;
  delete root.cursor;
}

function addPageReadabilityFields(root) {
  const results = [root?.data?.items, root?.data?.results, root?.data?.blocks]
    .find((candidate) => Array.isArray(candidate));
  if (!results) return;

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

  if (options.pageBatch === true) normalizePageBatch(compacted);
  addPageReadabilityFields(compacted);

  compacted._gateway = {
    version: GATEWAY_VERSION,
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
  const responseTruncated = fitted.truncated || state.truncatedStrings > 0;
  if (!fitted.value._gateway) fitted.value._gateway = {};
  fitted.value._gateway.truncated = responseTruncated;
  if (options.pageBatch === true && fitted.value.data && typeof fitted.value.data === "object") {
    if (!Array.isArray(fitted.value.data.items)) fitted.value.data.items = [];
    if (typeof fitted.value.data.has_more !== "boolean") fitted.value.data.has_more = false;
    if (!Object.hasOwn(fitted.value.data, "cursor")) fitted.value.data.cursor = null;
    fitted.value.data.truncated = responseTruncated;
  }
  fitted.value._gateway.returnedChars = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const returnedChars = JSON.stringify(fitted.value).length;
    if (fitted.value._gateway.returnedChars === returnedChars) break;
    fitted.value._gateway.returnedChars = returnedChars;
  }

  return fitted.value;
}

function addOrReplaceParameter(parameters, parameter) {
  const index = parameters.findIndex((item) => item?.name === parameter.name && item?.in === parameter.in);
  if (index >= 0) parameters[index] = parameter;
  else parameters.push(parameter);
}

function versionAtLeast(actual, minimum) {
  const left = String(actual || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = String(minimum || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) > (right[index] || 0)) return true;
    if ((left[index] || 0) < (right[index] || 0)) return false;
  }
  return true;
}

function filterPublicPaths(paths = {}, { worldStateReady = false, initializationReady = false, archiveResetReady = false } = {}) {
  const filtered = {};

  for (const { path, method, operationId } of SAFE_PUBLIC_OPERATIONS) {
    if (!worldStateReady && (path === "/world/load" || path === "/world/update")) continue;
    if (!initializationReady && path === "/world/initialize") continue;
    if (!archiveResetReady && (path === "/world/archive-reset" || path === "/world/archive-reset/status")) continue;
    const sourcePath = paths[path];
    const sourceOperation = sourcePath?.[method];
    if (sourceOperation?.operationId !== operationId) continue;

    const targetPath = filtered[path] ?? {};
    if (Array.isArray(sourcePath.parameters)) targetPath.parameters = sourcePath.parameters;
    targetPath[method] = sourceOperation;
    filtered[path] = targetPath;
  }

  return filtered;
}

function pageBatchResponseSchema() {
  return {
    type: "object",
    required: ["ok", "data", "_gateway"],
    properties: {
      ok: { type: "boolean", enum: [true] },
      data: {
        type: "object",
        required: ["items", "has_more", "cursor", "truncated"],
        properties: {
          items: {
            type: "array",
            description: "Compact blocks from exactly one Notion page batch.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                type: { type: "string" },
                text: { type: "string" },
                title: { type: "string" },
                caption: { type: "string" },
                hasChildren: { type: "boolean" },
              },
              additionalProperties: true,
            },
          },
          has_more: {
            type: "boolean",
            description: "True when Notion has another native batch for this same page.",
          },
          cursor: {
            type: "string",
            nullable: true,
            description: "Pass this cursor to the next getNotionPage call for the same page; null when has_more is false.",
          },
          truncated: {
            type: "boolean",
            description: "True when the gateway reduced this response to stay within maxChars.",
          },
          result_count: { type: "integer", minimum: 0 },
          has_content: { type: "boolean" },
          content_text: { type: "string" },
          content_text_complete: {
            type: "boolean",
            description: "False when only the convenience content_text field was shortened.",
          },
        },
        additionalProperties: true,
      },
      requestId: { type: "string" },
      _gateway: {
        type: "object",
        required: ["version", "truncated"],
        properties: {
          version: { type: "string", enum: [GATEWAY_VERSION] },
          truncated: {
            type: "boolean",
            description: "True when any response content was reduced to satisfy the character budget.",
          },
          truncatedStrings: { type: "integer", minimum: 0 },
          returnedChars: { type: "integer", minimum: 0 },
        },
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  };
}

export function patchOpenApi(spec, origin) {
  const patched = structuredClone(spec);
  const privacyPolicyUrl = new URL("/privacy", origin).href;
  const backendVersion = patched.info?.version || "0.0.0";
  const worldStateReady = versionAtLeast(backendVersion, "0.5.6");
  const initializationReady = versionAtLeast(backendVersion, "0.5.7");
  const archiveResetReady = versionAtLeast(backendVersion, "0.5.16");
  patched.info = {
    ...patched.info,
    version: GATEWAY_VERSION,
    description: initializationReady
      ? "Safety-scoped GPT Actions gateway for compensated SAVE_V3.2 initialization, bounded reads, TURN_PRELOAD_V1 profile loads, idempotent updates, and read-only GitHub memory. Privacy policy: " + privacyPolicyUrl
      : worldStateReady
        ? "Safety-scoped GPT Actions gateway. World load/update are enabled; initialization remains disabled until the bound Worker reaches version 0.5.7. Privacy policy: " + privacyPolicyUrl
      : "Safety-scoped GPT Actions gateway. World load and update actions are disabled until the bound Worker reaches version 0.5.6. Privacy policy: " + privacyPolicyUrl,
  };
  patched.servers = [{ url: origin }];
  patched.externalDocs = {
    description: "玄澈引擎 Gateway 隱私權政策",
    url: privacyPolicyUrl,
  };
  patched["x-xuanche-backend"] = { version: backendVersion, worldStateReady, initializationReady, archiveResetReady };
  patched.paths = filterPublicPaths(patched.paths, { worldStateReady, initializationReady, archiveResetReady });
  patched.components = patched.components ?? {};
  patched.components.schemas = patched.components.schemas ?? {};
  patched.components.schemas.PageBatchResponse = pageBatchResponseSchema();
  if (!worldStateReady) {
    delete patched.components.schemas.WorldLoadRequest;
    delete patched.components.schemas.WorldUpdateRequest;
    delete patched.components.schemas.BlockUpdate;
  }
  if (!initializationReady) delete patched.components.schemas.WorldInitializeRequest;
  if (!archiveResetReady) delete patched.components.schemas.WorldArchiveResetRequest;

  const tree = patched.paths?.["/tree"]?.get;
  if (tree) {
    tree.summary = "Read a compact, paginated Notion page tree for GPT Actions";
    tree.description = "Use only as a lightweight direct-child index. The gateway forces depth 0; read every module body with getNotionPage, one page at a time.";
    tree.parameters = Array.isArray(tree.parameters) ? tree.parameters : [];

    const depth = tree.parameters.find((item) => item?.name === "depth" && item?.in === "query");
    if (depth?.schema) {
      depth.schema.minimum = 0;
      depth.schema.maximum = 0;
      depth.schema.default = 0;
      depth.description = "Direct children only. The gateway always sends depth 0 upstream.";
    }

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
    page.description = "Read exactly one Notion page per call. This applies to every page and module, including 00–31, each 30-x narrative submodule, and each selected 31 experience card. Never combine modules in one request. Follow data.cursor for the same page until data.has_more is false.";
    page.parameters = Array.isArray(page.parameters) ? page.parameters : [];

    const depth = page.parameters.find((item) => item?.name === "depth" && item?.in === "query");
    if (depth?.schema) {
      depth.schema.minimum = 0;
      depth.schema.maximum = 0;
      depth.schema.default = 0;
      depth.description = "Direct blocks only. The gateway always sends depth 0 upstream.";
    }

    const maxNodes = page.parameters.find((item) => item?.name === "maxNodes" && item?.in === "query");
    if (maxNodes?.schema) {
      maxNodes.schema.default = DEFAULT_PAGE_NODES;
      maxNodes.schema.maximum = MAX_PAGE_NODES;
      maxNodes.description = "Blocks per page batch. Gateway defaults to 10 and clamps every request to 20; when cursor is returned, call getNotionPage again with the same page id and that cursor.";
    }

    addOrReplaceParameter(page.parameters, {
      name: "maxChars",
      in: "query",
      description: "Maximum compact JSON response characters; gateway hard cap is 85000.",
      schema: { type: "integer", minimum: 5_000, maximum: HARD_MAX_CHARS, default: DEFAULT_MAX_CHARS },
    });
    page.responses = page.responses ?? {};
    page.responses["200"] = {
      description: "One compact, cursor-paginated Notion page batch",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/PageBatchResponse" },
        },
      },
    };
  }

  const loadWorld = patched.paths?.["/world/load"]?.post;
  if (loadWorld) {
    loadWorld.description = "Use turn_core once after each player reply with refresh=false. Add at most one action-specific profile only when the current action truly needs it. Reads are shallow, compact, and cached per page.";
  }

  const initializeWorld = patched.paths?.["/world/initialize"]?.post;
  if (initializeWorld) {
    initializeWorld.description = "Use only after explicit character confirmation. It stages fixed SAVE_V3.2 pages, activates the save marker last, validates the result, and makes retries idempotent.";
  }

  const archiveAndReset = patched.paths?.["/world/archive-reset"]?.post;
  if (archiveAndReset) {
    archiveAndReset.description = "Destructive. Use only after confirming the exact ACTIVE WORLD_ID. The Worker archives and verifies fixed pages before setting them EMPTY/PENDING. If interrupted, reuse the same operationKey until reset=true.";
  }

  const archiveStatus = patched.paths?.["/world/archive-reset/status"]?.get;
  if (archiveStatus) {
    archiveStatus.description = "Read the durable archive-and-reset workflow. Do not begin a new world until reset is true and worldState is EMPTY.";
  }

  const updateWorld = patched.paths?.["/world/update"]?.post;
  if (updateWorld) {
    updateWorld.description = "Batch every page changed by the same turn in mutations so 02 is verified once. Use stable pageKey values and semantic block prefixes; never copy raw Notion IDs into gameplay writes.";
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
    if (incoming.pathname === "/tree" || incoming.pathname === "/page") {
      upstream.searchParams.set("depth", "0");
    } else if (!upstream.searchParams.has("depth")) {
      upstream.searchParams.set("depth", "0");
    }
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
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // Cloudflare accepts a streamed Request body directly; Node's standards
    // implementation also requires this explicit flag. Keeping it here makes
    // the exact POST forwarding path testable before deployment.
    init.duplex = "half";
  }
  return new Request(upstream, init);
}

function corsHeaders(headers = new Headers()) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key");
  headers.set("Access-Control-Expose-Headers", "X-Xuanche-Gateway, X-Xuanche-Gateway-Version, X-Xuanche-Page-Batch-Sizing, X-Xuanche-Page-Batch-Limit, X-Xuanche-Readable-Page-Payload");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Xuanche-Gateway", "cloudflare-pages");
  headers.set("X-Xuanche-Gateway-Version", GATEWAY_VERSION);
  headers.set("X-Xuanche-Page-Batch-Sizing", "true");
  headers.set("X-Xuanche-Page-Batch-Limit", "20");
  headers.set("X-Xuanche-Readable-Page-Payload", "true");
  return headers;
}

function jsonResponse(value, status = 200, headers = new Headers()) {
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers: corsHeaders(headers) });
}

// ChatGPT Actions can reject otherwise-valid, large OpenAPI documents before a
// request reaches the origin.  Keep this manifest deliberately flat: it is an
// alternate *description* of the same protected gateway routes, not another
// backend or a relaxed authorization path.
function compactRequestSchema(operationId) {
  if (operationId === "loadWorldProfile") {
    return {
      type: "object",
      required: ["profile"],
      properties: {
        profile: {
          type: "string",
          enum: [
            "turn_core", "turn_combat", "turn_dialogue", "turn_exploration",
            "turn_cultivation", "turn_trade", "turn_travel",
          ],
          description: "Load turn_core first. A second call is optional and limited to one action-specific profile.",
        },
        refresh: {
          type: "boolean",
          default: false,
          description: "Keep false during normal play so unchanged pages use the safe page-granular cache.",
        },
        persist: { type: "boolean", enum: [false], default: false },
        maxDepth: { type: "integer", enum: [0], default: 0 },
        maxNodes: { type: "integer", minimum: 1, maximum: 200, default: 60 },
      },
      additionalProperties: false,
    };
  }
  if (operationId === "archiveAndResetWorld") {
    return {
      type: "object",
      required: ["confirmation", "expectedWorldId", "operationKey"],
      properties: {
        confirmation: {
          type: "string",
          enum: ["ARCHIVE_AND_RESET"],
          description: "Exact acknowledgement supplied only after the player explicitly authorizes archiving and resetting the active world.",
        },
        expectedWorldId: {
          type: "string",
          pattern: "^W\\d{8}-[0-9A-F]{8}$",
          description: "Exact WORLD_ID of the active world. Never guess or reuse an ID from an older archive.",
        },
        operationKey: {
          type: "string",
          minLength: 8,
          maxLength: 120,
          pattern: "^[A-Za-z0-9._-]+$",
          description: "Stable idempotency key for this exact reset. Preserve it for every status check or permitted retry; archiveId is not an operationKey.",
        },
      },
      additionalProperties: false,
    };
  }
  if (operationId === "initializeWorld") {
    return {
      type: "object",
      required: ["saveKey", "character"],
      properties: {
        saveKey: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          pattern: "^[^\\r\\n\\s](?:[^\\r\\n]*[^\\r\\n\\s])?$",
          description: "Stable idempotency key for this confirmed character. Reuse the same value for any retry.",
        },
        character: {
          type: "object",
          required: ["name", "motto", "coreDesire", "weaknessFear"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            gender: { type: "string", minLength: 1, maxLength: 40 },
            age: {
              oneOf: [
                { type: "integer", minimum: 0, maximum: 10000 },
                { type: "string", minLength: 1, maxLength: 40 },
              ],
            },
            motto: { type: "string", minLength: 1, maxLength: 300, description: "A concise line that expresses the character's defining conviction." },
            appearance: { type: "string", minLength: 1, maxLength: 1000 },
            personality: {
              oneOf: [
                { type: "string", minLength: 1, maxLength: 1000 },
                {
                  type: "array",
                  maxItems: 8,
                  items: { type: "string", minLength: 1, maxLength: 240 },
                },
              ],
            },
            background: { type: "string", minLength: 1, maxLength: 1600 },
            importantBonds: {
              type: "array",
              maxItems: 10,
              items: { type: "string", minLength: 1, maxLength: 300 },
            },
            motivation: { type: "string", minLength: 1, maxLength: 800 },
            coreDesire: { type: "string", minLength: 1, maxLength: 800 },
            bottomLine: { type: "string", minLength: 1, maxLength: 800 },
            weaknessFear: { type: "string", minLength: 1, maxLength: 1000, description: "The character's concrete weakness or deepest fear; never omit it from the saved character." },
            startingStyle: { type: "string", minLength: 1, maxLength: 800 },
            destinyTalents: {
              type: "array",
              maxItems: 8,
              items: {
                oneOf: [
                  { type: "string", minLength: 1, maxLength: 700 },
                  {
                    type: "object",
                    required: ["name", "description"],
                    properties: {
                      name: { type: "string", minLength: 1, maxLength: 100 },
                      description: { type: "string", minLength: 1, maxLength: 600 },
                    },
                    additionalProperties: true,
                  },
                ],
              },
            },
            relationships: {
              type: "array",
              maxItems: 20,
              items: {
                oneOf: [
                  { type: "string", minLength: 1, maxLength: 700 },
                  {
                    type: "object",
                    required: ["name", "relationship"],
                    properties: {
                      name: { type: "string", minLength: 1, maxLength: 100 },
                      relationship: { type: "string", minLength: 1, maxLength: 160 },
                      importance: { type: "string", maxLength: 400 },
                      notes: { type: "string", maxLength: 600 },
                    },
                    additionalProperties: true,
                  },
                ],
              },
            },
          },
          additionalProperties: false,
        },
        opening: {
          type: "object",
          required: ["location", "time", "premise"],
          properties: {
            location: { type: "string", minLength: 1, maxLength: 300 },
            time: { type: "string", minLength: 1, maxLength: 200 },
            premise: { type: "string", minLength: 1, maxLength: 1600 },
            knownAbilities: { type: "array", maxItems: 12, items: { oneOf: [{ type: "string", minLength: 1, maxLength: 400 }, { type: "object", properties: {}, additionalProperties: true }] } },
            knownWorldFacts: { type: "array", maxItems: 12, items: { oneOf: [{ type: "string", minLength: 1, maxLength: 500 }, { type: "object", properties: {}, additionalProperties: true }] } },
            promises: { type: "array", maxItems: 12, items: { oneOf: [{ type: "string", minLength: 1, maxLength: 500 }, { type: "object", properties: {}, additionalProperties: true }] } },
            visibleClue: { type: "string", minLength: 1, maxLength: 800 },
            choices: { type: "array", maxItems: 4, items: { oneOf: [{ type: "string", minLength: 1, maxLength: 600 }, { type: "object", properties: {}, additionalProperties: true }] } },
            contracts: { type: "array", maxItems: 12, items: { oneOf: [{ type: "string", minLength: 1, maxLength: 600 }, { type: "object", properties: {}, additionalProperties: true }] } },
            hiddenOrigin: { type: "string", minLength: 1, maxLength: 1600, description: "Director-only causal truth. Save it, but never reveal it to the player before discovery." },
            directorNotes: { type: "string", minLength: 1, maxLength: 1600, description: "Director-only continuity notes. Do not quote or expose them in player-facing narration." },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    };
  }
  if (operationId === "updateWorldState") {
    const pageMutation = {
      type: "object",
      required: ["pageKey"],
      properties: {
        pageKey: {
          type: "string",
          enum: WORLD_PAGE_KEYS,
          description: "Fixed world page target. Ordinary turns use save; never put a player choice number or Notion ID here.",
        },
        children: {
          type: "array", minItems: 1, maxItems: 50,
          items: { type: "string", minLength: 1, maxLength: 1800 },
          description: "Append-only paragraph text. The Worker converts strings into valid Notion blocks.",
        },
        blockUpdates: {
          type: "array",
          minItems: 1,
          maxItems: 25,
          items: {
            type: "object",
            required: ["matchPrefix", "type"],
            properties: {
              matchPrefix: {
                type: "string",
                minLength: 2,
                maxLength: 120,
                description: "Unique stable text label at the start of the target block, such as SIM_TICK： or 當前主線：. Never send a Notion block ID.",
              },
              type: { type: "string", enum: ["paragraph", "callout", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "quote", "toggle", "to_do", "table_row"] },
              text: { type: "string", maxLength: 1800 },
              cells: { type: "array", minItems: 1, maxItems: 30, items: { type: "string", maxLength: 1800 } },
              checked: { type: "boolean" },
              expectedText: { type: "string", maxLength: 1800 },
            },
            additionalProperties: false,
          },
        },
      },
      anyOf: [{ required: ["children"] }, { required: ["blockUpdates"] }],
      additionalProperties: false,
    };
    return {
      type: "object",
      required: ["saveKey", "expectedWorldId", "expectedWorldState", "expectedRevision"],
      properties: {
        ...pageMutation.properties,
        saveKey: { type: "string", minLength: 1, maxLength: 200, pattern: "^[^\\r\\n\\s](?:[^\\r\\n]*[^\\r\\n\\s])?$" },
        expectedWorldId: { type: "string", pattern: "^W\\d{8}-[0-9A-F]{8}$" },
        expectedWorldState: { type: "string", enum: ["ACTIVE"], description: "Narrative updates are allowed only for the verified ACTIVE world." },
        expectedRevision: { type: "integer", minimum: 0 },
        mutations: {
          type: "array",
          minItems: 1,
          maxItems: 9,
          items: pageMutation,
          description: "Preferred FAST_TURN_V1 form. Include every page changed by one major event in one action call.",
        },
      },
      anyOf: [
        {
          required: ["pageKey"],
          anyOf: [{ required: ["children"] }, { required: ["blockUpdates"] }],
        },
        { required: ["mutations"] },
      ],
      additionalProperties: false,
    };
  }
  return { type: "object", properties: {}, additionalProperties: true };
}

function compactParameters(operationId) {
  if (operationId === "getNotionTree") {
    return [
      {
        name: "pageId",
        in: "query",
        description: "Optional allowlisted directory page. Omit it to list the configured world home.",
        schema: { type: "string", pattern: "^[0-9a-fA-F-]{32,36}$" },
      },
      { name: "depth", in: "query", description: "Directory reads are always shallow.", schema: { type: "integer", enum: [0], default: 0 } },
      { name: "maxNodes", in: "query", description: "Maximum direct directory entries.", schema: { type: "integer", minimum: 1, maximum: 60, default: 20 } },
    ];
  }
  if (operationId === "getNotionPage") {
    return [
      { name: "id", in: "query", required: true, description: "Exact allowlisted Notion page or block ID.", schema: { type: "string", pattern: "^[0-9a-fA-F-]{32,36}$" } },
      { name: "depth", in: "query", description: "Content reads are always limited to direct child blocks.", schema: { type: "integer", enum: [0], default: 0 } },
      { name: "maxNodes", in: "query", description: "Small bounded page batch; continue with cursor when has_more is true.", schema: { type: "integer", minimum: 1, maximum: 20, default: 10 } },
      { name: "cursor", in: "query", description: "Use only next_cursor returned by the previous batch of this same page.", schema: { type: "string", minLength: 1, maxLength: 300 } },
    ];
  }
  if (operationId === "getArchiveAndResetStatus") {
    return [
      { name: "expectedWorldId", in: "query", required: true, description: "WORLD_ID originally passed to archiveAndResetWorld.", schema: { type: "string", pattern: "^W\\d{8}-[0-9A-F]{8}$" } },
      { name: "operationKey", in: "query", required: true, description: "Original operationKey. Never substitute archiveId or workflowId.", schema: { type: "string", minLength: 8, maxLength: 120, pattern: "^[A-Za-z0-9._-]+$" } },
    ];
  }
  return [];
}

const GPT_ACTION_COPY = {
  loadWorldProfile: {
    summary: "Load the cached context for one FAST_TURN_V1 step",
    description: "Call turn_core once after a player reply with refresh=false. Add at most one specialized profile only when necessary; never scan pages individually when this profile load succeeds.",
  },
  getNotionTree: {
    summary: "List the shallow Notion world directory",
    description: "Use only to discover direct child-page links from the configured world index. It is not a content loader, is never recursive, and must not be used to scan archives or replace getNotionPage.",
  },
  getNotionPage: {
    summary: "Read one allowlisted Notion page batch",
    description: "Primary bounded content read. Request one known page with depth 0 and at most 20 blocks. When has_more is true, continue only that same page with its returned next_cursor; never scan archive pages.",
  },
  initializeWorld: {
    summary: "Initialize a confirmed character and new world",
    description: "Call exactly once in the same turn after the player explicitly confirms the complete character draft and all fixed pages are EMPTY/PENDING. On retry reuse the same saveKey. Never replace an ACTIVE world.",
  },
  archiveAndResetWorld: {
    summary: "Start the durable archive-and-reset workflow",
    description: "Consequential start operation. Call once only after explicit player authorization. HTTP 202 means accepted, not finished. Preserve operationKey and poll getArchiveAndResetStatus; never resend while nextAction is POLL_STATUS.",
  },
  getArchiveAndResetStatus: {
    summary: "Check an existing archive-and-reset workflow",
    description: "Read-only status check using the original WORLD_ID and operationKey. Never use archiveId or workflowId as operationKey. Initialize only when safeToInitialize is true and nextAction is INITIALIZE_WORLD.",
  },
  updateWorldState: {
    summary: "Commit one batched FAST_TURN_V1 world update",
    description: "Ordinary turns use pageKey save. For a major event, batch every changed fixed page in mutations. Use semantic matchPrefix selectors for existing blocks; never send player option numbers or raw Notion IDs.",
  },
};

function compactResponseSchemas() {
  const compactBlock = {
    type: "object",
    properties: {
      id: { type: "string" },
      type: { type: "string" },
      text: { type: "string" },
      title: { type: "string" },
      hasChildren: { type: "boolean" },
      checked: { type: "boolean" },
    },
    additionalProperties: true,
  };
  const gatewayMetadata = {
    type: "object",
    properties: {
      version: { type: "string", enum: [GATEWAY_VERSION] },
      compact: { type: "boolean" },
      truncated: { type: "boolean" },
      returnedChars: { type: "integer", minimum: 0 },
      pagination: {
        type: "object",
        properties: {
          hasMore: { type: "boolean" },
          nextOffset: { type: ["integer", "null"] },
        },
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  };
  const errorEnvelope = {
    type: "object",
    required: ["ok", "error", "requestId"],
    properties: {
      ok: { type: "boolean", enum: [false] },
      error: { type: "string" },
      requestId: { type: "string" },
      details: { type: "object", properties: {}, additionalProperties: true },
    },
    additionalProperties: false,
  };
  const readData = {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      items: { type: "array", items: compactBlock },
      blocks: { type: "array", items: compactBlock },
      content_text: { type: "string" },
      result_count: { type: "integer", minimum: 0 },
      has_content: { type: "boolean" },
      has_more: { type: "boolean" },
      next_cursor: { type: ["string", "null"] },
      cursor: { type: ["string", "null"] },
      truncated: { type: "boolean" },
    },
    additionalProperties: true,
  };
  const archiveProgress = {
    type: "object",
    required: ["archivedPageKeys", "archivedPageCount", "resetPageKeys", "resetPageCount", "totalPageCount"],
    properties: {
      archivedPageKeys: { type: "array", items: { type: "string" } },
      archivedPageCount: { type: "integer", minimum: 0 },
      resetPageKeys: { type: "array", items: { type: "string" } },
      resetPageCount: { type: "integer", minimum: 0 },
      totalPageCount: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  };
  const archiveData = {
    type: "object",
    required: [
      "accepted", "completed", "safeToInitialize", "archiveVerified", "reset",
      "worldState", "phase", "operationKey", "archiveId", "workflowId",
      "workflowStatus", "workflowAttempt", "continuationSequence", "progress",
      "retryable", "requiresOperatorAction", "nextAction", "nextPollAfterSeconds", "error",
    ],
    properties: {
      accepted: { type: "boolean", enum: [true] },
      completed: { type: "boolean" },
      safeToInitialize: { type: "boolean", description: "True only after every fixed world page is EMPTY/PENDING and reset verification completed." },
      archiveVerified: { type: "boolean" },
      reset: { type: "boolean" },
      worldState: { type: "string", enum: ["ARCHIVING", "RESETTING", "EMPTY", "UNKNOWN"] },
      phase: { type: "string", enum: ["queued", "archiving", "archive_verified", "resetting", "complete", "unknown"] },
      operationKey: { type: "string", description: "Original caller-supplied idempotency key." },
      archiveId: { type: ["string", "null"], description: "Server-generated archive identity; never use it as operationKey." },
      workflowId: { type: ["string", "null"], description: "Cloudflare Workflow instance identity; never use it as operationKey." },
      workflowStatus: { type: "string", enum: ["queued", "running", "waiting", "waitingForPause", "paused", "complete", "errored", "terminated", "canceled", "cancelled", "unknown"] },
      workflowAttempt: { type: "integer", minimum: 0 },
      continuationSequence: { type: "integer", minimum: 0 },
      progress: archiveProgress,
      retryable: { type: "boolean" },
      requiresOperatorAction: { type: "boolean" },
      nextAction: { type: "string", enum: ["POLL_STATUS", "INITIALIZE_WORLD", "RETRY_SAME_OPERATION", "STOP_AND_REPORT"] },
      nextPollAfterSeconds: { type: ["integer", "null"], minimum: 1 },
      error: { type: ["string", "null"] },
    },
    additionalProperties: false,
  };
  return {
    ErrorEnvelope: errorEnvelope,
    ReadEnvelope: {
      type: "object",
      required: ["ok", "data", "requestId"],
      properties: {
        ok: { type: "boolean", enum: [true] },
        data: readData,
        requestId: { type: "string" },
        _gateway: gatewayMetadata,
      },
      additionalProperties: true,
    },
    InitializeWorldEnvelope: {
      type: "object",
      required: ["ok", "data", "requestId"],
      properties: {
        ok: { type: "boolean", enum: [true] },
        data: {
          type: "object",
          required: ["idempotent", "initialized", "worldId", "worldState", "simTick", "revision", "saveKey"],
          properties: {
            idempotent: { type: "boolean" },
            initialized: { type: "boolean", enum: [true] },
            worldId: { type: "string", pattern: "^W\\d{8}-[0-9A-F]{8}$" },
            worldState: { type: "string", enum: ["ACTIVE"] },
            simTick: { type: "integer", minimum: 0 },
            revision: { type: "integer", minimum: 1 },
            saveKey: { type: "string" },
            validatedPageKeys: { type: "array", items: { type: "string" } },
            verification: { type: "object", properties: {}, additionalProperties: true },
            statusMirror: { type: "object", properties: {}, additionalProperties: true },
            mirror: { type: "object", properties: {}, additionalProperties: true },
          },
          additionalProperties: true,
        },
        requestId: { type: "string" },
      },
      additionalProperties: false,
    },
    UpdateWorldEnvelope: {
      type: "object",
      required: ["ok", "data", "requestId"],
      properties: {
        ok: { type: "boolean", enum: [true] },
        data: {
          type: "object",
          required: ["idempotent", "saveKey", "worldState", "worldId", "timestamp"],
          properties: {
            idempotent: { type: "boolean" },
            saveKey: { type: "string" },
            worldState: { type: "string", enum: ["ACTIVE"] },
            worldId: { type: "string", pattern: "^W\\d{8}-[0-9A-F]{8}$" },
            timestamp: { type: "string", format: "date-time" },
            notion: { type: "object", properties: {}, additionalProperties: true },
            githubSync: { type: "object", properties: {}, additionalProperties: true },
            cacheEntriesInvalidated: { type: "integer", minimum: 0 },
            timings: { type: "object", properties: {}, additionalProperties: true },
          },
          additionalProperties: true,
        },
        requestId: { type: "string" },
      },
      additionalProperties: false,
    },
    ArchiveResetEnvelope: {
      type: "object",
      required: ["ok", "data", "requestId"],
      properties: {
        ok: { type: "boolean", enum: [true] },
        data: archiveData,
        requestId: { type: "string" },
      },
      additionalProperties: false,
    },
  };
}

function compactResponses(operationId) {
  const success = (status, schema, description) => ({
    [status]: {
      description,
      content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
    },
  });
  const error = (description) => ({
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
  });
  if (operationId === "archiveAndResetWorld") {
    return {
      ...success(202, "ArchiveResetEnvelope", "Workflow accepted or safely resumed; poll status until nextAction changes."),
      400: error("Invalid confirmation, WORLD_ID, or operationKey"),
      401: error("Invalid or missing API key"),
      409: error("The current world state conflicts with this operation"),
      423: error("Another archive-and-reset operation owns the world lock"),
      503: error("The durable Workflow binding is unavailable"),
      500: error("Gateway, Worker, or upstream service error"),
    };
  }
  if (operationId === "getArchiveAndResetStatus") {
    return {
      ...success(200, "ArchiveResetEnvelope", "Current durable archive-and-reset status"),
      400: error("Invalid WORLD_ID or operationKey"),
      401: error("Invalid or missing API key"),
      404: error("No workflow exists for the supplied original operationKey"),
      503: error("The durable Workflow binding is unavailable"),
      500: error("Gateway, Worker, or upstream service error"),
    };
  }
  if (operationId === "initializeWorld") {
    return {
      ...success(200, "InitializeWorldEnvelope", "Confirmed character and world initialized"),
      400: error("Invalid or incomplete character initialization request"),
      401: error("Invalid or missing API key"),
      409: error("Fixed pages are not safely EMPTY/PENDING or another world is active"),
      423: error("Archive-and-reset still owns the world lock"),
      503: error("A required durable dependency is unavailable"),
      500: error("Gateway, Worker, or upstream service error"),
    };
  }
  if (operationId === "updateWorldState") {
    return {
      ...success(200, "UpdateWorldEnvelope", "Incremental ACTIVE-world update committed or replayed idempotently"),
      400: error("Invalid or empty incremental update"),
      401: error("Invalid or missing API key"),
      409: error("WORLD_ID, state, revision, or block precondition conflict"),
      423: error("Archive-and-reset currently locks world writes"),
      503: error("A required dependency is unavailable"),
      500: error("Gateway, Worker, or upstream service error"),
    };
  }
  return {
    ...success(200, "ReadEnvelope", "Bounded read completed"),
    400: error("Invalid page identifier or pagination input"),
    401: error("Invalid or missing API key"),
    404: error("Requested page or block was not found"),
    422: error("The requested read exceeded a safety boundary"),
    500: error("Gateway, Worker, or upstream service error"),
  };
}

export function buildCompactGptActionSpec(origin) {
  const apiKey = [{ apiKey: [] }];
  const paths = {};
  for (const [path, method, operationId, protectedRoute] of GPT_ACTION_PATHS) {
    const copy = GPT_ACTION_COPY[operationId];
    paths[path] = {
      [method]: {
        operationId,
        summary: copy.summary,
        description: copy.description,
        ...(protectedRoute ? { security: apiKey } : {}),
        ...(method === "get" ? { parameters: compactParameters(operationId) } : {}),
        ...(method === "post" ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: compactRequestSchema(operationId),
              },
            },
          },
        } : {}),
        responses: compactResponses(operationId),
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Xuanche Engine GPT Action",
      version: GATEWAY_VERSION,
      description: "Safety-scoped FAST_TURN_V1 Custom GPT manifest. Notion remains authoritative; page-cached profile loads and batched world updates minimize sequential action calls.",
    },
    servers: [{ url: origin }],
    components: {
      schemas: compactResponseSchemas(),
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
    },
    paths,
  };
}

function privacyResponse(method) {
  const headers = corsHeaders(new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  }));
  return new Response(method === "HEAD" ? null : PRIVACY_POLICY_HTML, { status: 200, headers });
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

async function safeWorldBackendReady(context, minimumVersion) {
  const response = await fetchUpstream(
    context,
    new Request("https://xuanche-engine.internal/health"),
  );
  if (!response.ok) return false;
  const payload = await response.json().catch(() => ({}));
  return versionAtLeast(payload?.version, minimumVersion);
}

export async function onRequest(context) {
  const request = context.request;
  const incoming = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (
    (request.method === "GET" || request.method === "HEAD") &&
    ["/privacy", "/privacy/", "/privacy.html"].includes(incoming.pathname)
  ) {
    return privacyResponse(request.method);
  }

  if (request.method === "GET" && incoming.pathname === "/gpt-action-openapi.json") {
    return jsonResponse(buildCompactGptActionSpec(incoming.origin));
  }

  const minimumWorldVersion = ["/world/archive-reset", "/world/archive-reset/status"].includes(incoming.pathname)
    ? "0.5.16"
    : incoming.pathname === "/world/initialize"
      ? "0.5.7"
      : ["/load", "/world/load", "/world/update"].includes(incoming.pathname)
        ? "0.5.17"
        : null;
  if (
    minimumWorldVersion &&
    !(await safeWorldBackendReady(context, minimumWorldVersion))
  ) {
    return jsonResponse({
      ok: false,
      error: "The bound Xuanche Worker must be deployed at version " + minimumWorldVersion + " or newer before this world operation is enabled.",
    }, 503);
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
        ? String(integerParam(
          incoming.searchParams.get("maxNodes"),
          DEFAULT_PAGE_NODES,
          1,
          MAX_PAGE_NODES,
        ))
        : incoming.searchParams.get("limit"),
      maxChars: incoming.searchParams.get("maxChars"),
      pageBatch: incoming.pathname === "/page",
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
