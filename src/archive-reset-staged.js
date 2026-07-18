import { CacheStore } from "./cache.js";
import { GitHubClient } from "./github.js";
import { NotionClient } from "./notion.js";
import { ApiError, mapLimit, nowIso } from "./utils.js";
import {
  STATE_PAGE_KEYS,
  WORLD_PAGE_IDS,
  blockPlainText,
  parseWorldMarkers,
  validateLoadedWorld,
} from "./world-state.js";
import { ACTIVE_RESET_LOCK, getActiveReset } from "./reset-lock.js";

const ARCHIVE_SCHEMA = "XC_WORLD_ARCHIVE_V1";
const EMPTY_WORLD_ID = "PENDING";
const ARCHIVE_ROOT_TITLE = "世界封存庫";
const MARKER_TYPES = new Set([
  "paragraph", "callout", "heading_1", "heading_2", "heading_3",
  "bulleted_list_item", "numbered_list_item", "quote", "toggle",
]);
const MAX_SNAPSHOT_NODES = 5_000;
const MAX_SNAPSHOT_CHARS = 1_500_000;
const SNAPSHOT_CHUNK_SIZE = 1_500;
const LOCK_TTL_SECONDS = 86_400;

/**
 * The legacy archive implementation performed every page copy, verification,
 * and reset in one Worker invocation.  This module is deliberately page-
 * scoped: every exported operation stays below the Worker subrequest ceiling
 * and records its checkpoint before the next Workflow step runs.
 */
export async function prepareStagedArchiveReset(env, input, dependencies = {}) {
  const { notion, cache } = runtime(env, dependencies);
  let lock = await getActiveReset(cache);
  if (lock && !sameOperation(lock, input)) {
    throw new ApiError(423, "Another archive-and-reset operation is already in progress", {
      archiveId: lock.archiveId || null,
      expectedWorldId: lock.expectedWorldId || null,
      phase: lock.phase,
    });
  }

  if (lock?.phase && lock.phase !== "queued") return lock;

  const pages = await readDirectPages(notion);
  const world = validateLoadedWorld(pages.map(({ key, children }) => ({ key, children })), { required: true });
  if (world.worldState !== "ACTIVE" || world.worldId !== input.expectedWorldId) {
    throw new ApiError(409, "Archive-and-reset requires the exact current ACTIVE world", {
      expectedWorldId: input.expectedWorldId,
      actualWorldId: world.worldId,
      actualWorldState: world.worldState,
    });
  }

  const archiveId = archiveIdFor(input.expectedWorldId, input.operationKey);
  const parentId = env.NOTION_ARCHIVE_PARENT_PAGE_ID || env.NOTION_HOME_PAGE_ID || env.HOME_PAGE_ID;
  if (!parentId) throw new ApiError(503, "NOTION_ARCHIVE_PARENT_PAGE_ID, NOTION_HOME_PAGE_ID, or HOME_PAGE_ID is required");

  const root = await findOrCreateChildPage(notion, parentId, ARCHIVE_ROOT_TITLE);
  const worldTitle = "封存世界｜" + input.expectedWorldId + "｜" + input.operationKey;
  const worldPage = await findOrCreateChildPage(notion, root.id, worldTitle);
  const sourcePages = await discoverSourcePages(notion, worldPage.id);
  if ((await notion.listAllBlockChildren(worldPage.id, { maxNodes: 50 })).length === 0) {
    await appendTextBlocks(notion, worldPage.id, [
      "XC_ARCHIVE_SCHEMA：" + ARCHIVE_SCHEMA,
      "XC_ARCHIVE_ID：" + archiveId,
      "WORLD_ID：" + input.expectedWorldId,
      "ARCHIVED_AT：" + nowIso(),
      "SOURCE_PAGE_KEYS：" + STATE_PAGE_KEYS.join(","),
      "ARCHIVE_STATUS：VERIFIED_AFTER_ALL_SOURCE_PAGES_COMPLETE",
    ]);
  }

  lock = {
    phase: "archiving",
    archiveId,
    archivePageId: worldPage.id,
    expectedWorldId: input.expectedWorldId,
    operationKey: input.operationKey,
    archive: { archiveId, archivePageId: worldPage.id, sourcePages },
    archivedKeys: [],
    createdAt: lock?.createdAt || nowIso(),
  };
  await cache.put(ACTIVE_RESET_LOCK, lock, LOCK_TTL_SECONDS);
  return lock;
}

