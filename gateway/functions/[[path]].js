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
const GATEWAY_VERSION = "0.5.12";

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
  ["/health", "get", "getEngineHealth", false],
  ["/tree", "get", "getNotionTree", true],
  ["/page", "get", "getNotionPage", true],
  ["/world/initialize", "post", "initializeWorld", true],
  ["/world/archive-reset", "post", "archiveAndResetWorld", true],
  ["/world/archive-reset/status", "get", "getArchiveAndResetStatus", true],
  ["/world/load", "post", "loadWorldProfile", true],
  ["/world/update", "post", "updateWorldState", true],
  ["/github/tree", "get", "listGitHubWorldTree", true],
  ["/github/file", "get", "getGitHubWorldFile", true],
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
  const archiveResetReady = versionAtLeast(backendVersion, "0.5.14");
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
    loadWorld.description = "World profile reads are fixed to depth 0. Use the bounded authoritative turn_core after each player reply, then add exactly one action-specific TURN_PRELOAD_V1 profile. turn_core is intentionally capped to prevent a truncated response from disabling normal saves.";
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
    updateWorld.description = "Only fixed 02–09, 11, and 31 page IDs are writable. Every call must include expected world identity and a unique SAVE_KEY.";
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
  if (operationId === "archiveAndResetWorld") {
    return {
      type: "object",
      required: ["confirmation", "expectedWorldId", "operationKey"],
      properties: {
        confirmation: { type: "string", enum: ["ARCHIVE_AND_RESET"] },
        expectedWorldId: { type: "string", pattern: "^W\\d{8}-[0-9A-F]{8}$" },
        operationKey: { type: "string", minLength: 8, maxLength: 120, pattern: "^[A-Za-z0-9._-]+$" },
      },
      additionalProperties: false,
    };
  }
  if (operationId === "loadWorldProfile") {
    return {
      type: "object",
      properties: {
        profile: { type: "string" },
        refresh: { type: "boolean" },
        persist: { type: "boolean" },
        maxDepth: { type: "integer", enum: [0] },
        maxNodes: { type: "integer", minimum: 1, maximum: 20000 },
      },
      additionalProperties: false,
    };
  }
  if (operationId === "initializeWorld") {
    return {
      type: "object",
      required: ["saveKey", "character"],
      properties: {
        saveKey: { type: "string", minLength: 1, maxLength: 200 },
        character: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1 },
            gender: { type: "string" },
            age: { oneOf: [{ type: "integer", minimum: 0 }, { type: "string" }] },
            appearance: { type: "string" },
            personality: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
            background: { type: "string" },
            motivation: { type: "string" },
            bottomLine: { type: "string" },
            relationships: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
        opening: {
          type: "object",
          properties: {
            location: { type: "string" }, time: { type: "string" }, premise: { type: "string" },
            visibleClue: { type: "string" }, hiddenOrigin: { type: "string" }, directorNotes: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    };
  }
  if (operationId === "updateWorldState") {
    return {
      type: "object",
      required: ["pageId", "saveKey", "expectedWorldId", "expectedWorldState"],
      properties: {
        pageId: { type: "string" }, saveKey: { type: "string", minLength: 1, maxLength: 200 },
        expectedWorldId: { type: "string", minLength: 1 },
        expectedWorldState: { type: "string", enum: ["EMPTY", "ACTIVE", "WORLD_CONFLICT"] },
        expectedRevision: { type: "integer", minimum: 0 },
        children: {
          type: "array", minItems: 1, maxItems: 99,
          items: {
            type: "object",
            properties: { type: { type: "string" }, text: { type: "string" }, checked: { type: "boolean" } },
            additionalProperties: false,
          },
        },
        memoryEvent: { type: "string" }, cachePatch: { type: "object", properties: {}, additionalProperties: true },
        commitMessage: { type: "string", maxLength: 256 },
      },
      additionalProperties: false,
    };
  }
  return { type: "object", properties: {}, additionalProperties: true };
}

function compactParameters(operationId) {
  if (operationId === "getEngineHealth") {
    return [{ name: "deep", in: "query", schema: { type: "integer", enum: [0, 1], default: 0 } }];
  }
  if (operationId === "getNotionTree") {
    return [
      { name: "pageId", in: "query", schema: { type: "string" } },
      { name: "depth", in: "query", schema: { type: "integer", enum: [0], default: 0 } },
      { name: "maxNodes", in: "query", schema: { type: "integer", minimum: 1, maximum: 250, default: 60 } },
      { name: "cursor", in: "query", schema: { type: "string" } },
    ];
  }
  if (operationId === "getNotionPage") {
    return [
      { name: "id", in: "query", required: true, schema: { type: "string" } },
      { name: "depth", in: "query", schema: { type: "integer", enum: [0], default: 0 } },
      { name: "maxNodes", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 10 } },
      { name: "cursor", in: "query", schema: { type: "string" } },
    ];
  }
  if (operationId === "getArchiveAndResetStatus") {
    return [
      { name: "expectedWorldId", in: "query", required: true, schema: { type: "string", pattern: "^W\\d{8}-[0-9A-F]{8}$" } },
      { name: "operationKey", in: "query", required: true, schema: { type: "string", minLength: 8, maxLength: 120, pattern: "^[A-Za-z0-9._-]+$" } },
    ];
  }
  if (operationId === "listGitHubWorldTree") {
    return [{ name: "ref", in: "query", schema: { type: "string", default: "main" } }];
  }
  if (operationId === "getGitHubWorldFile") {
    return [
      { name: "path", in: "query", required: true, schema: { type: "string" } },
      { name: "ref", in: "query", schema: { type: "string", default: "main" } },
    ];
  }
  return [];
}

export function buildCompactGptActionSpec(origin) {
  const apiKey = [{ apiKey: [] }];
  const paths = {};
  for (const [path, method, operationId, protectedRoute] of GPT_ACTION_PATHS) {
    paths[path] = {
      [method]: {
        operationId,
        summary: operationId,
        ...(operationId === "archiveAndResetWorld" ? {
          description: "Start a durable archive-and-reset Workflow. It returns ARCHIVING quickly; use getArchiveAndResetStatus before creating a new world.",
        } : {}),
        ...(operationId === "getArchiveAndResetStatus" ? {
          description: "Read the durable archive-and-reset result. Proceed only when reset is true and worldState is EMPTY.",
        } : {}),
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
        responses: {
          200: {
            description: "Successful response",
            content: { "application/json": { schema: { type: "object", properties: {}, additionalProperties: true } } },
          },
          400: { description: "Invalid request" },
          401: { description: "Invalid or missing API key" },
          409: { description: "World state conflict" },
          500: { description: "Service error" },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Xuanche Engine GPT Action",
      version: GATEWAY_VERSION,
      description: "Compact compatibility manifest for the Xuanche Engine Gateway.",
    },
    servers: [{ url: origin }],
    components: {
      schemas: {},
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

  const minimumWorldVersion = incoming.pathname === "/world/initialize"
    ? "0.5.7"
    : ["/load", "/world/load", "/world/update"].includes(incoming.pathname)
      ? "0.5.6"
      : null;
  if (
    request.method === "POST" &&
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
