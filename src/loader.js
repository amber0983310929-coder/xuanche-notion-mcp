import { CacheStore } from "./cache.js";
import { GitHubClient } from "./github.js";
import { NotionClient } from "./notion.js";
import { ApiError, mapLimit, mergeDeep, normalizeNotionId, nowIso } from "./utils.js";
import { validateLoadedWorld } from "./world-state.js";

export const DEFAULT_WORLD_CONFIG = {
  version: 10,
  homePageId: "5f4c8de4a4c246478a4658d1ebc2a1a2",
  catalog: [
    { key: "home", title: "修真世界（首頁）", id: "5f4c8de4a4c246478a4658d1ebc2a1a2" },
    { key: "route", title: "00｜AI 載入索引與路由", id: "39cc845007ae8184b97dd0e8c0122768" },
    { key: "rules", title: "01｜修真世界規則（唯一最高規則）", id: "af1900844075472583e7f30d90a9a7a7" },
    { key: "save", title: "02｜現行世界存檔", id: "39fc845007ae81f295ecef235d229ff2" },
    { key: "character", title: "03｜主角與角色資料", id: "39fc845007ae81f2a723dca974a8342a" },
    { key: "timeline", title: "04｜世界時間線", id: "39fc845007ae8193a691e96f0323561c" },
    { key: "knowledge", title: "05｜主角知識與圖鑑", id: "3a0c845007ae81518960f13469012b3b" },
    { key: "relationships", title: "06｜NPC關係與名聲", id: "3a0c845007ae81318eb6c9af267def40" },
    { key: "causality", title: "07｜因果、承諾與代價", id: "3a0c845007ae81148a7ee469dc58cf2a" },
    { key: "clues", title: "08｜伏筆與未知線索", id: "3a0c845007ae818cba00fc7ef100b7eb" },
    { key: "events", title: "09｜世界事件與勢力動向", id: "3a0c845007ae8144a64de3a6c646332c" },
    { key: "changelog", title: "10｜規則與系統更新日誌", id: "3a0c845007ae81eaa4d4c15a2f3f9b19" },
    { key: "director", title: "11｜導演筆記（AI專用）", id: "3a0c845007ae81888deaff5b06b6a168" },
    { key: "flow", title: "12｜遊戲流程與回合規則", id: "39cc845007ae81e7a357c7d4b3a5d6de" },
    { key: "npc", title: "13｜角色、NPC 與對話規則", id: "39cc845007ae811595cae2aa37672243" },
    { key: "cultivation", title: "14｜修煉、境界與極境體系", id: "39cc845007ae81439c24d6854fc3f352" },
    { key: "skills", title: "15｜功法、技能與神通體系", id: "39cc845007ae818d807ee4a9648ecd51" },
    { key: "combat", title: "16｜戰鬥、難度與公平性", id: "39cc845007ae8146ad02db524906e1b7" },
    { key: "protagonist", title: "17｜主角核心設定", id: "39cc845007ae8192917ac0f8ec708f9f" },
    { key: "world", title: "18｜世界觀、劇情與事件生成", id: "39cc845007ae81d59208f786d3303b67" },
    { key: "hud", title: "19｜HUD、狀態與資訊顯示", id: "39cc845007ae81648196e98ac7349f1d" },
    { key: "persistence", title: "20｜記憶、載入、存檔與一致性", id: "39cc845007ae8185acf5d7af416b7849" },
    { key: "equipment", title: "21｜武器、防具與法寶體系", id: "39cc845007ae8108bc7eeb1b7f4c51df" },
    { key: "creatures", title: "22｜靈獸、妖族與契約體系", id: "39cc845007ae8171a826f644731bc132" },
    { key: "crafts", title: "23｜丹藥、符籙、陣法與修真百藝", id: "39cc845007ae819aa31ecd7a59a232ac" },
    { key: "economy", title: "24｜資源、貨幣、勢力與世界經濟", id: "39cc845007ae81f39ac9c4772dfd1048" },
    { key: "regions", title: "25｜地域、氣候與文明差異", id: "39cc845007ae81e483a4cd72be050b04" },
    { key: "society", title: "26｜日常生活、社會秩序與凡人世界", id: "39cc845007ae8109bf0dec8624172612" },
    { key: "ecology", title: "27｜生態、天象、災害與環境演化", id: "39cc845007ae81d899f9dc23218de15d" },
    { key: "intelligence", title: "28｜情報、謠言、秘密與知識傳播", id: "39cc845007ae818db0a9cb19c1010689" },
    { key: "factions", title: "29｜NPC目標、派系演化與世界脈動", id: "39cc845007ae81b483e5c8a095ceb409" },
    { key: "narrative", title: "30｜玄澈多源敘事文法", id: "39fc845007ae817390d5ee71cc4ac498" },
    { key: "narrative_daily", title: "30-1｜日常、時間與成長", id: "39fc845007ae81a09225ebb826729cd9" },
    { key: "narrative_social", title: "30-2｜人物關係、情緒與對話", id: "39fc845007ae816e81dbe14636fda7dc" },
    { key: "narrative_power", title: "30-3｜利益、權力與不可兼得選擇", id: "39fc845007ae810da175ddfaf8608ba2" },
    { key: "narrative_combat", title: "30-4｜修煉、戰鬥、失敗與代價", id: "39fc845007ae817eb88ae8f8c5cf1403" },
    { key: "narrative_long", title: "30-5｜伏筆、世界運行與長線結構", id: "39fc845007ae81919641fff5423e565b" },
    { key: "originality", title: "30-6｜原創生成與禁止模仿", id: "39fc845007ae81748ed5ccd3131a30d0" },
    { key: "experience", title: "31｜敘事經驗索引", id: "39fc845007ae81eeb4fac2a18a75abd7" },
    { key: "character_template", title: "32｜角色建立與新存檔固定模板", id: "3a0c845007ae81bb9b11e29e0b10e7d7" }
  ],
  profiles: {
    base: ["home", "route", "rules", "save", "timeline", "persistence"],
    state_check: ["save", "character", "timeline", "knowledge", "relationships", "causality", "clues", "events", "director"],
    continue: ["home", "route", "rules", "save", "character", "timeline", "events", "director", "flow", "hud", "persistence"],
    new_game: ["home", "route", "rules", "character_template"],
    character_creation: ["home", "route", "rules", "character_template", "npc", "protagonist", "hud"],
    character_finalize: ["home", "route", "rules", "character_template", "npc", "protagonist", "hud", "world", "narrative_long", "originality"],
    cultivation: ["home", "route", "rules", "save", "timeline", "character", "cultivation", "skills", "protagonist", "world", "hud", "persistence", "narrative", "narrative_combat"],
    combat: ["home", "route", "rules", "save", "timeline", "character", "relationships", "causality", "events", "combat", "equipment", "hud", "persistence", "narrative", "narrative_combat"],
    npc: ["home", "route", "rules", "save", "timeline", "character", "relationships", "causality", "npc", "protagonist", "factions", "hud", "persistence", "narrative", "narrative_social", "narrative_power"],
    exploration: ["home", "route", "rules", "save", "timeline", "character", "knowledge", "clues", "events", "world", "regions", "ecology", "intelligence", "hud", "persistence", "narrative", "narrative_daily"],
    save: ["home", "route", "rules", "save", "character", "timeline", "knowledge", "relationships", "causality", "clues", "events", "director", "persistence"],
    // Per-turn state must fit safely inside a single GPT Action response.
    // Static rules and action-specific material are loaded separately; this
    // profile is deliberately limited to the authoritative live state.
    turn_core: ["save", "character", "timeline", "events", "director", "hud"],
    turn_combat: ["save", "character", "timeline", "relationships", "causality", "events", "director", "combat", "equipment", "hud", "narrative_combat"],
    // turn_core already supplies the authoritative live state. Dialogue only
    // adds the active cast's public relationships, obligations, private queue,
    // and voice rules. This avoids both duplicate payload and oversized
    // general-purpose narration pages.
    turn_dialogue: ["relationships", "causality", "director", "npc"],
    turn_exploration: ["save", "character", "timeline", "knowledge", "clues", "events", "director", "world", "regions", "ecology", "intelligence", "hud", "narrative_daily"],
    turn_cultivation: ["save", "character", "timeline", "causality", "events", "director", "cultivation", "skills", "hud", "narrative_combat"],
    turn_trade: ["save", "character", "timeline", "knowledge", "relationships", "events", "director", "economy", "crafts", "hud", "narrative_power"],
    turn_travel: ["save", "character", "timeline", "knowledge", "clues", "events", "director", "regions", "society", "ecology", "intelligence", "hud"],
    full: ["*"]
  },
  loader: {
    defaultProfile: "continue",
    maxDepth: 0,
    homeMaxDepth: 0,
    maxNodesPerPage: 1_500,
    turnCoreMaxNodesPerPage: 60,
    turnDialogueMaxNodesPerPage: 200,
    concurrency: 2,
    cacheTtlSeconds: 300,
    persistSnapshotToGitHub: false
  }
};

