import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WORLD_CONFIG, loadWorld, resolveWorldConfig, selectWorldPages, worldCacheKey } from "../src/loader.js";

function worldMarkers(worldState = "EMPTY", worldId = "PENDING") {
  return [
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "WORLD_STATE：" + worldState }] } },
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "WORLD_ID：" + worldId }] } },
  ];
}

test("continue profile follows the active-world core route", () => {
  const pages = selectWorldPages(DEFAULT_WORLD_CONFIG, "continue");
  assert.deepEqual(pages.map((page) => page.key), [
    "home", "route", "rules", "save", "character", "timeline", "knowledge", "relationships",
    "causality", "clues", "events", "director", "flow", "npc", "protagonist", "world",
    "hud", "persistence", "factions"
  ]);
});

test("new_game profile loads only the fixed character-creation route", () => {
  const pages = selectWorldPages(DEFAULT_WORLD_CONFIG, "new_game");
  assert.deepEqual(pages.map((page) => page.key), ["home", "route", "rules", "character_template"]);
});

test("profiles accept deduplicated extra modules", () => {
  const pages = selectWorldPages(DEFAULT_WORLD_CONFIG, "continue", ["equipment", "economy", "hud"]);
  assert.equal(pages.filter((page) => page.key === "hud").length, 1);
  assert.deepEqual(pages.slice(-2).map((page) => page.key), ["equipment", "economy"]);
});

test("full profile includes the complete current 00-32 catalog", () => {
  const pages = selectWorldPages(DEFAULT_WORLD_CONFIG, "full");
  assert.equal(pages.length, 40);
  for (const key of ["knowledge", "relationships", "causality", "clues", "events", "director", "narrative", "experience", "character_template"]) {
    assert.equal(pages.some((page) => page.key === key), true);
  }
});

test("unknown profiles fail with available choices", () => {
  assert.throws(() => selectWorldPages(DEFAULT_WORLD_CONFIG, "missing"), /Unknown world load profile/);
});

test("world loader keeps the home page shallow and bounds selected modules to one nested level", async () => {
  const depths = new Map();
  const notion = {
    configured: true,
    async getPageTree(id, options) {
      depths.set(id, options.maxDepth);
      return { page: { id }, children: worldMarkers(), meta: { nodeCount: 2, maxDepth: options.maxDepth } };
    }
  };
  const result = await loadWorld({}, {
    notion,
    github: { configured: false },
    cache: { put: async () => undefined },
    profile: "base",
    refresh: true,
    persist: false,
    maxDepth: 4,
    maxNodes: 100
  });
  const home = result.pages.find((page) => page.key === "home");
  const rules = result.pages.find((page) => page.key === "rules");
  assert.equal(depths.get(home.page.id), 0);
  assert.equal(depths.get(rules.page.id), 1);
  assert.equal(result.meta.pageCount, 6);
  assert.equal(result.meta.world.worldState, "EMPTY");
  assert.equal(result.meta.world.worldId, "PENDING");
});

test("current-state catalog points at the fixed clean-slate pages", () => {
  const byKey = new Map(DEFAULT_WORLD_CONFIG.catalog.map((page) => [page.key, page.id]));
  assert.equal(byKey.get("save"), "39fc845007ae81f295ecef235d229ff2");
  assert.equal(byKey.get("character"), "39fc845007ae81f2a723dca974a8342a");
  assert.equal(byKey.get("timeline"), "39fc845007ae8193a691e96f0323561c");
  assert.equal(byKey.get("knowledge"), "3a0c845007ae81518960f13469012b3b");
  assert.equal(byKey.get("director"), "3a0c845007ae81888deaff5b06b6a168");
  assert.equal(byKey.get("character_template"), "3a0c845007ae81bb9b11e29e0b10e7d7");
});

test("legacy 02/03/04 page identities are absent", () => {
  const ids = new Set(DEFAULT_WORLD_CONFIG.catalog.map((page) => page.id));
  for (const legacyId of [
    "39ec845007ae819e90a7f675f42acb08",
    "39ec845007ae81399d4ede3a1863497a",
    "39ec845007ae818585e7ef27954f563f"
  ]) assert.equal(ids.has(legacyId), false);
});

