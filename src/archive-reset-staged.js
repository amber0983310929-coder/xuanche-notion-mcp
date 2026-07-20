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

const BATCHED_ARCHIVE_SCHEMA = "XC_WORLD_ARCHIVE_V2";
const ARCHIVE_SCHEMA = BATCHED_ARCHIVE_SCHEMA;
const ARCHIVE_BATCH_SCHEMA = "XC_WORLD_ARCHIVE_BATCH_V1";
const EMPTY_WORLD_ID = "PENDING";
const ARCHIVE_ROOT_TITLE = "世界封存庫";
const MARKER_TYPES = new Set([
  "paragraph", "callout", "heading_1", "heading_2", "heading_3",
  "bulleted_list_item", "numbered_list_item", "quote", "toggle",
]);
const MAX_SNAPSHOT_NODES = 5_000;
const MAX_SNAPSHOT_CHARS = 1_500_000;
const SNAPSHOT_CHUNK_SIZE = 1_500;
const MARKER_SCAN_MAX_NODES = 100;
const ARCHIVE_PAGE_BATCH_SIZE = 100;
const MAX_ARCHIVE_BATCHES = Math.ceil(MAX_SNAPSHOT_NODES / ARCHIVE_PAGE_BATCH_SIZE);
const CLEAR_BATCH_SIZE = 30;
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

  const pages = await readMarkerPages(notion);
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
    ...lock,
    phase: "archiving",
    archiveId,
    archivePageId: worldPage.id,
    expectedWorldId: input.expectedWorldId,
    operationKey: input.operationKey,
    archive: { archiveId, archivePageId: worldPage.id, sourcePages },
    archivedKeys: [],
    archiveProgress: {},
    resetProgress: {},
    createdAt: lock?.createdAt || nowIso(),
  };
  await cache.put(ACTIVE_RESET_LOCK, lock, LOCK_TTL_SECONDS);
  return lock;
}

export async function archiveAndVerifyStagedPage(env, input, key, dependencies = {}) {
  let state = await beginStagedPageArchive(env, input, key, dependencies);
  let guard = 0;
  while (!state.done) {
    state = await captureStagedPageBatch(env, input, key, dependencies);
    guard += 1;
    if (guard > MAX_ARCHIVE_BATCHES) {
      throw new ApiError(422, "A fixed world page exceeds the archive batch safety limit", { key });
    }
  }
  return finalizeStagedPageArchive(env, input, key, dependencies);
}

/**
 * Creates (or resumes) a V2 archive source for one fixed page. The returned
 * cursor is persisted in KV, so each Workflow step needs to read at most one
 * 100-block Notion page.
 */
export async function beginStagedPageArchive(env, input, key, dependencies = {}) {
  assertStatePageKey(key);
  const { notion, cache } = runtime(env, dependencies);
  const lock = await requireLock(cache, input, ["archiving", "archive_verified", "resetting"]);
  if (lock.phase !== "archiving" || lock.archivedKeys?.includes(key)) {
    return { done: true, batchIndex: 0, key };
  }
  const existingProgress = lock.archiveProgress?.[key];
  if (existingProgress) return archiveProgressResult(key, existingProgress);

  const live = await readMarkerPage(notion, key, { includePage: true });
  assertActivePage(live, input.expectedWorldId);
  const sourceTitle = "存檔｜" + key + "｜batch-v2";
  const archiveChildren = await notion.listAllBlockChildren(lock.archivePageId, { maxNodes: 100 });
  let sourcePage = archiveChildren.find((block) =>
    block.type === "child_page" && block.child_page?.title === sourceTitle);
  if (!sourcePage) sourcePage = await notion.createChildPage(lock.archivePageId, { title: sourceTitle });

  const progress = {
    schema: BATCHED_ARCHIVE_SCHEMA,
    sourcePageId: sourcePage.id,
    capturedAt: nowIso(),
    page: live.page,
    batchIndex: 0,
    nextCursor: null,
    done: false,
    totalChars: 0,
    markerCount: 0,
    batches: [],
  };
  lock.archiveProgress = { ...(lock.archiveProgress || {}), [key]: progress };
  await cache.put(ACTIVE_RESET_LOCK, lock, LOCK_TTL_SECONDS);
  return archiveProgressResult(key, progress);
}

