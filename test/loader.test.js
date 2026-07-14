import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WORLD_CONFIG, loadWorld, selectWorldPages } from "../src/loader.js";

test("continue profile selects only the core narrative modules", () => {
  const pages = selectWorldPages(DEFAULT_WORLD_CONFIG, "continue");
  assert.deepEqual(pages.map((page) => page.key), [
    "home", "route", "rules", "save", "timeline",
    "flow", "npc", "protagonist", "world", "hud",
  ]);
});

test("profiles accept deduplicated extra modules", () => {
  const pages = selectWorldPages(DEFAULT_WORLD_CONFIG, "continue", ["equipment", "economy", "hud"]);
  assert.equal(pages.filter((page) => page.key === "hud").length, 1);
  assert.deepEqual(pages.slice(-2).map((page) => page.key), ["equipment", "economy"]);
});

test("full profile includes the complete home plus 00-29 catalog", () => {
  const pages = selectWorldPages(DEFAULT_WORLD_CONFIG, "full");
  assert.equal(pages.length, 31);
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
  assert.equal(result.meta.pageCount, 5);
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