const FIXED_PAGE_IDS = Object.freeze({
  home: "5f4c8de4a4c246478a4658d1ebc2a1a2",
  route: "39cc845007ae8184b97dd0e8c0122768",
  rules: "af1900844075472583e7f30d90a9a7a7",
  save: "39fc845007ae81f295ecef235d229ff2",
  character: "39fc845007ae81f2a723dca974a8342a",
  timeline: "39fc845007ae8193a691e96f0323561c",
  knowledge: "3a0c845007ae81518960f13469012b3b",
  relationships: "3a0c845007ae81318eb6c9af267def40",
  causality: "3a0c845007ae81148a7ee469dc58cf2a",
  clues: "3a0c845007ae818cba00fc7ef100b7eb",
  events: "3a0c845007ae8144a64de3a6c646332c",
  changelog: "3a0c845007ae81eaa4d4c15a2f3f9b19",
  director: "3a0c845007ae81888deaff5b06b6a168",
  experience: "39fc845007ae81eeb4fac2a18a75abd7",
  character_template: "3a0c845007ae81bb9b11e29e0b10e7d7"
});

export async function resolveWorldConfig(env, github = new GitHubClient(env)) {
  let remote = {};
  if (github.configured) {
    remote = (await github.getJson("world/config.json", { allowNotFound: true }))?.data || {};
  }
  const remoteVersion = Number(remote.version || 0);
  const compatibleRemote = remoteVersion >= DEFAULT_WORLD_CONFIG.version ? remote : {};
  const config = mergeDeep(DEFAULT_WORLD_CONFIG, compatibleRemote);
  const environmentHomeId = env.NOTION_HOME_PAGE_ID || env.HOME_PAGE_ID;
  if (environmentHomeId) config.homePageId = normalizeNotionId(environmentHomeId);
  config.catalog = dedupePages(config.catalog || config.pages || [], config.homePageId);
  assertFixedPageIdentities(config.catalog);
  return config;
}