export async function archiveAndVerifyStagedPage(env, input, key, dependencies = {}) {
  assertStatePageKey(key);
  const { notion, cache } = runtime(env, dependencies);
  const lock = await requireLock(cache, input, ["archiving", "archive_verified"]);
  if (lock.phase === "archive_verified") return lock;

  const source = await readPage(notion, key, { deep: true });
  assertActivePage(source, input.expectedWorldId);
  const serialized = serializeSource(lock, source);
  if (serialized.length > MAX_SNAPSHOT_CHARS) {
    throw new ApiError(422, "A world page snapshot exceeds the archive safety limit", { key, maxSnapshotChars: MAX_SNAPSHOT_CHARS });
  }

  let stored = lock.archive.sourcePages.find((item) => item.key === key);
  if (stored) {
    try {
      await verifyStoredSource(notion, stored, source, lock);
      return markArchived(cache, lock, key, stored);
    } catch (error) {
      // Never overwrite an incomplete source page.  A later attempt is an
      // immutable sibling and becomes the one referenced by the checkpoint.
      stored = null;
    }
  }

  const attempt = lock.archive.sourcePages.filter((item) => item.key === key).length + 1;
  const sourcePage = await notion.createChildPage(lock.archivePageId, {
    title: "存檔｜" + key + "｜" + attempt,
  });
  const digest = await sha256Hex(serialized);
  await appendTextBlocks(notion, sourcePage.id, [
    "XC_ARCHIVE_SOURCE：" + key,
    "XC_ARCHIVE_ID：" + lock.archiveId,
    "WORLD_ID：" + input.expectedWorldId,
    "SOURCE_SHA256：" + digest,
    "SOURCE_BYTES：" + serialized.length,
    ...chunkText(serialized, SNAPSHOT_CHUNK_SIZE).map((chunk, index) => "XC_ARCHIVE_CHUNK:" + key + ":" + index + ":" + chunk),
  ]);
  stored = { key, pageId: sourcePage.id, sha256: digest, bytes: serialized.length };
  await verifyStoredSource(notion, stored, source, lock);

  const replaced = lock.archive.sourcePages.filter((item) => item.key !== key);
  replaced.push(stored);
  lock.archive.sourcePages = replaced;
  return markArchived(cache, lock, key, stored);
}

export async function verifyStagedArchive(env, input, dependencies = {}) {
  const { notion, cache } = runtime(env, dependencies);
  const lock = await requireLock(cache, input, ["archiving", "archive_verified"]);
  if (lock.phase === "archive_verified") return lock;
  if (lock.archivedKeys?.length !== STATE_PAGE_KEYS.length) {
    throw new ApiError(409, "Archive is incomplete; not every fixed page has a verified checkpoint", {
      archivedKeys: lock.archivedKeys || [],
    });
  }

  for (const key of STATE_PAGE_KEYS) {
    const stored = lock.archive.sourcePages.find((item) => item.key === key);
    if (!stored) throw new ApiError(409, "Archive is missing a fixed world page", { key });
    await verifyStoredSource(notion, stored, null, lock);
  }
  lock.phase = "archive_verified";
  lock.archiveVerifiedAt = nowIso();
  await cache.put(ACTIVE_RESET_LOCK, lock, LOCK_TTL_SECONDS);
  return lock;
}

export async function markStagedPageResetting(env, input, key, dependencies = {}) {
  assertStatePageKey(key);
  const { notion, cache } = runtime(env, dependencies);
  const lock = await requireLock(cache, input, ["archive_verified", "resetting"]);
  const page = await readPage(notion, key, { deep: false });
  if (page.markers.worldState === "RESETTING" && page.markers.worldId === input.expectedWorldId) return lock;
  assertActivePage(page, input.expectedWorldId);
  await notion.updateBlock(page.marker.id, { type: page.marker.type, text: resettingMarker(input.expectedWorldId) });
  if (lock.phase !== "resetting") {
    lock.phase = "resetting";
    await cache.put(ACTIVE_RESET_LOCK, lock, LOCK_TTL_SECONDS);
  }
  return lock;
}

export async function clearStagedPage(env, input, key, dependencies = {}) {
  assertStatePageKey(key);
  const { notion, cache } = runtime(env, dependencies);
  await requireLock(cache, input, ["resetting"]);
  const page = await readPage(notion, key, { deep: false });
  if (page.markers.worldState !== "RESETTING" || page.markers.worldId !== input.expectedWorldId) {
    throw new ApiError(409, "A fixed page changed during archive-and-reset", {
      key, worldState: page.markers.worldState, worldId: page.markers.worldId,
    });
  }
  for (const block of page.children) {
    if (block.id !== page.marker.id) await notion.archiveBlock(block.id);
  }
}