export async function captureStagedPageBatch(env, input, key, dependencies = {}) {
  assertStatePageKey(key);
  const { notion, cache } = runtime(env, dependencies);
  const lock = await requireLock(cache, input, ["archiving", "archive_verified", "resetting"]);
  if (lock.phase !== "archiving" || lock.archivedKeys?.includes(key)) {
    return { done: true, batchIndex: 0, key };
  }
  const progress = lock.archiveProgress?.[key];
  if (!progress) throw new ApiError(409, "Archive page batch checkpoint is missing", { key });
  if (progress.done) return archiveProgressResult(key, progress);
  if (progress.batchIndex >= MAX_ARCHIVE_BATCHES) {
    throw new ApiError(422, "A fixed world page exceeds the archive node safety limit", {
      key, maxSnapshotNodes: MAX_SNAPSHOT_NODES,
    });
  }

  // Recheck the authoritative marker before every immutable batch write. A
  // normal game write cannot race this operation because the durable lock is
  // already visible, while this also catches manual edits before reset begins.
  const live = await readMarkerPage(notion, key);
  assertActivePage(live, input.expectedWorldId);
  const listed = await notion.listBlockChildren(WORLD_PAGE_IDS[key], {
    startCursor: progress.nextCursor || undefined,
    pageSize: ARCHIVE_PAGE_BATCH_SIZE,
  });
  if (progress.batchIndex + 1 >= MAX_ARCHIVE_BATCHES && listed.has_more) {
    throw new ApiError(422, "A fixed world page exceeds the archive node safety limit", {
      key, maxSnapshotNodes: MAX_SNAPSHOT_NODES,
    });
  }

  const batchMarkerCount = countCanonicalMarkers(listed.results);
  for (const block of listed.results) {
    if (!isCanonicalMarker(block)) continue;
    const markers = parseWorldMarkers([block]);
    if (markers.worldState !== "ACTIVE" || markers.worldId !== input.expectedWorldId) {
      throw new ApiError(409, "A fixed page changed while its archive batches were being captured", {
        key, worldState: markers.worldState, worldId: markers.worldId,
      });
    }
  }

  const serialized = serializeBatch(lock, key, progress, listed);
  const nextTotal = progress.totalChars + serialized.length;
  if (nextTotal > MAX_SNAPSHOT_CHARS) {
    throw new ApiError(422, "A world page snapshot exceeds the archive safety limit", {
      key, maxSnapshotChars: MAX_SNAPSHOT_CHARS,
    });
  }
  const digest = await sha256Hex(serialized);
  const storedBatch = await writeAndVerifyBatch(notion, lock, key, progress, {
    serialized,
    sha256: digest,
    childCount: listed.results.length,
  });
  progress.batches.push(storedBatch);
  progress.totalChars = nextTotal;
  progress.markerCount += batchMarkerCount;
  progress.batchIndex += 1;
  progress.nextCursor = listed.has_more ? listed.next_cursor : null;
  progress.done = !listed.has_more;
  lock.archiveProgress[key] = progress;
  await cache.put(ACTIVE_RESET_LOCK, lock, LOCK_TTL_SECONDS);
  return archiveProgressResult(key, progress);
}

export async function finalizeStagedPageArchive(env, input, key, dependencies = {}) {
  assertStatePageKey(key);
  const { notion, cache } = runtime(env, dependencies);
  const lock = await requireLock(cache, input, ["archiving", "archive_verified", "resetting"]);
  if (lock.archivedKeys?.includes(key)) return { done: true, key };
  if (lock.phase !== "archiving") {
    throw new ApiError(409, "Cannot finalize a missing page archive after reset has started", { key });
  }
  const progress = lock.archiveProgress?.[key];
  if (!progress?.done || !progress.batches?.length) {
    throw new ApiError(409, "Archive page batches are incomplete", { key });
  }
  if (progress.markerCount !== 1) {
    throw new ApiError(409, "A fixed world page archive must contain exactly one canonical marker", {
      key, canonicalMarkerCount: progress.markerCount,
    });
  }
  if (progress.batches.some((batch, index) => batch.index !== index || !batch.sha256 || !batch.pageId)) {
    throw new ApiError(409, "Archive page batches are missing or out of order", { key });
  }

  const manifest = JSON.stringify({
    schema: BATCHED_ARCHIVE_SCHEMA,
    archiveId: lock.archiveId,
    worldId: lock.expectedWorldId,
    pageKey: key,
    pageId: WORLD_PAGE_IDS[key],
    capturedAt: progress.capturedAt,
    totalChars: progress.totalChars,
    batches: progress.batches,
  });
  const digest = await sha256Hex(manifest);
  await writeAndVerifyManifest(notion, progress.sourcePageId, digest, manifest);
  const stored = {
    key,
    pageId: progress.sourcePageId,
    sha256: digest,
    bytes: progress.totalChars,
    format: BATCHED_ARCHIVE_SCHEMA,
    batchCount: progress.batches.length,
  };
  await markArchived(cache, lock, key, stored);
  return { done: true, key, source: stored };
}

