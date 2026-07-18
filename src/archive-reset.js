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

/**
 * Safely moves a completed world out of the fixed SAVE_V3.2 pages.
 *
 * Notion cannot make a multi-page transaction atomic. We compensate by
 * verifying an immutable, content-addressed archive before writing RESETTING.
 * A persisted KV lock then prevents every regular load/update/initialize call
 * from treating the in-between state as a playable world. A retry with the
 * same operationKey resumes final clearing; it never creates a second archive.
 */
export async function archiveAndResetWorld(env, input, dependencies = {}) {
  validateInput(input);
  const notion = dependencies.notion || new NotionClient(env);
  const github = dependencies.github || new GitHubClient(env);
  const cache = dependencies.cache || new CacheStore(env);
  if (!cache.kv && dependencies.requireDurableLock !== false) {
    throw new ApiError(503, "Archive-and-reset requires the XUANCHE_CACHE KV binding for its durable safety lock");
  }

  const activeLock = await getActiveReset(cache);
  if (activeLock && !sameOperation(activeLock, input)) {
    throw new ApiError(423, "Another archive-and-reset operation is already in progress", {
      archiveId: activeLock.archiveId || null,
      expectedWorldId: activeLock.expectedWorldId || null,
      phase: activeLock.phase,
    });
  }

  const pages = await readResetPages(notion, { snapshotDepth: activeLock ? 0 : 20 });
  const canonical = pages.find((page) => page.key === "save");
  const canonicalState = canonical.markers.worldState;

  if (!activeLock && canonicalState === "EMPTY" && canonical.markers.worldId === EMPTY_WORLD_ID) {
    const previous = await cache.get("world-reset:last");
    if (previous && sameOperation(previous, input)) return { ...previous.result, idempotent: true };
    throw new ApiError(409, "The fixed world pages are already EMPTY/PENDING; there is no ACTIVE world to archive", {
      worldState: canonicalState,
      worldId: canonical.markers.worldId,
    });
  }

  if (!activeLock) {
    const world = validateLoadedWorld(
      pages.map((page) => ({ key: page.key, children: page.children })),
      { required: true },
    );
    if (world.worldState !== "ACTIVE" || world.worldId !== input.expectedWorldId) {
      throw new ApiError(409, "Archive-and-reset requires the exact current ACTIVE world", {
        expectedWorldId: input.expectedWorldId,
        actualWorldId: world.worldId,
        actualWorldState: world.worldState,
      });
    }

    const archive = await createAndVerifyArchive(env, notion, pages, input);
    const lock = {
      phase: "archive_verified",
      archiveId: archive.archiveId,
      archivePageId: archive.archivePageId,
      expectedWorldId: input.expectedWorldId,
      operationKey: input.operationKey,
      archive,
      createdAt: nowIso(),
    };
    await cache.put(ACTIVE_RESET_LOCK, lock, 86_400);
    return resumeReset(env, { notion, github, cache }, input, lock);
  }

  if (activeLock.expectedWorldId !== input.expectedWorldId) {
    throw new ApiError(409, "The pending reset belongs to a different world", {
      expectedWorldId: activeLock.expectedWorldId,
      providedWorldId: input.expectedWorldId,
    });
  }
  return resumeReset(env, { notion, github, cache }, input, activeLock);
}

async function resumeReset(_env, dependencies, input, lock) {
  const { notion, github, cache } = dependencies;
  const first = await readResetPages(notion, { snapshotDepth: 0 });
  const canonical = first.find((page) => page.key === "save");
  if (canonical.markers.worldState === "EMPTY" && canonical.markers.worldId === EMPTY_WORLD_ID) {
    const result = await finishReset({ notion, github, cache, input, lock, pages: first });
    return { ...result, idempotent: true };
  }

  // The archive was verified before this point. From now on we do not restore
  // ACTIVE markers after a failure: a retry resumes the safe, non-playable
  // RESETTING state and cannot expose a partly cleared world to the game.
  await cache.put(ACTIVE_RESET_LOCK, { ...lock, phase: "resetting" }, 86_400);
  await markPagesResetting(notion, first, input.expectedWorldId);

  const resetting = await readResetPages(notion, { snapshotDepth: 0 });
  await clearWorldBlocks(notion, resetting);

  const cleared = await readResetPages(notion, { snapshotDepth: 0 });
  await markPagesEmpty(notion, cleared);

  const finalPages = await readResetPages(notion, { snapshotDepth: 0 });
  return finishReset({ notion, github, cache, input, lock, pages: finalPages });
}