export async function loadWorld(env, options = {}) {
  const notion = options.notion || new NotionClient(env);
  const github = options.github || new GitHubClient(env);
  const cache = options.cache || new CacheStore(env);
  const config = await resolveWorldConfig(env, github);
  const profile = options.profile || config.loader.defaultProfile || "continue";
  const selectedPages = selectWorldPages(config, profile, options.pageKeys);
  // Profile loads are deliberately shallow. Recursive reads multiply Notion
  // requests for tables, toggles, and child pages and can exhaust the Action
  // request window before the authoritative world markers are returned.
  const maxDepth = 0;
  const homeMaxDepth = Number(config.loader.homeMaxDepth ?? 0);
  const requestedMaxNodes = Number(options.maxNodes ?? config.loader.maxNodesPerPage);
  const turnCoreMaxNodes = Number(config.loader.turnCoreMaxNodesPerPage ?? 60);
  const turnDialogueMaxNodes = Number(config.loader.turnDialogueMaxNodesPerPage ?? 60);
  // A caller must not be able to expand a mandatory per-turn profile back
  // into an unbounded snapshot. Dialogue is bounded independently so the
  // active-cast detail survives the Action response budget.
  const profileMaxNodes = profile === "turn_core"
    ? turnCoreMaxNodes
    : profile === "turn_dialogue"
      ? turnDialogueMaxNodes
      : undefined;
  const maxNodes = profileMaxNodes === undefined
    ? requestedMaxNodes
    : Math.min(requestedMaxNodes, profileMaxNodes);
  const cacheKey = worldCacheKey(profile, selectedPages, maxDepth, maxNodes, homeMaxDepth, config.version);
  const persist = options.persist ?? config.loader.persistSnapshotToGitHub;

  if (!options.refresh) {
    const cached = await cache.get(cacheKey);
    if (cached) {
      const snapshot = { ...cached, meta: { ...cached.meta, cache: "hit" } };
      if (persist) snapshot.meta.githubCommit = await persistSnapshot(github, snapshot);
      return snapshot;
    }
  }

  if (!notion.configured) throw new ApiError(503, "NOTION_TOKEN is not configured");
  const pages = await mapLimit(selectedPages, Number(config.loader.concurrency || 2), async (entry) => {
    const pageDepth = entry.key === "home" ? homeMaxDepth : maxDepth;
    const tree = await notion.getPageTree(entry.id, { maxDepth: pageDepth, maxNodes, concurrency: 3 });
    assertActivePage(entry, tree.page);
    return { key: entry.key, title: entry.title, ...tree };
  });
  const snapshot = {
    version: 2,
    loadedAt: nowIso(),
    config: {
      version: config.version,
      profile,
      selectedPageKeys: selectedPages.map((page) => page.key),
      loader: config.loader
    },
    pages,
    meta: {
      cache: "miss",
      pageCount: pages.length,
      nodeCount: pages.reduce((sum, page) => sum + page.meta.nodeCount, 0)
    }
  };
  const world = validateLoadedWorld(pages, { required: selectedPages.some((page) => page.key === "save") });
  if (world) snapshot.meta.world = world;

  const ttl = Number(env.CACHE_TTL_SECONDS || config.loader.cacheTtlSeconds || 300);
  try {
    await cache.put(cacheKey, snapshot, ttl);
    snapshot.meta.cacheWrite = { status: "complete" };
  } catch (error) {
    // KV is an acceleration layer, not an authority. A size or transient KV
    // failure must never turn a valid Notion read into an internal error.
    snapshot.meta.cacheWrite = {
      status: "pending",
      error: error?.message || String(error),
    };
  }
  if (persist) snapshot.meta.githubCommit = await persistSnapshot(github, snapshot);
  return snapshot;
}