test("stale remote world configs cannot override the current fixed mapping", async () => {
  const github = {
    configured: true,
    async getJson() {
      return { data: { version: 4, catalog: [{ key: "save", title: "legacy", id: "39ec845007ae819e90a7f675f42acb08" }] } };
    }
  };
  const config = await resolveWorldConfig({}, github);
  const save = config.catalog.find((page) => page.key === "save");
  assert.equal(save.id, "39fc8450-07ae-81f2-95ec-ef235d229ff2");
});

test("same-version conflicting fixed mappings fail closed", async () => {
  const badCatalog = DEFAULT_WORLD_CONFIG.catalog.map((page) => page.key === "save"
    ? { ...page, id: "39ec845007ae819e90a7f675f42acb08" }
    : page);
  const github = { configured: true, async getJson() { return { data: { ...DEFAULT_WORLD_CONFIG, catalog: badCatalog } }; } };
  await assert.rejects(resolveWorldConfig({}, github), /does not match the current fixed Notion page mapping/);
});

test("duplicate keys with different page identities fail closed", async () => {
  const github = {
    configured: true,
    async getJson() {
      return { data: { ...DEFAULT_WORLD_CONFIG, catalog: [...DEFAULT_WORLD_CONFIG.catalog, { key: "save", title: "duplicate", id: "11111111111111111111111111111111" }] } };
    }
  };
  await assert.rejects(resolveWorldConfig({}, github), /Conflicting Notion page mapping/);
});

test("cache keys change when configured page identities or schema versions change", () => {
  const first = [{ key: "save", id: "11111111111111111111111111111111" }];
  const second = [{ key: "save", id: "22222222222222222222222222222222" }];
  assert.notEqual(worldCacheKey("continue", first, 6, 5000, 0, 5), worldCacheKey("continue", second, 6, 5000, 0, 5));
  assert.notEqual(worldCacheKey("continue", first, 6, 5000, 0, 4), worldCacheKey("continue", first, 6, 5000, 0, 5));
});

test("world loader rejects archived configured pages", async () => {
  const notion = { configured: true, async getPageTree(id) { return { page: { id, archived: true }, children: [], meta: { nodeCount: 0 } }; } };
  await assert.rejects(loadWorld({}, {
    notion,
    github: { configured: false },
    cache: { put: async () => undefined },
    profile: "base",
    refresh: true,
    persist: false,
    maxDepth: 0,
    maxNodes: 100
  }), /archived or in trash/);
});

test("world loader rejects mixed world identities before returning a snapshot", async () => {
  const timelineId = DEFAULT_WORLD_CONFIG.catalog.find((page) => page.key === "timeline").id;
  const notion = {
    configured: true,
    async getPageTree(id, options) {
      const children = id.replaceAll("-", "") === timelineId.replaceAll("-", "")
        ? worldMarkers("ACTIVE", "OTHER-WORLD")
        : worldMarkers();
      return { page: { id }, children, meta: { nodeCount: 2, maxDepth: options.maxDepth } };
    },
  };
  await assert.rejects(loadWorld({}, {
    notion,
    github: { configured: false },
    cache: { put: async () => undefined },
    profile: "base",
    refresh: true,
    persist: false,
  }), /mixed save identities/);
});

test("a KV cache hit can still be persisted to GitHub", async () => {
  const cached = { loadedAt: "2026-07-14T00:00:00.000Z", config: { profile: "base" }, pages: [], meta: { cache: "miss", pageCount: 0, nodeCount: 0 } };
  const writes = [];
  const github = {
    configured: true,
    async getJson() { return undefined; },
    async putJson(path, value) { writes.push({ path, value }); return { commit: { sha: "persisted-sha" } }; }
  };
  const result = await loadWorld({}, {
    notion: { configured: true, async getPageTree() { throw new Error("Notion should not be read on a cache hit"); } },
    github,
    cache: { get: async () => cached },
    profile: "base",
    refresh: false,
    persist: true,
    maxDepth: 0,
    maxNodes: 100
  });
  assert.equal(result.meta.cache, "hit");
  assert.equal(result.meta.githubCommit, "persisted-sha");
  assert.equal(writes[0].path, "world/cache.json");
});
