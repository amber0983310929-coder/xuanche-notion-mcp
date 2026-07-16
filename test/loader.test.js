import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WORLD_CONFIG, loadWorld, selectWorldPages, worldCacheKey } from "../src/loader.js";

test("continue profile selects active state, cultivation, and enforcement modules", () => {
  const pages = selectWorldPages(DEFAULT_WORLD_CONFIG, "continue");
  assert.deepEqual(pages.map((page) => page.key), [
    "home", "route", "rules", "save", "character", "timeline",
    "flow", "cultivation", "skills", "npc", "protagonist", "world", "hud", "persistence",
  ]);
});

test("profiles accept deduplicated extra modules", () => {
  const pages = selectWorldPages(DEFAULT_WORLD_CONFIG, "continue", ["equipment", "economy", "hud"]);
  assert.equal(pages.filter((page) => page.key === "hud").length, 1);
  assert.deepEqual(pages.slice(-2).map((page) => page.key), ["equipment", "economy"]);
});

test("full profile includes only active current-state and 00/01/12-29 pages", () => {
  const pages = selectWorldPages(DEFAULT_WORLD_CONFIG, "full");
  assert.equal(pages.length, 24);
  assert.equal(pages.some((page) => ["knowledge", "reputation", "karma", "foreshadowing", "events", "changelog", "director", "wiki"].includes(page.key)), false);
});

test("unknown profiles fail with available choices", () => {
  assert.throws(() => selectWorldPages(DEFAULT_WORLD_CONFIG, "missing"), /Unknown world load profile/);
});

test("world loader keeps the home page shallow while loading selected modules deeply", async () => {
  const depths = new Map();
  const notion = {
    configured: true,
    async getPageTree(id, options) {
      depths.set(id, options.maxDepth);
      return { page: { id }, children: [], meta: { nodeCount: 0, maxDepth: options.maxDepth } };
    },
  };
  const cache = { put: async () => undefined };
  const github = { configured: false };

  const result = await loadWorld({}, {
    notion,
    github,
    cache,
    profile: "base",
    refresh: true,
    persist: false,
    maxDepth: 4,
    maxNodes: 100,
  });

  const home = result.pages.find((page) => page.key === "home");
  const rules = result.pages.find((page) => page.key === "rules");
  assert.equal(depths.get(home.page.id), 0);
  assert.equal(depths.get(rules.page.id), 4);
  assert.equal(result.meta.pageCount, 7);
});

test("current-state catalog points at the active 02/03/04 pages", () => {
  const byKey = new Map(DEFAULT_WORLD_CONFIG.catalog.map((page) => [page.key, page.id]));
  assert.equal(byKey.get("save"), "39ec845007ae819e90a7f675f42acb08");
  assert.equal(byKey.get("character"), "39ec845007ae81399d4ede3a1863497a");
  assert.equal(byKey.get("timeline"), "39ec845007ae818585e7ef27954f563f");
});

test("cache keys change when configured page identities change", () => {
  const first = [{ key: "save", id: "11111111111111111111111111111111" }];
  const second = [{ key: "save", id: "22222222222222222222222222222222" }];
  assert.notEqual(worldCacheKey("continue", first, 6, 5000, 0, 4), worldCacheKey("continue", second, 6, 5000, 0, 4));
});

test("world loader rejects archived configured pages", async () => {
  const notion = {
    configured: true,
    async getPageTree(id) {
      return { page: { id, archived: true }, children: [], meta: { nodeCount: 0 } };
    },
  };

  await assert.rejects(
    loadWorld({}, {
      notion,
      github: { configured: false },
      cache: { put: async () => undefined },
      profile: "base",
      refresh: true,
      persist: false,
      maxDepth: 0,
      maxNodes: 100,
    }),
    /archived or in trash/,
  );
});

test("a KV cache hit can still be persisted to GitHub", async () => {
  const cached = {
    loadedAt: "2026-07-14T00:00:00.000Z",
    config: { profile: "base" },
    pages: [],
    meta: { cache: "miss", pageCount: 0, nodeCount: 0 },
  };
  const writes = [];
  const github = {
    configured: true,
    async getJson() {
      return undefined;
    },
    async putJson(path, value) {
      writes.push({ path, value });
      return { commit: { sha: "persisted-sha" } };
    },
  };
  const notion = {
    configured: true,
    async getPageTree() {
      throw new Error("Notion should not be read on a cache hit");
    },
  };
  const cache = { get: async () => cached };

  const result = await loadWorld({}, {
    notion,
    github,
    cache,
    profile: "base",
    refresh: false,
    persist: true,
    maxDepth: 0,
    maxNodes: 100,
  });

  assert.equal(result.meta.cache, "hit");
  assert.equal(result.meta.githubCommit, "persisted-sha");
  assert.equal(writes[0].path, "world/cache.json");
});
