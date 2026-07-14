import { CacheStore } from "./cache.js";
import { GitHubClient } from "./github.js";
import { NotionClient } from "./notion.js";
import { ApiError, mapLimit, mergeDeep, normalizeNotionId, nowIso } from "./utils.js";

export const DEFAULT_WORLD_CONFIG = {
  version: 3,
  homePageId: "5f4c8de4a4c246478a4658d1ebc2a1a2",
  catalog: [
    { key: "home", title: "修真世界（首頁）", id: "5f4c8de4a4c246478a4658d1ebc2a1a2" },
    { key: "route", title: "AI 載入入口", id: "39cc845007ae8184b97dd0e8c0122768" },
    { key: "rules", title: "修真世界規則", id: "af1900844075472583e7f30d90a9a7a7" },
    { key: "save", title: "世界存檔", id: "c2915aef9e5f4c8fbcb1800809ea1592" },
    { key: "wiki", title: "世界資料庫", id: "1c2c113806424108897b16bdf35c1484" },
    { key: "timeline", title: "世界時間線", id: "d39e967d2ef14de69adf9c5a1f15d7dc" },
    { key: "knowledge", title: "知識圖鑑", id: "30e7c014b5974e11844b2ae6cc3cb3d9" },
    { key: "reputation", title: "NPC 名聲", id: "2ce808c3d4ed4740a1d077ad5af901d5" },
    { key: "karma", title: "因果", id: "efb8dff0ffc942f494c413cae44cc520" },
    { key: "foreshadowing", title: "伏筆", id: "11ecce398770417dac2ef36635bf85b0" },
    { key: "events", title: "世界事件", id: "069863ba9288442b948bca74ab339a3a" },
    { key: "changelog", title: "更新日誌", id: "4a0284a974d441e99df4849070576cf0" },
    { key: "director", title: "導演筆記", id: "ab8dbe6cf9054c2c85457869b3022efe" },
    { key: "flow", title: "遊戲流程與回合規則", id: "39cc845007ae81e7a357c7d4b3a5d6de" },
    { key: "npc", title: "角色、NPC 與對話規則", id: "39cc845007ae811595cae2aa37672243" },
    { key: "cultivation", title: "修煉、境界與極境體系", id: "39cc845007ae81439c24d6854fc3f352" },
    { key: "skills", title: "功法、技能與神通體系", id: "39cc845007ae818d807ee4a9648ecd51" },
    { key: "combat", title: "戰鬥、難度與公平性", id: "39cc845007ae8146ad02db524906e1b7" },
    { key: "protagonist", title: "主角核心設定", id: "39cc845007ae8192917ac0f8ec708f9f" },
    { key: "world", title: "世界觀、劇情與事件生成", id: "39cc845007ae81d59208f786d3303b67" },
    { key: "hud", title: "HUD、狀態與資訊顯示", id: "39cc845007ae81648196e98ac7349f1d" },
    { key: "persistence", title: "記憶、載入、存檔與一致性", id: "39cc845007ae8185acf5d7af416b7849" },
    { key: "equipment", title: "武器、防具與法寶體系", id: "39cc845007ae8108bc7eeb1b7f4c51df" },
    { key: "creatures", title: "靈獸、妖族與契約體系", id: "39cc845007ae8171a826f644731bc132" },
    { key: "crafts", title: "丹藥、符籙、陣法與修真百藝", id: "39cc845007ae819aa31ecd7a59a232ac" },
    { key: "economy", title: "資源、貨幣、勢力與世界經濟", id: "39cc845007ae81f39ac9c4772dfd1048" },
    { key: "regions", title: "地域、氣候與文明差異", id: "39cc845007ae81e483a4cd72be050b04" },
    { key: "society", title: "日常生活、社會秩序與凡人世界", id: "39cc845007ae8109bf0dec8624172612" },
    { key: "ecology", title: "生態、天象、災害與環境演化", id: "39cc845007ae81d899f9dc23218de15d" },
    { key: "intelligence", title: "情報、謠言、秘密與知識傳播", id: "39cc845007ae818db0a9cb19c1010689" },
    { key: "factions", title: "NPC 目標、派系演化與世界脈動", id: "39cc845007ae81b483e5c8a095ceb409" }
  ],
  profiles: {
    base: ["home", "route", "rules", "save", "timeline"],
    continue: ["home", "route", "rules", "save", "timeline", "flow", "npc", "protagonist", "world", "hud"],
    cultivation: ["home", "route", "rules", "save", "timeline", "cultivation", "skills", "protagonist", "hud", "wiki"],
    combat: ["home", "route", "rules", "save", "timeline", "combat", "hud", "wiki", "reputation", "karma", "events"],
    npc: ["home", "route", "rules", "save", "timeline", "npc", "reputation", "karma", "wiki", "protagonist"],
    exploration: ["home", "route", "rules", "save", "timeline", "world", "wiki", "knowledge", "foreshadowing", "events", "regions", "ecology", "intelligence"],
    full: ["*"]
  },
  loader: {
    defaultProfile: "continue",
    maxDepth: 6,
    homeMaxDepth: 0,
    maxNodesPerPage: 5_000,
    concurrency: 2,
    cacheTtlSeconds: 300,
    persistSnapshotToGitHub: false
  }
};

