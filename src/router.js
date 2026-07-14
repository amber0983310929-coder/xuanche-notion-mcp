import { buildOpenApi } from "./openapi.js";
import { GitHubClient } from "./github.js";
import { loadWorld } from "./loader.js";
import { NotionClient } from "./notion.js";
import { updateWorld } from "./updater.js";
import {
  ApiError,
  clampInteger,
  corsHeaders,
  errorJson,
  json,
  normalizeNotionId,
  readJson,
  requestId,
  requireApiKey,
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
          version: "0.3.0",
          endpoints: ["/health", "/home", "/tree", "/world/load", "/world/update", "/openapi.json"],
        });
      }

      if (request.method === "GET" && url.pathname === "/openapi.json") {
        return json(buildOpenApi(request.url));
      }

      if (request.method === "GET" && url.pathname === "/health") {
        const result = {
          ok: true,
          service: "xuanche-engine",
          version: "0.3.0",
          integrations: {
            notion: notion.configured ? "configured" : "missing",
            github: github.configured ? "configured" : "missing",
            kv: env.XUANCHE_CACHE ? "configured" : "memory-fallback",
          },
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
        const homeId = env.NOTION_HOME_PAGE_ID || env.HOME_PAGE_ID;
        if (!homeId) throw new ApiError(503, "HOME_PAGE_ID or NOTION_HOME_PAGE_ID is not configured");
        const depth = clampInteger(url.searchParams.get("depth"), 0, 0, 20);
        const data = depth > 0
          ? await notion.getPageTree(homeId, { maxDepth: depth, maxNodes: clampInteger(url.searchParams.get("maxNodes"), 5_000, 1, 20_000) })
          : await notion.listBlockChildren(homeId);
        return json({ ok: true, data, requestId: id });
      }

      if (request.method === "GET" && url.pathname === "/tree") {
        const pageId = url.searchParams.get("pageId") || env.NOTION_HOME_PAGE_ID || env.HOME_PAGE_ID;
        if (!pageId) throw new ApiError(400, "pageId is required when no home page is configured");
        const data = await notion.getPageTree(pageId, {
          maxDepth: clampInteger(url.searchParams.get("depth"), 6, 0, 20),
          maxNodes: clampInteger(url.searchParams.get("maxNodes"), 5_000, 1, 20_000),
          concurrency: clampInteger(url.searchParams.get("concurrency"), 3, 1, 8),
        });
        return json({ ok: true, data, requestId: id });
      }

      if ((request.method === "POST" && ["/load", "/world/load"].includes(url.pathname))) {
        requireApiKey(request, env);
        const body = await readJson(request);
        const data = await loadWorld(env, {
          notion,
          github,
          refresh: body.refresh !== false,
          persist: body.persist === true,
          profile: body.profile,
          pageKeys: body.pageKeys,
          maxDepth: clampInteger(body.maxDepth, undefined, 0, 20),
          maxNodes: clampInteger(body.maxNodes, undefined, 1, 20_000),
          cache: dependencies.cache,
        });
        return json({ ok: true, data, requestId: id });
      }

      if (request.method === "POST" && url.pathname === "/notion/pages") {
        requireApiKey(request, env);
        const body = await readJson(request);
        const data = await notion.createChildPage(body.parentPageId, body);
        return json({ ok: true, data, requestId: id }, 201);
      }

      const blockChildren = url.pathname.match(/^\/notion\/blocks\/([^/]+)\/children$/);
      if (request.method === "POST" && blockChildren) {
        requireApiKey(request, env);
        const body = await readJson(request);
        const data = await notion.appendBlocks(decodeURIComponent(blockChildren[1]), body.children, body.after);
        return json({ ok: true, data, requestId: id });
      }

      const notionPage = url.pathname.match(/^\/notion\/pages\/([^/]+)$/);
      if (request.method === "PATCH" && notionPage) {
        requireApiKey(request, env);
        const body = await readJson(request);
        const data = await notion.updatePage(decodeURIComponent(notionPage[1]), body);
        return json({ ok: true, data, requestId: id });
      }

      if (request.method === "POST" && url.pathname === "/world/update") {
        requireApiKey(request, env);
        const body = await readJson(request);
        const data = await updateWorld(env, body, { notion, github, cache: dependencies.cache });
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
        const pageId = normalizeNotionId(decodeURIComponent(url.pathname.slice(6)));
        const data = await notion.getPageTree(pageId, {
          maxDepth: clampInteger(url.searchParams.get("depth"), 6, 0, 20),
          maxNodes: clampInteger(url.searchParams.get("maxNodes"), 5_000, 1, 20_000),
        });
        return json({ ok: true, data, requestId: id });
      }

      if (request.method === "GET" && url.pathname === "/page") {
        const pageId = url.searchParams.get("id");
        if (!pageId) throw new ApiError(400, "missing id");
        const depth = clampInteger(url.searchParams.get("depth"), 0, 0, 20);
        const data = depth > 0
          ? await notion.getPageTree(pageId, {
            maxDepth: depth,
            maxNodes: clampInteger(url.searchParams.get("maxNodes"), 5_000, 1, 20_000),
          })
          : await notion.listBlockChildren(pageId);
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