async function finishReset({ notion, github, cache, input, lock, pages }) {
  const world = validateLoadedWorld(
    pages.map((page) => ({ key: page.key, children: page.children })),
    { required: true },
  );
  if (world.worldState !== "EMPTY" || world.worldId !== EMPTY_WORLD_ID) {
    throw new ApiError(409, "Archive verified, but fixed pages are not yet fully EMPTY/PENDING", {
      worldState: world.worldState,
      worldId: world.worldId,
    });
  }
  for (const page of pages) {
    if (page.children.length !== 1) {
      throw new ApiError(409, "A cleared fixed page still contains world blocks", {
        key: page.key,
        remainingBlockCount: page.children.length,
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

async function createAndVerifyArchive(env, notion, pages, input) {
  const archiveId = archiveIdFor(input.expectedWorldId, input.operationKey);
  const parentId = env.NOTION_ARCHIVE_PARENT_PAGE_ID || env.NOTION_HOME_PAGE_ID || env.HOME_PAGE_ID;
  if (!parentId) throw new ApiError(503, "NOTION_ARCHIVE_PARENT_PAGE_ID, NOTION_HOME_PAGE_ID, or HOME_PAGE_ID is required");
  const root = await findOrCreateChildPage(notion, parentId, ARCHIVE_ROOT_TITLE);
  const worldTitle = `封存世界｜${input.expectedWorldId}｜${input.operationKey}`;
  const existing = await findChildPage(notion, root.id, worldTitle);
  if (existing) return verifyExistingArchive(notion, existing.id, pages, archiveId, input.expectedWorldId);

  const worldPage = await notion.createChildPage(root.id, { title: worldTitle });
  const timestamp = nowIso();
  const sourcePages = [];
  await appendTextBlocks(notion, worldPage.id, [
    `XC_ARCHIVE_SCHEMA：${ARCHIVE_SCHEMA}`,
    `XC_ARCHIVE_ID：${archiveId}`,
    `WORLD_ID：${input.expectedWorldId}`,
    `ARCHIVED_AT：${timestamp}`,
    `SOURCE_PAGE_KEYS：${STATE_PAGE_KEYS.join(",")}`,
    "ARCHIVE_STATUS：VERIFIED_AFTER_ALL_SOURCE_PAGES_COMPLETE",
  ]);

  for (const page of pages) {
    const source = {
      schema: ARCHIVE_SCHEMA,
      archiveId,
      worldId: input.expectedWorldId,
      pageKey: page.key,
      pageId: WORLD_PAGE_IDS[page.key],
      capturedAt: timestamp,
      snapshot: { page: page.page, children: page.deepChildren },
    };
    const serialized = JSON.stringify(source);
    if (serialized.length > MAX_SNAPSHOT_CHARS) {
      throw new ApiError(422, "A world page snapshot exceeds the archive safety limit", {
        key: page.key,
        maxSnapshotChars: MAX_SNAPSHOT_CHARS,
      });
    }
    const sourcePage = await notion.createChildPage(worldPage.id, { title: `存檔｜${page.key}` });
    const digest = await sha256Hex(serialized);
    await appendTextBlocks(notion, sourcePage.id, [
      `XC_ARCHIVE_SOURCE：${page.key}`,
      `XC_ARCHIVE_ID：${archiveId}`,
      `WORLD_ID：${input.expectedWorldId}`,
      `SOURCE_SHA256：${digest}`,
      `SOURCE_BYTES：${serialized.length}`,
      ...chunkText(serialized, SNAPSHOT_CHUNK_SIZE).map((chunk, index) => `XC_ARCHIVE_CHUNK:${page.key}:${index}:${chunk}`),
    ]);
    sourcePages.push({ key: page.key, pageId: sourcePage.id, sha256: digest, bytes: serialized.length });
  }

  const archive = { archiveId, archivePageId: worldPage.id, sourcePages };
  await verifyArchive(notion, archive, pages, input.expectedWorldId);
  return archive;
}

async function verifyExistingArchive(notion, archivePageId, pages, archiveId, worldId) {
  const sourcePages = [];
  const children = await notion.listAllBlockChildren(archivePageId, { maxNodes: 100 });
  for (const block of children) {
    if (block.type !== "child_page") continue;
    const key = String(block.child_page?.title || "").replace(/^存檔｜/, "");
    if (STATE_PAGE_KEYS.includes(key)) sourcePages.push({ key, pageId: block.id });
  }
  if (sourcePages.length !== STATE_PAGE_KEYS.length) {
    throw new ApiError(409, "A previous archive with this operationKey is incomplete; it will not be overwritten", {
      archivePageId,
      expectedSourcePages: STATE_PAGE_KEYS.length,
      actualSourcePages: sourcePages.length,
    });
  }
  const archive = { archiveId, archivePageId, sourcePages };
  await verifyArchive(notion, archive, pages, worldId);
  return archive;
}

async function verifyArchive(notion, archive, pages, worldId) {
  const sourcesByKey = new Map(archive.sourcePages.map((source) => [source.key, source]));
  for (const page of pages) {
    const source = sourcesByKey.get(page.key);
    if (!source) throw new ApiError(409, "Archive is missing a fixed world page", { key: page.key });
    const children = await notion.listAllBlockChildren(source.pageId, { maxNodes: 20_000 });
    const text = children.map(blockPlainText);
    const hash = marker(text.join("\n"), "SOURCE_SHA256");
    const chunks = text
      .map((line) => /^XC_ARCHIVE_CHUNK:([^:]+):(\d+):(.*)$/s.exec(line))
      .filter(Boolean)
      .map((match) => ({ key: match[1], index: Number(match[2]), value: match[3] }))
      .filter((chunk) => chunk.key === page.key)
      .sort((a, b) => a.index - b.index);
    if (!hash || chunks.length === 0 || chunks.some((chunk, index) => chunk.index !== index)) {
      throw new ApiError(409, "Archive source chunks are missing or out of order", { key: page.key });
    }
    const serialized = chunks.map((chunk) => chunk.value).join("");
    const actualHash = await sha256Hex(serialized);
    if (actualHash !== hash) throw new ApiError(409, "Archive source checksum mismatch", { key: page.key, expected: hash, actual: actualHash });
    let restored;
    try {
      restored = JSON.parse(serialized);
    } catch {
      throw new ApiError(409, "Archive source JSON is not recoverable", { key: page.key });
    }
    if (
      restored?.schema !== ARCHIVE_SCHEMA ||
      restored?.worldId !== worldId ||
      restored?.pageKey !== page.key ||
      restored?.pageId !== WORLD_PAGE_IDS[page.key]
    ) {
      throw new ApiError(409, "Archive source identity did not match its fixed page", { key: page.key });
    }
    source.sha256 = hash;
    source.bytes = serialized.length;
  }
}

async function markPagesResetting(notion, pages, worldId) {
  for (const page of pages) {
    if (page.markers.worldState === "RESETTING" && page.markers.worldId === worldId) continue;
    if (!["ACTIVE", "RESETTING"].includes(page.markers.worldState) || page.markers.worldId !== worldId) {
      throw new ApiError(409, "A fixed page changed during archive-and-reset", {
        key: page.key,
        worldState: page.markers.worldState,
        worldId: page.markers.worldId,
      });
    }
    await notion.updateBlock(page.marker.id, { type: page.marker.type, text: resettingMarker(worldId) });
  }
}

async function clearWorldBlocks(notion, pages) {
  for (const page of pages) {
    for (const block of page.children) {
      if (block.id === page.marker.id) continue;
      await notion.archiveBlock(block.id);
    }
  }
}

async function markPagesEmpty(notion, pages) {
  for (const page of pages) {
    if (page.children.length !== 1 || page.children[0]?.id !== page.marker.id) {
      throw new ApiError(409, "Cannot mark a page EMPTY while world blocks remain", { key: page.key });
    }
    await notion.updateBlock(page.marker.id, { type: page.marker.type, text: emptyMarker() });
  }
}

async function readResetPages(notion, { snapshotDepth }) {
  return mapLimit(STATE_PAGE_KEYS, 2, async (key) => {
    const direct = await notion.getPageTree(WORLD_PAGE_IDS[key], {
      maxDepth: 0,
      maxNodes: MAX_SNAPSHOT_NODES,
      concurrency: 2,
      includePage: true,
    });
    const markerBlock = direct.children.find((block) => {
      const text = blockPlainText(block);
      return text.includes("WORLD_STATE") && text.includes("WORLD_ID") && MARKER_TYPES.has(block.type);
    });
    const markers = parseWorldMarkers(direct.children);
    if (!markerBlock || !markers.worldState || !markers.worldId) {
      throw new ApiError(409, "A fixed world page is missing an editable world-state marker", { key });
    }
    let deepChildren = direct.children;
    let page = direct.page;
    if (snapshotDepth > 0) {
      const deep = await notion.getPageTree(WORLD_PAGE_IDS[key], {
        maxDepth: snapshotDepth,
        maxNodes: MAX_SNAPSHOT_NODES,
        concurrency: 2,
        includePage: true,
      });
      deepChildren = deep.children;
      page = deep.page;
    }
    return {
      key,
      page,
      children: direct.children,
      deepChildren,
      markers,
      marker: { id: markerBlock.id, type: markerBlock.type },
    };
  });
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
      version: 3,
      schema: "SAVE_V3.2",
      updatedAt: timestamp,
      worldState: "EMPTY",
      worldId: EMPTY_WORLD_ID,
      simTick: 0,
      purgeId: lock.archiveId,
      events: [{
        timestamp,
        type: "world_archive_reset",
        summary: `Archived and reset ${input.expectedWorldId}`,
        worldId: input.expectedWorldId,
        archiveId: lock.archiveId,
      }],
    }, { message: `chore(world): archive and reset ${input.expectedWorldId}` });
    commits.memory = saved.commit?.sha;
  } catch (error) {
    errors.push({ target: "world/memory.json", message: error?.message || String(error) });
  }
  try {
    const saved = await github.putJson("world/cache.json", {
      version: 3,
      schema: "SAVE_V3.2",
      updatedAt: timestamp,
      worldState: "EMPTY",
      worldId: EMPTY_WORLD_ID,
      simTick: 0,
      lastSaveKey: null,
      archiveId: lock.archiveId,
      snapshot: null,
    }, { message: `chore(world): clear cache after archive ${input.expectedWorldId}` });
    commits.cache = saved.commit?.sha;
  } catch (error) {
    errors.push({ target: "world/cache.json", message: error?.message || String(error) });
  }
  return { status: errors.length ? "pending" : "complete", commits, errors };
}

function validateInput(input = {}) {
  if (input.confirmation !== "ARCHIVE_AND_RESET") {
    throw new ApiError(400, "confirmation must be exactly ARCHIVE_AND_RESET");
  }
  if (typeof input.expectedWorldId !== "string" || !/^W\d{8}-[0-9A-F]{8}$/.test(input.expectedWorldId)) {
    throw new ApiError(400, "expectedWorldId must be the exact active WORLD_ID");
  }
  if (typeof input.operationKey !== "string" || !/^[A-Za-z0-9._-]{8,120}$/.test(input.operationKey)) {
    throw new ApiError(400, "operationKey must be 8-120 characters of letters, digits, dot, underscore, or hyphen");
  }
}

function sameOperation(lock, input) {
  return lock?.expectedWorldId === input.expectedWorldId && lock?.operationKey === input.operationKey;
}

function resettingMarker(worldId) {
  return [
    `SAVE_SCHEMA_VERSION：SAVE_V3.2｜WORLD_STATE：RESETTING｜WORLD_ID：${worldId}`,
    "SIM_TICK：0｜狀態修訂：0｜RESET_LOCK：ARCHIVE_VERIFIED",
  ].join("\n");
}

function emptyMarker() {
  return [
    "SAVE_SCHEMA_VERSION：SAVE_V3.2｜WORLD_STATE：EMPTY｜WORLD_ID：PENDING",
    "SIM_TICK：0｜狀態修訂：0",
  ].join("\n");
}

function archiveIdFor(worldId, operationKey) {
  return `A-${worldId}-${simpleHash(operationKey).toUpperCase()}`;
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