export async function markStagedPageEmpty(env, input, key, dependencies = {}) {
  assertStatePageKey(key);
  const { notion, cache } = runtime(env, dependencies);
  await requireLock(cache, input, ["resetting"]);
  const page = await readPage(notion, key, { deep: false });
  if (page.children.length !== 1 || page.children[0]?.id !== page.marker.id) {
    throw new ApiError(409, "Cannot mark a page EMPTY while world blocks remain", { key, remainingBlockCount: page.children.length });
  }
  await notion.updateBlock(page.marker.id, { type: page.marker.type, text: emptyMarker() });
}

export async function finalizeStagedArchiveReset(env, input, dependencies = {}) {
  const { notion, github, cache } = runtime(env, dependencies);
  const lock = await requireLock(cache, input, ["resetting"]);
  const pages = await readDirectPages(notion);
  const world = validateLoadedWorld(pages.map(({ key, children }) => ({ key, children })), { required: true });
  if (world.worldState !== "EMPTY" || world.worldId !== EMPTY_WORLD_ID) {
    throw new ApiError(409, "Archive verified, but fixed pages are not yet fully EMPTY/PENDING", {
      worldState: world.worldState, worldId: world.worldId,
    });
  }
  for (const page of pages) {
    if (page.children.length !== 1) {
      throw new ApiError(409, "A cleared fixed page still contains world blocks", {
        key: page.key, remainingBlockCount: page.children.length,
      });
    }
  }

  const cacheEntriesInvalidated = await cache.deletePrefix("world:");
  const statusMirror = await mirrorEmptyWorldStatus(notion);
  const githubSync = await mirrorResetToGitHub(github, lock, input);
  const result = {
    idempotent: false,
    archived: true,
    reset: true,
    worldState: "EMPTY",
    worldId: EMPTY_WORLD_ID,
    previousWorldId: input.expectedWorldId,
    archive: lock.archive,
    validatedPageKeys: world.validatedPageKeys,
    cacheEntriesInvalidated,
    statusMirror,
    githubSync,
  };
  await cache.put("world-reset:last", { expectedWorldId: input.expectedWorldId, operationKey: input.operationKey, result }, 2_592_000);
  await cache.delete(ACTIVE_RESET_LOCK);
  return result;
}

function runtime(env, dependencies) {
  const cache = dependencies.cache || new CacheStore(env);
  if (!cache.kv && dependencies.requireDurableLock !== false) {
    throw new ApiError(503, "Archive-and-reset requires the XUANCHE_CACHE KV binding for its durable safety lock");
  }
  return {
    notion: dependencies.notion || new NotionClient(env),
    github: dependencies.github || new GitHubClient(env),
    cache,
  };
}

async function requireLock(cache, input, phases) {
  const lock = await getActiveReset(cache);
  if (!lock || !sameOperation(lock, input) || !phases.includes(lock.phase)) {
    throw new ApiError(409, "Archive-and-reset checkpoint is missing or in an unexpected phase", {
      phase: lock?.phase || null,
      expectedWorldId: lock?.expectedWorldId || null,
    });
  }
  return lock;
}

async function readDirectPages(notion) {
  return mapLimit(STATE_PAGE_KEYS, 2, (key) => readPage(notion, key, { deep: false }));
}

async function readPage(notion, key, { deep }) {
  const direct = await notion.getPageTree(WORLD_PAGE_IDS[key], {
    maxDepth: 0, maxNodes: MAX_SNAPSHOT_NODES, concurrency: 2, includePage: true,
  });
  const markerBlock = direct.children.find((block) => {
    const text = blockPlainText(block);
    return text.includes("WORLD_STATE") && text.includes("WORLD_ID") && MARKER_TYPES.has(block.type);
  });
  const markers = parseWorldMarkers(direct.children);
  if (!markerBlock || !markers.worldState || !markers.worldId) {
    throw new ApiError(409, "A fixed world page is missing an editable world-state marker", { key });
  }
  if (!deep) {
    return { key, page: direct.page, children: direct.children, deepChildren: direct.children, markers, marker: { id: markerBlock.id, type: markerBlock.type } };
  }
  const tree = await notion.getPageTree(WORLD_PAGE_IDS[key], {
    maxDepth: 2, maxNodes: MAX_SNAPSHOT_NODES, concurrency: 2, includePage: true,
  });
  return { key, page: tree.page, children: direct.children, deepChildren: tree.children, markers, marker: { id: markerBlock.id, type: markerBlock.type } };
}