export async function resolveWorldConfig(env, github = new GitHubClient(env)) {
  let remote = {};
  if (github.configured) {
    remote = (await github.getJson("world/config.json", { allowNotFound: true }))?.data || {};
  }
  const config = mergeDeep(DEFAULT_WORLD_CONFIG, remote);
  const environmentHomeId = env.NOTION_HOME_PAGE_ID || env.HOME_PAGE_ID;
  if (environmentHomeId) config.homePageId = normalizeNotionId(environmentHomeId);
  config.catalog = dedupePages(config.catalog || config.pages || [], config.homePageId);
  return config;
}

export async function loadWorld(env, options = {}) {
  const notion = options.notion || new NotionClient(env);
  const github = options.github || new GitHubClient(env);
  const cache = options.cache || new CacheStore(env);
  const config = await resolveWorldConfig(env, github);
  const profile = options.profile || config.loader.defaultProfile || "continue";
  const selectedPages = selectWorldPages(config, profile, options.pageKeys);
  const maxDepth = Number(options.maxDepth ?? config.loader.maxDepth);
  const homeMaxDepth = Number(config.loader.homeMaxDepth ?? 0);
  const maxNodes = Number(options.maxNodes ?? config.loader.maxNodesPerPage);
  const cacheKey = worldCacheKey(profile, selectedPages, maxDepth, maxNodes, homeMaxDepth);
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
    return { key: entry.key, title: entry.title, ...tree };
  });
  const snapshot = {
    version: 1,
    loadedAt: nowIso(),
    config: {
      version: config.version,
      profile,
      selectedPageKeys: selectedPages.map((page) => page.key),
      loader: config.loader,
    },
    pages,
    meta: {
      cache: "miss",
      pageCount: pages.length,
      nodeCount: pages.reduce((sum, page) => sum + page.meta.nodeCount, 0),
    },
  };

  const ttl = Number(env.CACHE_TTL_SECONDS || config.loader.cacheTtlSeconds || 300);
  await cache.put(cacheKey, snapshot, ttl);

  if (persist) {
    snapshot.meta.githubCommit = await persistSnapshot(github, snapshot);
  }
  return snapshot;
}

export function worldCacheKey(profile, selectedPages, maxDepth, maxNodes, homeMaxDepth) {
  return `world:${profile}:${selectedPages.map((page) => page.key).join(",")}:${maxDepth}:${maxNodes}:home:${homeMaxDepth}`;
}

async function persistSnapshot(github, snapshot) {
  if (!github.configured) throw new ApiError(503, "GitHub storage is required when persist=true");
  const persisted = {
    ...snapshot,
    meta: { ...snapshot.meta },
  };
  delete persisted.meta.githubCommit;
  const saved = await github.putJson("world/cache.json", persisted, {
    message: `chore(world): refresh Notion snapshot ${snapshot.loadedAt}`,
  });
  return saved.commit?.sha;
}

export function selectWorldPages(config, profile, extraPageKeys = []) {
  const catalog = config.catalog || [];
  const byKey = new Map(catalog.map((page) => [page.key, page]));
  const profileKeys = config.profiles?.[profile];
  if (!profileKeys) {
    throw new ApiError(400, `Unknown world load profile: ${profile}`, {
      availableProfiles: Object.keys(config.profiles || {}),
    });
  }
  const extras = Array.isArray(extraPageKeys) ? extraPageKeys : [];
  const keys = profileKeys.includes("*")
    ? catalog.map((page) => page.key)
    : [...profileKeys, ...extras];
  const unique = [...new Set(keys)];
  const unknown = unique.filter((key) => !byKey.has(key));
  if (unknown.length) throw new ApiError(400, "Unknown world page keys", { unknown });
  return unique.map((key) => byKey.get(key));
}

function dedupePages(pages, homePageId) {
  const seen = new Set();
  const output = [];
  for (const page of [{ key: "home", title: "修真世界（首頁）", id: homePageId }, ...pages]) {
    const id = normalizeNotionId(page.id);
    if (seen.has(id)) continue;
    seen.add(id);
    output.push({ ...page, id });
  }
  return output;
}