export function worldCacheKey(profile, selectedPages, maxDepth, maxNodes, homeMaxDepth, configVersion = 0) {
  const selection = selectedPages.map((page) => `${page.key}:${normalizeNotionId(page.id)}`).join("|");
  return `world:v${configVersion}:${profile}:${stableHash(selection)}:${maxDepth}:${maxNodes}:home:${homeMaxDepth}`;
}

function assertActivePage(entry, page) {
  if (page?.archived !== true && page?.in_trash !== true) return;
  throw new ApiError(409, `Configured Notion page is archived or in trash: ${entry.key}`, {
    key: entry.key,
    pageId: normalizeNotionId(entry.id)
  });
}

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function persistSnapshot(github, snapshot) {
  if (!github.configured) throw new ApiError(503, "GitHub storage is required when persist=true");
  const persisted = { ...snapshot, meta: { ...snapshot.meta } };
  delete persisted.meta.githubCommit;
  const saved = await github.putJson("world/cache.json", persisted, {
    message: `chore(world): refresh Notion snapshot ${snapshot.loadedAt}`
  });
  return saved.commit?.sha;
}

export function selectWorldPages(config, profile, extraPageKeys = []) {
  const catalog = config.catalog || [];
  const byKey = new Map(catalog.map((page) => [page.key, page]));
  const profileKeys = config.profiles?.[profile];
  if (!profileKeys) {
    throw new ApiError(400, `Unknown world load profile: ${profile}`, {
      availableProfiles: Object.keys(config.profiles || {})
    });
  }
  const extras = Array.isArray(extraPageKeys) ? extraPageKeys : [];
  const keys = profileKeys.includes("*") ? catalog.map((page) => page.key) : [...profileKeys, ...extras];
  const unique = [...new Set(keys)];
  const unknown = unique.filter((key) => !byKey.has(key));
  if (unknown.length) throw new ApiError(400, "Unknown world page keys", { unknown });
  return unique.map((key) => byKey.get(key));
}

function dedupePages(pages, homePageId) {
  const byKey = new Map();
  const byId = new Map();
  const output = [];
  for (const page of [{ key: "home", title: "修真世界（首頁）", id: homePageId }, ...pages]) {
    const key = typeof page.key === "string" ? page.key.trim() : "";
    if (!key) throw new ApiError(409, "World config contains a page without a key");
    const id = normalizeNotionId(page.id);
    const existingKey = byKey.get(key);
    if (existingKey && existingKey.id !== id) {
      throw new ApiError(409, `Conflicting Notion page mapping for key: ${key}`, {
        key,
        pageIds: [existingKey.id, id]
      });
    }
    if (existingKey) continue;
    const existingId = byId.get(id);
    if (existingId && existingId.key !== key) {
      throw new ApiError(409, "One Notion page is mapped to multiple world keys", {
        pageId: id,
        keys: [existingId.key, key]
      });
    }
    const normalized = { ...page, key, id };
    byKey.set(key, normalized);
    byId.set(id, normalized);
    output.push(normalized);
  }
  return output;
}

function assertFixedPageIdentities(catalog) {
  const byKey = new Map(catalog.map((page) => [page.key, normalizeNotionId(page.id)]));
  const conflicts = [];
  for (const [key, expectedRawId] of Object.entries(FIXED_PAGE_IDS)) {
    const expected = normalizeNotionId(expectedRawId);
    const actual = byKey.get(key);
    if (actual !== expected) conflicts.push({ key, expected, actual: actual || null });
  }
  if (conflicts.length) {
    throw new ApiError(409, "World config does not match the current fixed Notion page mapping", { conflicts });
  }
}
