import { buildOpenApi } from "./openapi.js";
import { GitHubClient } from "./github.js";
import {
  archiveAndResetWorld,
  archiveResetWorkflowId,
  validateArchiveResetInput,
} from "./archive-reset.js";
import { CacheStore } from "./cache.js";
import { ACTIVE_RESET_LOCK, getActiveReset } from "./reset-lock.js";
import { initializeWorld } from "./initializer.js";
import { loadWorld } from "./loader.js";
import { NotionClient } from "./notion.js";
import { updateWorld } from "./updater.js";
import { WORLD_PAGE_IDS, parseWorldMarkers } from "./world-state.js";
import {
  ApiError,
  clampInteger,
  corsHeaders,
  errorJson,
  json,
  normalizeNotionId,
  readJson,
  readsRequireApiKey,
  requestId,
  requireApiKey,
  requireReadApiKey,
} from "./utils.js";

export function createRouter(dependencies = {}) {
  return async function route(request, env = {}, ctx = {}) {
    const id = requestId(request);
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
      const url = new URL(request.url);
      const notion = dependencies.notion || new NotionClient(env, dependencies.fetchImpl || fetch);
      const github = dependencies.github || new GitHubClient(env, dependencies.fetchImpl || fetch);

      if (request.method === "GET" && url.pathname === "/") {
        return json({
          ok: true,
          service: "xuanche-engine",
          version: "0.5.17",
          protectedReads: readsRequireApiKey(env),
          endpoints: ["/health", "/home", "/tree", "/world/initialize", "/world/load", "/world/update", "/world/archive-reset", "/world/archive-reset/status", "/openapi.json"],
        });
      }

      if (request.method === "GET" && url.pathname === "/openapi.json") {
        return json(buildOpenApi(request.url));
      }

      if (request.method === "GET" && url.pathname === "/health") {
        const result = {
          ok: true,
          service: "xuanche-engine",
          version: "0.5.17",
          integrations: {
            notion: notion.configured ? "configured" : "missing",
            github: github.configured ? "configured" : "missing",
            kv: env.XUANCHE_CACHE ? "configured" : "memory-fallback",
          },
          capabilities: {
            shallowPageBatchSizing: true,
            saveSchema: "SAVE_V3.2",
            dynamicTurnPreload: "TURN_PRELOAD_V1",
            fastTurnRuntime: "FAST_TURN_V1",
            pageGranularCache: true,
            batchedWorldUpdates: true,
            activeCastDialoguePreload: "NPC_LIVE_PRELOAD_V1",
            idempotentWorldUpdates: true,
            fixedWorldWriteAllowlist: true,
            atomicWorldInitialization: true,
            verifiedWorldArchiveAndReset: true,
            durableArchiveReset: Boolean(env.WORLD_RESET_WORKFLOW?.createBatch),
          },
          protectedReads: readsRequireApiKey(env),
          requestId: id,
        };
        if (url.searchParams.get("deep") === "1") {
          requireApiKey(request, env);
          const checks = [];
          const homeId = env.NOTION_HOME_PAGE_ID || env.HOME_PAGE_ID;
          if (notion.configured && homeId) checks.push(notion.getPage(homeId));
          if (github.configured) checks.push(github.getRepository());
          await Promise.all(checks);
          result.deepCheck = "passed";
        }
        return json(result);
      }

      if (request.method === "GET" && url.pathname === "/home") {
        requireReadApiKey(request, env);
        const homeId = env.NOTION_HOME_PAGE_ID || env.HOME_PAGE_ID;
        if (!homeId) throw new ApiError(503, "HOME_PAGE_ID or NOTION_HOME_PAGE_ID is not configured");
        const depth = clampInteger(url.searchParams.get("depth"), 0, 0, 1);
        const cursor = url.searchParams.get("cursor");
        const data = depth > 0
          ? await notion.getPageTree(homeId, { maxDepth: depth, maxNodes: clampInteger(url.searchParams.get("maxNodes"), 5_000, 1, 20_000) })
          : await notion.listBlockChildren(homeId, {
            startCursor: cursor,
            pageSize: clampInteger(url.searchParams.get("maxNodes"), 100, 1, 100),
          });
        return json({ ok: true, data, requestId: id });
      }

      if (request.method === "GET" && url.pathname === "/tree") {
        requireReadApiKey(request, env);
        const pageId = url.searchParams.get("pageId") || env.NOTION_HOME_PAGE_ID || env.HOME_PAGE_ID;
        if (!pageId) throw new ApiError(400, "pageId is required when no home page is configured");
        const data = await notion.getPageTree(pageId, {
          maxDepth: clampInteger(url.searchParams.get("depth"), 0, 0, 1),
          maxNodes: clampInteger(url.searchParams.get("maxNodes"), 5_000, 1, 20_000),
          concurrency: clampInteger(url.searchParams.get("concurrency"), 3, 1, 8),
        });
        return json({ ok: true, data, requestId: id });
      }

      if ((request.method === "POST" && ["/load", "/world/load"].includes(url.pathname))) {
        requireApiKey(request, env);
        const body = await readJson(request);
        const startedAt = Date.now();
        const data = await loadWorld(env, {
          notion,
          github,
          refresh: body.refresh === true,
          persist: body.persist === true,
          profile: body.profile,
          pageKeys: body.pageKeys,
          maxDepth: clampInteger(body.maxDepth, 0, 0, 0),
          maxNodes: clampInteger(body.maxNodes, undefined, 1, 20_000),
          cache: dependencies.cache,
        });
        console.log("xuanche_profile_loaded", {
          requestId: id,
          profile: body.profile || "continue",
          cache: data.meta?.cache,
          cacheHits: data.meta?.cacheHits,
          cacheMisses: data.meta?.cacheMisses,
          durationMs: Date.now() - startedAt,
        });
        return json({ ok: true, data, requestId: id });
      }

      if (env.ALLOW_RAW_NOTION_WRITES === "true" && request.method === "POST" && url.pathname === "/notion/pages") {
        requireApiKey(request, env);
        const body = await readJson(request);
        const data = await notion.createChildPage(body.parentPageId, body);
        return json({ ok: true, data, requestId: id }, 201);
      }

      const blockChildren = url.pathname.match(/^\/notion\/blocks\/([^/]+)\/children$/);
      if (env.ALLOW_RAW_NOTION_WRITES === "true" && request.method === "POST" && blockChildren) {
        requireApiKey(request, env);
        const body = await readJson(request);
        const data = await notion.appendBlocks(decodeURIComponent(blockChildren[1]), body.children, body.after);
        return json({ ok: true, data, requestId: id });
      }

      const notionPage = url.pathname.match(/^\/notion\/pages\/([^/]+)$/);
      if (env.ALLOW_RAW_NOTION_WRITES === "true" && request.method === "PATCH" && notionPage) {
        requireApiKey(request, env);
        const body = await readJson(request);
        const data = await notion.updatePage(decodeURIComponent(notionPage[1]), body);
        return json({ ok: true, data, requestId: id });
      }

      if (request.method === "POST" && url.pathname === "/world/update") {
        requireApiKey(request, env);
        const body = await readJson(request);
        const startedAt = Date.now();
        const data = await updateWorld(env, body, { notion, github, cache: dependencies.cache });
        console.log("xuanche_world_updated", {
          requestId: id,
          mutationCount: Array.isArray(body.mutations) ? body.mutations.length : 1,
          idempotent: data.idempotent,
          durationMs: Date.now() - startedAt,
          timings: data.timings,
        });
        return json({ ok: true, data, requestId: id });
      }

      if (request.method === "POST" && url.pathname === "/world/initialize") {
        requireApiKey(request, env);
        const body = await readJson(request);
        const data = await initializeWorld(env, body, { notion, github, cache: dependencies.cache });
        return json({ ok: true, data, requestId: id });
      }

      if (request.method === "POST" && url.pathname === "/world/archive-reset") {
        requireApiKey(request, env);
        const body = await readJson(request);
        // Never fall back to the old synchronous implementation here. A reset
        // can legitimately outlive a GPT Action response and must therefore
        // be backed by the durable Workflow binding.
        const data = await startArchiveResetWorkflow(env, body, dependencies.cache, notion);
        return json({ ok: true, data, requestId: id }, 202);
      }

      if (request.method === "GET" && url.pathname === "/world/archive-reset/status") {
        requireApiKey(request, env);
        const input = {
          confirmation: "ARCHIVE_AND_RESET",
          expectedWorldId: url.searchParams.get("expectedWorldId"),
          operationKey: url.searchParams.get("operationKey"),
        };
        const data = await getArchiveResetWorkflowStatus(env, input);
        return json({ ok: true, data, requestId: id });
      }

      if (request.method === "GET" && url.pathname === "/github/tree") {
        requireApiKey(request, env);
        const data = await github.listTree({ ref: url.searchParams.get("ref") || github.branch });
        return json({ ok: true, data, requestId: id });
      }

      if (request.method === "GET" && url.pathname === "/github/file") {
        requireApiKey(request, env);
        const path = url.searchParams.get("path");
        const file = await github.getFile(path, { ref: url.searchParams.get("ref") || github.branch });
        return json({ ok: true, data: { path: file.path, sha: file.sha, text: file.text }, requestId: id });
      }

      if (request.method === "GET" && url.pathname.startsWith("/page/")) {
        requireReadApiKey(request, env);
        const pageId = normalizeNotionId(decodeURIComponent(url.pathname.slice(6)));
        const depth = clampInteger(url.searchParams.get("depth"), 0, 0, 1);
        const cursor = url.searchParams.get("cursor");
        const data = depth > 0
          ? await notion.getPageTree(pageId, {
            maxDepth: depth,
            maxNodes: clampInteger(url.searchParams.get("maxNodes"), 5_000, 1, 20_000),
          })
          : await notion.listBlockChildren(pageId, {
            startCursor: cursor,
            pageSize: clampInteger(url.searchParams.get("maxNodes"), 100, 1, 100),
          });
        return json({ ok: true, data, requestId: id });
      }

      if (request.method === "GET" && url.pathname === "/page") {
        requireReadApiKey(request, env);
        const pageId = url.searchParams.get("id");
        if (!pageId) throw new ApiError(400, "missing id");
        const depth = clampInteger(url.searchParams.get("depth"), 0, 0, 1);
        const cursor = url.searchParams.get("cursor");
        const data = depth > 0
          ? await notion.getPageTree(pageId, {
            maxDepth: depth,
            maxNodes: clampInteger(url.searchParams.get("maxNodes"), 5_000, 1, 20_000),
          })
          : await notion.listBlockChildren(pageId, {
            startCursor: cursor,
            pageSize: clampInteger(url.searchParams.get("maxNodes"), 100, 1, 100),
          });
        return json({ ok: true, data, requestId: id });
      }

      throw new ApiError(404, "Route not found");
    } catch (error) {
      if (!(error instanceof ApiError) || error.status >= 500) {
        console.error("xuanche_request_failed", {
          requestId: id,
          name: error?.name || "Error",
          message: error?.message || String(error),
          status: error?.status || 500,
        });
      }
      if (ctx?.waitUntil && error?.backgroundTask) ctx.waitUntil(error.backgroundTask);
      return errorJson(error, id);
    }
  };
}