function assertActivePage(page, worldId) {
  if (page.markers.worldState !== "ACTIVE" || page.markers.worldId !== worldId) {
    throw new ApiError(409, "A fixed page changed during archive-and-reset", {
      key: page.key, worldState: page.markers.worldState, worldId: page.markers.worldId,
    });
  }
}

function serializeSource(lock, page) {
  return JSON.stringify({
    schema: ARCHIVE_SCHEMA,
    archiveId: lock.archiveId,
    worldId: lock.expectedWorldId,
    pageKey: page.key,
    pageId: WORLD_PAGE_IDS[page.key],
    capturedAt: nowIso(),
    snapshot: { page: page.page, children: page.deepChildren },
  });
}

async function verifyStoredSource(notion, source, livePage, lock) {
  const children = await notion.listAllBlockChildren(source.pageId, { maxNodes: 20_000 });
  const text = children.map(blockPlainText);
  const hash = marker(text.join("\n"), "SOURCE_SHA256");
  const chunks = text
    .map((line) => /^XC_ARCHIVE_CHUNK:([^:]+):(\d+):(.*)$/s.exec(line))
    .filter(Boolean)
    .map((match) => ({ key: match[1], index: Number(match[2]), value: match[3] }))
    .filter((chunk) => chunk.key === source.key)
    .sort((a, b) => a.index - b.index);
  if (!hash || chunks.length === 0 || chunks.some((chunk, index) => chunk.index !== index)) {
    throw new ApiError(409, "Archive source chunks are missing or out of order", { key: source.key });
  }
  const serialized = chunks.map((chunk) => chunk.value).join("");
  const actualHash = await sha256Hex(serialized);
  if (actualHash !== hash) throw new ApiError(409, "Archive source checksum mismatch", { key: source.key, expected: hash, actual: actualHash });
  let restored;
  try { restored = JSON.parse(serialized); } catch { throw new ApiError(409, "Archive source JSON is not recoverable", { key: source.key }); }
  if (
    restored?.schema !== ARCHIVE_SCHEMA ||
    restored?.archiveId !== lock.archiveId ||
    restored?.worldId !== lock.expectedWorldId ||
    restored?.pageKey !== source.key ||
    restored?.pageId !== WORLD_PAGE_IDS[source.key]
  ) {
    throw new ApiError(409, "Archive source identity did not match its fixed page", { key: source.key });
  }
  if (livePage && restored.snapshot && !restored.snapshot.page) {
    throw new ApiError(409, "Archive source does not contain a page snapshot", { key: source.key });
  }
  source.sha256 = hash;
  source.bytes = serialized.length;
}

async function markArchived(cache, lock, key, source) {
  const archived = new Set(lock.archivedKeys || []);
  archived.add(key);
  lock.archivedKeys = STATE_PAGE_KEYS.filter((candidate) => archived.has(candidate));
  const others = lock.archive.sourcePages.filter((item) => item.key !== key);
  lock.archive.sourcePages = [...others, source];
  await cache.put(ACTIVE_RESET_LOCK, lock, LOCK_TTL_SECONDS);
  return lock;
}

async function discoverSourcePages(notion, archivePageId) {
  const children = await notion.listAllBlockChildren(archivePageId, { maxNodes: 100 });
  const sources = [];
  for (const block of children) {
    if (block.type !== "child_page") continue;
    const title = String(block.child_page?.title || "");
    const key = STATE_PAGE_KEYS.find((candidate) => title === "存檔｜" + candidate || title.startsWith("存檔｜" + candidate + "｜"));
    if (key && !sources.some((source) => source.key === key)) sources.push({ key, pageId: block.id });
  }
  return sources;
}

async function findOrCreateChildPage(notion, parentPageId, title) {
  const existing = await findChildPage(notion, parentPageId, title);
  return existing || notion.createChildPage(parentPageId, { title });
}

async function findChildPage(notion, parentPageId, title) {
  const children = await notion.listAllBlockChildren(parentPageId, { maxNodes: 5_000 });
  return children.find((block) => block.type === "child_page" && block.child_page?.title === title) || null;
}

async function appendTextBlocks(notion, pageId, lines) {
  for (let index = 0; index < lines.length; index += 100) {
    await notion.appendBlocks(pageId, lines.slice(index, index + 100));
  }
}