export async function verifyStagedArchive(env, input, dependencies = {}) {
  const { cache } = runtime(env, dependencies);
  const lock = await requireLock(cache, input, ["archiving", "archive_verified", "resetting"]);
  if (lock.phase !== "archiving") return lock;
  if (lock.archivedKeys?.length !== STATE_PAGE_KEYS.length) {
    throw new ApiError(409, "Archive is incomplete; not every fixed page has a verified checkpoint", {
      archivedKeys: lock.archivedKeys || [],
    });
  }

  for (const key of STATE_PAGE_KEYS) {
    const stored = lock.archive.sourcePages.find((item) => item.key === key);
    if (!stored?.pageId || !stored?.sha256 || !Number.isFinite(stored.bytes)) {
      throw new ApiError(409, "Archive is missing a verified fixed world page checkpoint", { key });
    }
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
  const page = await readMarkerPage(notion, key);
  if (page.markers.worldState === "EMPTY" && page.markers.worldId === EMPTY_WORLD_ID) {
    lock.resetProgress = {
      ...(lock.resetProgress || {}),
      [key]: { markerId: page.marker.id, markerType: page.marker.type },
    };
    await cache.put(ACTIVE_RESET_LOCK, lock, LOCK_TTL_SECONDS);
    return lock;
  }
  if (page.markers.worldState !== "RESETTING" || page.markers.worldId !== input.expectedWorldId) {
    assertActivePage(page, input.expectedWorldId);
    await notion.updateBlock(page.marker.id, { type: page.marker.type, text: resettingMarker(input.expectedWorldId) });
  }
  lock.resetProgress = {
    ...(lock.resetProgress || {}),
    [key]: { markerId: page.marker.id, markerType: page.marker.type },
  };
  if (lock.phase !== "resetting") {
    lock.phase = "resetting";
  }
  await cache.put(ACTIVE_RESET_LOCK, lock, LOCK_TTL_SECONDS);
  return lock;
}

export async function clearStagedPage(env, input, key, dependencies = {}) {
  let state = { done: false };
  let guard = 0;
  while (!state.done) {
    state = await clearStagedPageBatch(env, input, key, dependencies);
    guard += 1;
    if (guard > Math.ceil(MAX_SNAPSHOT_NODES / CLEAR_BATCH_SIZE) + 2) {
      throw new ApiError(422, "A fixed world page exceeds the reset node safety limit", { key });
    }
  }
  return state;
}

export async function clearStagedPageBatch(env, input, key, dependencies = {}) {
  assertStatePageKey(key);
  const { notion, cache } = runtime(env, dependencies);
  const lock = await requireLock(cache, input, ["resetting"]);
  const markerInfo = lock.resetProgress?.[key];
  if (!markerInfo?.markerId) {
    throw new ApiError(409, "Reset marker checkpoint is missing", { key });
  }
  const markerBlock = await notion.getBlock(markerInfo.markerId);
  const markers = parseWorldMarkers([markerBlock]);
  if (markers.worldState === "EMPTY" && markers.worldId === EMPTY_WORLD_ID) {
    const listed = await notion.listBlockChildren(WORLD_PAGE_IDS[key], { pageSize: 2 });
    if (listed.has_more || listed.results.length !== 1 || listed.results[0]?.id !== markerInfo.markerId) {
      throw new ApiError(409, "An EMPTY fixed page still contains world blocks", { key });
    }
    return { done: true, key, archived: 0 };
  }
  if (markers.worldState !== "RESETTING" || markers.worldId !== input.expectedWorldId) {
    throw new ApiError(409, "A fixed page changed during archive-and-reset", {
      key, worldState: markers.worldState, worldId: markers.worldId,
    });
  }

  // Always start at the first page after deletes. Cursors are intentionally
  // not reused because archiving blocks changes the collection being paged.
  const listed = await notion.listBlockChildren(WORLD_PAGE_IDS[key], { pageSize: CLEAR_BATCH_SIZE });
  const removable = listed.results.filter((block) => block.id !== markerInfo.markerId);
  for (const block of removable) {
    await notion.archiveBlock(block.id);
  }
  // If the marker is present and Notion reports no next page, every removable
  // block in this response has just been archived and the page is now clear.
  const done = !listed.has_more && listed.results.some((block) => block.id === markerInfo.markerId);
  return { done, key, archived: removable.length };
}

export async function markStagedPageEmpty(env, input, key, dependencies = {}) {
  assertStatePageKey(key);
  const { notion, cache } = runtime(env, dependencies);
  const lock = await requireLock(cache, input, ["resetting"]);
  const markerInfo = lock.resetProgress?.[key];
  if (!markerInfo?.markerId) throw new ApiError(409, "Reset marker checkpoint is missing", { key });
  const markerBlock = await notion.getBlock(markerInfo.markerId);
  const markers = parseWorldMarkers([markerBlock]);
  const listed = await notion.listBlockChildren(WORLD_PAGE_IDS[key], { pageSize: 2 });
  if (listed.has_more || listed.results.length !== 1 || listed.results[0]?.id !== markerInfo.markerId) {
    throw new ApiError(409, "Cannot mark a page EMPTY while world blocks remain", {
      key, remainingBlockCount: listed.results.length + (listed.has_more ? 1 : 0),
    });
  }
  if (markers.worldState === "EMPTY" && markers.worldId === EMPTY_WORLD_ID) return lock;
  if (markers.worldState !== "RESETTING" || markers.worldId !== input.expectedWorldId) {
    throw new ApiError(409, "A fixed page changed during archive-and-reset", {
      key, worldState: markers.worldState, worldId: markers.worldId,
    });
  }
  await notion.updateBlock(markerInfo.markerId, { type: markerInfo.markerType, text: emptyMarker() });
  return lock;
}

export async function clearStagedWorldCache(env, input, dependencies = {}) {
  let state = { done: false };
  let guard = 0;
  while (!state.done) {
    state = await clearStagedWorldCacheBatch(env, input, dependencies);
    guard += 1;
    if (guard > 100) throw new ApiError(422, "World cache exceeds the reset batch safety limit");
  }
  return state;
}

export async function clearStagedWorldCacheBatch(env, input, dependencies = {}) {
  const { cache } = runtime(env, dependencies);
  const lock = await requireLock(cache, input, ["resetting"]);
  const checkpoint = lock.cacheInvalidation || { prefix: "world:", deleted: 0, done: false };
  if (checkpoint.done) return { done: true, deleted: checkpoint.deleted };
  const batch = typeof cache.deletePrefixBatch === "function"
    ? await cache.deletePrefixBatch(checkpoint.prefix, { limit: 20 })
    : { deleted: await cache.deletePrefix(checkpoint.prefix), done: true };
  checkpoint.deleted += Number(batch.deleted || 0);
  checkpoint.done = batch.done === true;
  lock.cacheInvalidation = checkpoint;
  await cache.put(ACTIVE_RESET_LOCK, lock, LOCK_TTL_SECONDS);
  return { done: checkpoint.done, deleted: checkpoint.deleted };
}

export async function finalizeStagedArchiveReset(env, input, dependencies = {}) {
  const { notion, github, cache } = runtime(env, dependencies);
  const lock = await requireLock(cache, input, ["resetting"]);
  const pages = await readFinalPages(notion);
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

  if (lock.cacheInvalidation?.done !== true) {
    throw new ApiError(409, "World cache invalidation is not complete");
  }
  const cacheEntriesInvalidated = Number(lock.cacheInvalidation.deleted || 0);
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

async function readMarkerPages(notion) {
  return mapLimit(STATE_PAGE_KEYS, 2, (key) => readMarkerPage(notion, key));
}

async function readMarkerPage(notion, key, { includePage = false } = {}) {
  const tree = await notion.getPageTree(WORLD_PAGE_IDS[key], {
    maxDepth: 0,
    maxNodes: MARKER_SCAN_MAX_NODES,
    concurrency: 1,
    includePage,
    truncateAtMaxNodes: true,
  });
  const markerBlock = tree.children.find(isCanonicalMarker);
  const markers = parseWorldMarkers(tree.children);
  if (!markerBlock || !markers.worldState || !markers.worldId) {
    throw new ApiError(409, "A fixed world page is missing an editable world-state marker in its first 100 blocks", { key });
  }
  return {
    key,
    page: tree.page,
    children: tree.children,
    markers,
    marker: { id: markerBlock.id, type: markerBlock.type },
  };
}

async function readFinalPages(notion) {
  return mapLimit(STATE_PAGE_KEYS, 2, async (key) => {
    const listed = await notion.listBlockChildren(WORLD_PAGE_IDS[key], { pageSize: 2 });
    if (listed.has_more) {
      throw new ApiError(409, "A cleared fixed page still contains world blocks", { key });
    }
    const markerBlock = listed.results.find(isCanonicalMarker);
    const markers = parseWorldMarkers(listed.results);
    if (!markerBlock || !markers.worldState || !markers.worldId) {
      throw new ApiError(409, "A cleared fixed page is missing its canonical marker", { key });
    }
    return {
      key,
      children: listed.results,
      markers,
      marker: { id: markerBlock.id, type: markerBlock.type },
    };
  });
}

function assertActivePage(page, worldId) {
  if (page.markers.worldState !== "ACTIVE" || page.markers.worldId !== worldId) {
    throw new ApiError(409, "A fixed page changed during archive-and-reset", {
      key: page.key, worldState: page.markers.worldState, worldId: page.markers.worldId,
    });
  }
}

function serializeBatch(lock, key, progress, listed) {
  return JSON.stringify({
    schema: ARCHIVE_BATCH_SCHEMA,
    sourceSchema: BATCHED_ARCHIVE_SCHEMA,
    archiveId: lock.archiveId,
    worldId: lock.expectedWorldId,
    pageKey: key,
    pageId: WORLD_PAGE_IDS[key],
    capturedAt: progress.capturedAt,
    batchIndex: progress.batchIndex,
    startCursor: progress.nextCursor || null,
    nextCursor: listed.has_more ? listed.next_cursor : null,
    snapshot: {
      page: progress.batchIndex === 0 ? progress.page : null,
      children: listed.results,
    },
  });
}

async function writeAndVerifyBatch(notion, lock, key, progress, expected) {
  const index = progress.batchIndex;
  const titlePrefix = "存檔批次｜" + key + "｜" + String(index).padStart(4, "0") + "｜";
  const sourceChildren = await notion.listAllBlockChildren(progress.sourcePageId, { maxNodes: 200 });
  const candidates = sourceChildren.filter((block) =>
    block.type === "child_page" && String(block.child_page?.title || "").startsWith(titlePrefix));
  // A retry never appends to or repairs a previous attempt. Writing one new
  // immutable sibling keeps this invocation bounded even when the abandoned
  // attempt is large; only the sibling verified below enters the checkpoint.
  const attempt = candidates.length + 1;
  const page = await notion.createChildPage(progress.sourcePageId, {
    title: titlePrefix + attempt,
  });
  await appendTextBlocks(notion, page.id, [
    "XC_ARCHIVE_BATCH_SCHEMA：" + ARCHIVE_BATCH_SCHEMA,
    "XC_ARCHIVE_ID：" + lock.archiveId,
    "WORLD_ID：" + lock.expectedWorldId,
    "XC_ARCHIVE_SOURCE：" + key,
    "XC_ARCHIVE_BATCH_INDEX：" + index,
    "BATCH_SHA256：" + expected.sha256,
    "BATCH_CHARS：" + expected.serialized.length,
    ...chunkText(expected.serialized, SNAPSHOT_CHUNK_SIZE).map((chunk, chunkIndex) =>
      "XC_ARCHIVE_BATCH_CHUNK:" + key + ":" + index + ":" + chunkIndex + ":" + chunk),
  ]);
  await verifyStoredBatch(notion, page.id, lock, key, index, expected);
  return batchCheckpoint(index, page.id, expected);
}

async function verifyStoredBatch(notion, pageId, lock, key, index, expected) {
  const children = await notion.listAllBlockChildren(pageId, { maxNodes: 2_000 });
  const text = children.map(blockPlainText);
  const hash = marker(text.join("\n"), "BATCH_SHA256");
  const chunks = text
    .map((line) => /^XC_ARCHIVE_BATCH_CHUNK:([^:]+):(\d+):(\d+):(.*)$/s.exec(line))
    .filter(Boolean)
    .map((match) => ({
      key: match[1],
      batchIndex: Number(match[2]),
      chunkIndex: Number(match[3]),
      value: match[4],
    }))
    .filter((chunk) => chunk.key === key && chunk.batchIndex === index)
    .sort((a, b) => a.chunkIndex - b.chunkIndex);
  if (!hash || hash !== expected.sha256 || chunks.length === 0 ||
      chunks.some((chunk, chunkIndex) => chunk.chunkIndex !== chunkIndex)) {
    throw new ApiError(409, "Archive batch chunks are missing or out of order", { key, batchIndex: index });
  }
  const serialized = chunks.map((chunk) => chunk.value).join("");
  const actualHash = await sha256Hex(serialized);
  if (actualHash !== hash || serialized !== expected.serialized) {
    throw new ApiError(409, "Archive batch checksum mismatch", {
      key, batchIndex: index, expected: hash, actual: actualHash,
    });
  }
  let restored;
  try { restored = JSON.parse(serialized); } catch {
    throw new ApiError(409, "Archive batch JSON is not recoverable", { key, batchIndex: index });
  }
  if (
    restored?.schema !== ARCHIVE_BATCH_SCHEMA ||
    restored?.sourceSchema !== BATCHED_ARCHIVE_SCHEMA ||
    restored?.archiveId !== lock.archiveId ||
    restored?.worldId !== lock.expectedWorldId ||
    restored?.pageKey !== key ||
    restored?.pageId !== WORLD_PAGE_IDS[key] ||
    restored?.batchIndex !== index ||
    !Array.isArray(restored?.snapshot?.children)
  ) {
    throw new ApiError(409, "Archive batch identity did not match its fixed page", { key, batchIndex: index });
  }
  if (index === 0 && !restored.snapshot.page) {
    throw new ApiError(409, "The first archive batch does not contain the page snapshot", { key });
  }
}

async function writeAndVerifyManifest(notion, sourcePageId, digest, serialized) {
  let children = await notion.listAllBlockChildren(sourcePageId, { maxNodes: 500 });
  if (await hasVerifiedManifest(children, digest, serialized)) return;
  await appendTextBlocks(notion, sourcePageId, [
    "XC_ARCHIVE_MANIFEST_SHA256：" + digest,
    "XC_ARCHIVE_MANIFEST_CHARS：" + serialized.length,
    ...chunkText(serialized, SNAPSHOT_CHUNK_SIZE).map((chunk, index) =>
      "XC_ARCHIVE_MANIFEST_CHUNK:" + digest + ":" + index + ":" + chunk),
  ]);
  children = await notion.listAllBlockChildren(sourcePageId, { maxNodes: 500 });
  if (!(await hasVerifiedManifest(children, digest, serialized))) {
    throw new ApiError(409, "Archive manifest checksum mismatch");
  }
}

async function hasVerifiedManifest(children, digest, expected) {
  const text = children.map(blockPlainText);
  const declared = text.some((line) => marker(line, "XC_ARCHIVE_MANIFEST_SHA256") === digest);
  if (!declared) return false;
  const chunks = text
    .map((line) => /^XC_ARCHIVE_MANIFEST_CHUNK:([a-f0-9]+):(\d+):(.*)$/s.exec(line))
    .filter(Boolean)
    .filter((match) => match[1] === digest)
    .map((match) => ({ index: Number(match[2]), value: match[3] }))
    .sort((a, b) => a.index - b.index);
  if (!chunks.length || chunks.some((chunk, index) => chunk.index !== index)) return false;
  const serialized = chunks.map((chunk) => chunk.value).join("");
  return serialized === expected && await sha256Hex(serialized) === digest;
}

function batchCheckpoint(index, pageId, expected) {
  return {
    index,
    pageId,
    sha256: expected.sha256,
    chars: expected.serialized.length,
    childCount: expected.childCount,
  };
}

function archiveProgressResult(key, progress) {
  return {
    done: progress.done === true,
    batchIndex: Number(progress.batchIndex || 0),
    capturedBatches: progress.batches?.length || 0,
    key,
  };
}

function isCanonicalMarker(block) {
  if (!MARKER_TYPES.has(block?.type)) return false;
  const text = blockPlainText(block).trimStart();
  return text.startsWith("SAVE_SCHEMA_VERSION：") || text.startsWith("SAVE_SCHEMA_VERSION:");
}

function countCanonicalMarkers(blocks) {
  return blocks.filter(isCanonicalMarker).length;
}

async function markArchived(cache, lock, key, source) {
  const archived = new Set(lock.archivedKeys || []);
  archived.add(key);
  lock.archivedKeys = STATE_PAGE_KEYS.filter((candidate) => archived.has(candidate));
  const others = lock.archive.sourcePages.filter((item) => item.key !== key);
  lock.archive.sourcePages = [...others, source];
  if (lock.archiveProgress) delete lock.archiveProgress[key];
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