async function startArchiveResetWorkflow(env, input, injectedCache, injectedNotion) {
  validateArchiveResetInput(input);
  if (!env.WORLD_RESET_WORKFLOW?.createBatch || !env.WORLD_RESET_WORKFLOW?.get) {
    throw new ApiError(503, "Durable archive workflow binding is not configured");
  }
  const cache = injectedCache || new CacheStore(env);
  const active = await getActiveReset(cache);

  // The fixed save page is authoritative.  A stale reset lock must never turn
  // an already-cleared world into a second archive job: there is no ACTIVE
  // world left to archive, and the caller should initialize its confirmed
  // character immediately instead.
  const canonical = await readCanonicalWorldState(env, injectedNotion);
  if (canonical.worldState === "EMPTY" && canonical.worldId === "PENDING") {
    if (active) await cache.delete(ACTIVE_RESET_LOCK);
    throw new ApiError(409, "No archive is required: the fixed world pages are already EMPTY/PENDING. Call initializeWorld now.", {
      worldState: "EMPTY",
      worldId: "PENDING",
      nextAction: "initializeWorld",
    });
  }

  if (active && (
    active.expectedWorldId !== input.expectedWorldId || active.operationKey !== input.operationKey
  )) {
    throw new ApiError(423, "Another archive-and-reset operation is already in progress", {
      expectedWorldId: active.expectedWorldId || null,
      operationKey: active.operationKey || null,
      phase: active.phase,
    });
  }

  let workflowId = active?.workflowId || archiveResetWorkflowId(input);
  const queuedHere = !active;
  const persistWorkflowId = async () => {
    await cache.put(ACTIVE_RESET_LOCK, {
      ...(active || {}),
      phase: active?.phase || "queued",
      expectedWorldId: input.expectedWorldId,
      operationKey: input.operationKey,
      workflowId,
      createdAt: active?.createdAt || new Date().toISOString(),
    }, 86_400);
  };
  if (queuedHere || !active?.workflowId) await persistWorkflowId();

  const submit = () => env.WORLD_RESET_WORKFLOW.createBatch([{
    id: workflowId,
    params: input,
    retention: { successRetention: "7 days", errorRetention: "14 days" },
  }]);
  try {
    await submit();
  } catch (error) {
    let existingStatus;
    try {
      existingStatus = await (await env.WORLD_RESET_WORKFLOW.get(workflowId)).status();
    } catch {
      if (queuedHere) await cache.delete(ACTIVE_RESET_LOCK);
      throw error;
    }
    // A completed or running deterministic instance is idempotent.  An errored
    // instance cannot be re-used by Cloudflare Workflows, so start a fresh
    // attempt while retaining the same archive checkpoint and operationKey.
    if (["errored", "terminated", "canceled", "cancelled"].includes(existingStatus.status)) {
      workflowId = archiveResetWorkflowId(input) + "-retry-" + crypto.randomUUID().slice(0, 8);
      await persistWorkflowId();
      await submit();
    }
  }
  const instance = await env.WORLD_RESET_WORKFLOW.get(workflowId);
  const status = await instance.status();
  return archiveWorkflowStatusPayload(input, workflowId, status);
}