async function mirrorEmptyWorldStatus(notion) {
  const mirrors = [
    ["5f4c8de4a4c246478a4658d1ebc2a1a2", "home"],
    ["39cc845007ae8184b97dd0e8c0122768", "route"],
  ];
  try {
    let updates = 0;
    for (const [pageId, key] of mirrors) {
      const tree = await notion.getPageTree(pageId, { maxDepth: 0, maxNodes: 250, concurrency: 1, includePage: false });
      for (const block of tree.children) {
        const current = blockPlainText(block);
        if (!MARKER_TYPES.has(block.type)) continue;
        let next = null;
        if (key === "home" && current.includes("世界系統：") && current.includes("目前狀態：")) {
          next = current.replace(/目前狀態：(EMPTY|ACTIVE|RESETTING|WORLD_CONFLICT)/, "目前狀態：EMPTY");
        } else if (key === "home" && /^固定世界資料｜目前(?:EMPTY|ACTIVE|RESETTING|WORLD_CONFLICT)$/.test(current)) {
          next = "固定世界資料｜目前EMPTY";
        } else if (key === "home" && current.startsWith("目前WORLD_STATE：")) {
          next = "目前WORLD_STATE：EMPTY；目前WORLD_ID：PENDING。尚未建立現行世界。";
        } else if (key === "route" && current.startsWith("目前世界狀態：")) {
          next = "目前世界狀態：EMPTY。沒有可續接角色或劇情。";
        }
        if (next && next !== current) {
          await notion.updateBlock(block.id, { type: block.type, text: next });
          updates += 1;
        }
      }
    }
    return { status: "complete", updates };
  } catch (error) {
    return { status: "pending", error: error?.message || String(error) };
  }
}

async function mirrorResetToGitHub(github, lock, input) {
  if (!github.configured) return { status: "unavailable" };
  const timestamp = nowIso();
  const errors = [];
  const commits = {};
  try {
    const saved = await github.putJson("world/memory.json", {
      version: 3, schema: "SAVE_V3.2", updatedAt: timestamp, worldState: "EMPTY", worldId: EMPTY_WORLD_ID, simTick: 0,
      purgeId: lock.archiveId,
      events: [{ timestamp, type: "world_archive_reset", summary: "Archived and reset " + input.expectedWorldId, worldId: input.expectedWorldId, archiveId: lock.archiveId }],
    }, { message: "chore(world): archive and reset " + input.expectedWorldId });
    commits.memory = saved.commit?.sha;
  } catch (error) { errors.push({ target: "world/memory.json", message: error?.message || String(error) }); }
  try {
    const saved = await github.putJson("world/cache.json", {
      version: 3, schema: "SAVE_V3.2", updatedAt: timestamp, worldState: "EMPTY", worldId: EMPTY_WORLD_ID, simTick: 0,
      lastSaveKey: null, archiveId: lock.archiveId, snapshot: null,
    }, { message: "chore(world): clear cache after archive " + input.expectedWorldId });
    commits.cache = saved.commit?.sha;
  } catch (error) { errors.push({ target: "world/cache.json", message: error?.message || String(error) }); }
  return { status: errors.length ? "pending" : "complete", commits, errors };
}

function assertStatePageKey(key) {
  if (!STATE_PAGE_KEYS.includes(key)) throw new ApiError(400, "Unknown fixed world page key", { key });
}

function sameOperation(lock, input) {
  return lock?.expectedWorldId === input.expectedWorldId && lock?.operationKey === input.operationKey;
}

function resettingMarker(worldId) {
  return "SAVE_SCHEMA_VERSION：SAVE_V3.2｜WORLD_STATE：RESETTING｜WORLD_ID：" + worldId + "\nSIM_TICK：0｜狀態修訂：0｜RESET_LOCK：ARCHIVE_VERIFIED";
}

function emptyMarker() {
  return "SAVE_SCHEMA_VERSION：SAVE_V3.2｜WORLD_STATE：EMPTY｜WORLD_ID：PENDING\nSIM_TICK：0｜狀態修訂：0";
}

function archiveIdFor(worldId, operationKey) {
  return "A-" + worldId + "-" + simpleHash(operationKey).toUpperCase();
}

function simpleHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function chunkText(value, maxLength) {
  const units = Array.from(value);
  const chunks = [];
  for (let index = 0; index < units.length; index += maxLength) chunks.push(units.slice(index, index + maxLength).join(""));
  return chunks;
}

function marker(text, name) {
  return text.match(new RegExp(name + "\\s*[：:]\\s*([^\\s|｜]+)", "i"))?.[1] || null;
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