async function readCanonicalWorldState(env, injectedNotion) {
  const notion = injectedNotion || new NotionClient(env);
  const tree = await notion.getPageTree(WORLD_PAGE_IDS.save, {
    maxDepth: 0,
    maxNodes: 10,
    concurrency: 1,
    includePage: false,
  });
  return parseWorldMarkers(tree.children);
}

async function getArchiveResetWorkflowStatus(env, input) {
  validateArchiveResetInput(input);
  if (!env.WORLD_RESET_WORKFLOW?.get) {
    throw new ApiError(503, "Durable archive workflow binding is not configured");
  }
  const cache = new CacheStore(env);
  const active = await getActiveReset(cache);
  const workflowId = active?.expectedWorldId === input.expectedWorldId && active?.operationKey === input.operationKey
    ? active.workflowId || archiveResetWorkflowId(input)
    : archiveResetWorkflowId(input);
  let instance;
  try {
    instance = await env.WORLD_RESET_WORKFLOW.get(workflowId);
  } catch {
    throw new ApiError(404, "No archive-and-reset workflow exists for this operationKey", { workflowId });
  }
  return archiveWorkflowStatusPayload(input, workflowId, await instance.status());
}

function archiveWorkflowStatusPayload(input, workflowId, status = {}) {
  const output = status.output && typeof status.output === "object" ? status.output : {};
  const running = ["queued", "running", "waiting", "waitingForPause", "paused"].includes(status.status);
  return {
    accepted: true,
    archiveVerified: output.archiveVerified === true,
    reset: output.reset === true,
    worldState: output.worldState || (running ? "ARCHIVING" : "UNKNOWN"),
    operationKey: input.operationKey,
    workflowId,
    workflowStatus: status.status || "unknown",
    error: status.error?.message || null,
  };
}

