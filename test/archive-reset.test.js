import test from "node:test";
import assert from "node:assert/strict";

import { archiveAndResetWorld } from "../src/archive-reset.js";
import {
  archiveAndVerifyStagedPage,
  beginStagedPageArchive,
  captureStagedPageBatch,
  clearStagedPage,
  clearStagedPageBatch,
  clearStagedWorldCache,
  finalizeStagedPageArchive,
  finalizeStagedArchiveReset,
  markStagedPageEmpty,
  markStagedPageResetting,
  prepareStagedArchiveReset,
  verifyStagedArchive,
} from "../src/archive-reset-staged.js";
import { STATE_PAGE_KEYS, WORLD_PAGE_IDS, parseWorldMarkers } from "../src/world-state.js";

const WORLD_ID = "W20260717-432D5443";

function block(id, type, text) {
  return {
    id,
    type,
    [type]: { rich_text: [{ plain_text: text, text: { content: text } }] },
  };
}

function createNotionMock({ failArchiveOnce = false } = {}) {
  const pages = new Map();
  const pageKeyById = new Map(STATE_PAGE_KEYS.map((key) => [WORLD_PAGE_IDS[key], key]));
  const stats = { listBlockChildren: [], archivedBlockIds: [] };
  let sequence = 0;
  let shouldFailArchive = failArchiveOnce;
  for (const key of STATE_PAGE_KEYS) {
    pages.set(WORLD_PAGE_IDS[key], {
      id: WORLD_PAGE_IDS[key],
      children: [
        { id: `${key}-marker`, type: "callout", text: `SAVE_SCHEMA_VERSION：SAVE_V3.2｜WORLD_STATE：ACTIVE｜WORLD_ID：${WORLD_ID}\nSIM_TICK：42｜狀態修訂：7` },
        { id: `${key}-world`, type: "paragraph", text: `${key} 的既有世界資料` },
      ],
    });
  }
  pages.set("home", { id: "home", children: [] });
  pages.set("route", { id: "route", children: [] });

  function toBlock(item) {
    if (item.type === "child_page") return { id: item.id, type: "child_page", child_page: { title: item.title } };
    return block(item.id, item.type, item.text);
  }

  function toBlocks(items) {
    return items.filter((item) => !item.archived).map(toBlock);
  }

  const notion = {
    async getPage(pageId) {
      if (!pages.has(pageId)) throw new Error(`unknown page ${pageId}`);
      return { id: pageId, object: "page" };
    },
    async getBlock(blockId) {
      for (const page of pages.values()) {
        const item = page.children.find((candidate) => candidate.id === blockId && !candidate.archived);
        if (item) return toBlock(item);
      }
      throw new Error(`unknown block ${blockId}`);
    },
    async listBlockChildren(pageId, { startCursor, pageSize = 100 } = {}) {
      const page = pages.get(pageId);
      if (!page) throw new Error(`unknown page ${pageId}`);
      const live = toBlocks(page.children);
      const offset = startCursor ? Number(String(startCursor).replace("cursor-", "")) : 0;
      const results = live.slice(offset, offset + pageSize);
      const nextOffset = offset + results.length;
      stats.listBlockChildren.push({ pageId, pageSize, startCursor: startCursor || null, resultCount: results.length });
      return {
        results,
        has_more: nextOffset < live.length,
        next_cursor: nextOffset < live.length ? `cursor-${nextOffset}` : null,
      };
    },
    async getPageTree(pageId, options = {}) {
      const page = pages.get(pageId);
      if (!page) throw new Error(`unknown page ${pageId}`);
      const maximum = Number(options.maxNodes || 5_000);
      const children = toBlocks(page.children).slice(0, maximum);
      return {
        page: options.includePage === false ? undefined : { id: pageId, object: "page" },
        children,
        meta: { truncated: children.length < toBlocks(page.children).length },
      };
    },
    async listAllBlockChildren(pageId) {
      const page = pages.get(pageId);
      if (!page) throw new Error(`unknown page ${pageId}`);
      return toBlocks(page.children);
    },
    async createChildPage(parentPageId, { title }) {
      const parent = pages.get(parentPageId);
      if (!parent) throw new Error(`unknown parent ${parentPageId}`);
      const id = `archive-${++sequence}`;
      parent.children.push({ id, type: "child_page", title });
      pages.set(id, { id, children: [] });
      return { id };
    },
    async appendBlocks(pageId, children) {
      const page = pages.get(pageId);
      const results = children.map((text) => {
        const id = `block-${++sequence}`;
        page.children.push({ id, type: "paragraph", text: String(text) });
        return { id };
      });
      return { results };
    },
    async updateBlock(blockId, input) {
      for (const page of pages.values()) {
        const item = page.children.find((candidate) => candidate.id === blockId);
        if (!item) continue;
        item.text = input.text;
        return { id: blockId };
      }
      throw new Error(`unknown block ${blockId}`);
    },
    async archiveBlock(blockId) {
      if (shouldFailArchive) {
        shouldFailArchive = false;
        throw new Error("simulated reset interruption");
      }
      for (const page of pages.values()) {
        const item = page.children.find((candidate) => candidate.id === blockId);
        if (!item) continue;
        item.archived = true;
        stats.archivedBlockIds.push(blockId);
        return { id: blockId, archived: true };
      }
      throw new Error(`unknown block ${blockId}`);
    },
  };
  return { notion, pages, pageKeyById, stats };
}

function createCache() {
  const records = new Map();
  return {
    kv: {},
    async get(key) { return records.get(key); },
    async put(key, value) { records.set(key, value); return value; },
    async delete(key) { records.delete(key); },
    async deletePrefix(prefix) {
      let count = 0;
      for (const key of [...records.keys()]) {
        if (!key.startsWith(prefix)) continue;
        records.delete(key);
        count += 1;
      }
      return count;
    },
  };
}

function input(operationKey = "archive-reset-test-001") {
  return { confirmation: "ARCHIVE_AND_RESET", expectedWorldId: WORLD_ID, operationKey };
}

test("archive-and-reset verifies every fixed page before clearing to EMPTY/PENDING", async () => {
  const { notion, pages } = createNotionMock();
  const cache = createCache();
  const result = await archiveAndResetWorld({ HOME_PAGE_ID: "home" }, input(), {
    notion,
    github: { configured: false },
    cache,
  });

  assert.equal(result.archived, true);
  assert.equal(result.reset, true);
  assert.equal(result.worldState, "EMPTY");
  assert.equal(result.previousWorldId, WORLD_ID);
  assert.equal(result.archive.sourcePages.length, STATE_PAGE_KEYS.length);
  assert.equal(await cache.get("world-reset:active"), undefined);

  for (const key of STATE_PAGE_KEYS) {
    const page = pages.get(WORLD_PAGE_IDS[key]);
    const live = page.children.filter((item) => !item.archived);
    assert.equal(live.length, 1);
    const markers = parseWorldMarkers([block(live[0].id, live[0].type, live[0].text)]);
    assert.equal(markers.worldState, "EMPTY");
    assert.equal(markers.worldId, "PENDING");
  }

  const archiveRoot = pages.get("home").children.find((item) => item.type === "child_page" && item.title === "世界封存庫");
  assert.ok(archiveRoot);
  const worldArchive = pages.get(archiveRoot.id).children.find((item) => item.type === "child_page");
  assert.ok(worldArchive);
  assert.equal(pages.get(worldArchive.id).children.filter((item) => item.type === "child_page").length, STATE_PAGE_KEYS.length);
});

test("an interrupted reset remains locked and safely resumes with the same operationKey", async () => {
  const { notion, pages } = createNotionMock({ failArchiveOnce: true });
  const cache = createCache();
  const deps = { notion, github: { configured: false }, cache };

  await assert.rejects(archiveAndResetWorld({ HOME_PAGE_ID: "home" }, input(), deps), /simulated reset interruption/);
  const lock = await cache.get("world-reset:active");
  assert.equal(lock.phase, "resetting");
  const marker = pages.get(WORLD_PAGE_IDS.save).children.find((item) => item.id === "save-marker");
  assert.match(marker.text, /WORLD_STATE：RESETTING/);

  const resumed = await archiveAndResetWorld({ HOME_PAGE_ID: "home" }, input(), deps);
  assert.equal(resumed.reset, true);
  assert.equal(resumed.worldState, "EMPTY");
});

test("archive-and-reset refuses a malformed confirmation before it writes", async () => {
  const { notion, pages } = createNotionMock();
  await assert.rejects(
    archiveAndResetWorld({ HOME_PAGE_ID: "home" }, { ...input(), confirmation: "RESET" }, {
      notion,
      github: { configured: false },
      cache: createCache(),
    }),
    /confirmation must be exactly ARCHIVE_AND_RESET/,
  );
  assert.match(pages.get(WORLD_PAGE_IDS.save).children[0].text, /WORLD_STATE：ACTIVE/);
});

test("a queued durable-workflow lock starts the archive instead of being treated as a completed archive", async () => {
  const { notion } = createNotionMock();
  const cache = createCache();
  await cache.put("world-reset:active", {
    phase: "queued",
    expectedWorldId: WORLD_ID,
    operationKey: "archive-reset-queued-001",
  });

  const result = await archiveAndResetWorld({ HOME_PAGE_ID: "home" }, input("archive-reset-queued-001"), {
    notion,
    github: { configured: false },
    cache,
  });

  assert.equal(result.archived, true);
  assert.equal(result.reset, true);
  assert.equal(result.worldState, "EMPTY");
});


test("staged archive uses independently resumable page checkpoints before reset", async () => {
  const { notion, pages } = createNotionMock();
  const cache = createCache();
  const deps = { notion, github: { configured: false }, cache };
  const env = { HOME_PAGE_ID: "home" };
  const request = input("archive-reset-staged-001");

  await prepareStagedArchiveReset(env, request, deps);
  for (const key of STATE_PAGE_KEYS) {
    await archiveAndVerifyStagedPage(env, request, key, deps);
  }
  const verified = await verifyStagedArchive(env, request, deps);
  assert.equal(verified.phase, "archive_verified");
  assert.equal(verified.archivedKeys.length, STATE_PAGE_KEYS.length);

  for (const key of STATE_PAGE_KEYS) {
    await markStagedPageResetting(env, request, key, deps);
    await clearStagedPage(env, request, key, deps);
    await markStagedPageEmpty(env, request, key, deps);
  }
  await clearStagedWorldCache(env, request, deps);
  const result = await finalizeStagedArchiveReset(env, request, deps);
  assert.equal(result.archived, true);
  assert.equal(result.reset, true);
  assert.equal(result.worldState, "EMPTY");
  assert.equal(await cache.get("world-reset:active"), undefined);
  for (const key of STATE_PAGE_KEYS) {
    const live = pages.get(WORLD_PAGE_IDS[key]).children.filter((item) => !item.archived);
    assert.equal(live.length, 1);
  }
});

test("a large fixed page is archived in cursor-checkpointed 100-block batches", async () => {
  const { notion, pages, stats } = createNotionMock();
  const key = "knowledge";
  pages.get(WORLD_PAGE_IDS[key]).children.push(
    ...Array.from({ length: 203 }, (_, index) => ({
      id: `${key}-extra-${index + 1}`,
      type: "paragraph",
      text: `large archive block ${index + 1}`,
    })),
  );
  const cache = createCache();
  const deps = { notion, github: { configured: false }, cache };
  const env = { HOME_PAGE_ID: "home" };
  const request = input("archive-reset-batched-page-001");

  await prepareStagedArchiveReset(env, request, deps);
  let state = await beginStagedPageArchive(env, request, key, deps);
  let captureCount = 0;
  while (!state.done) {
    state = await captureStagedPageBatch(env, request, key, deps);
    captureCount += 1;
  }
  const finalized = await finalizeStagedPageArchive(env, request, key, deps);
  const lock = await cache.get("world-reset:active");
  const stored = lock.archive.sourcePages.find((source) => source.key === key);

  assert.equal(captureCount, 3);
  assert.equal(state.batchIndex, 3);
  assert.equal(finalized.source.format, "XC_WORLD_ARCHIVE_V2");
  assert.equal(stored.batchCount, 3);
  assert.equal(lock.archivedKeys.includes(key), true);
  assert.deepEqual(
    stats.listBlockChildren.filter((call) => call.pageId === WORLD_PAGE_IDS[key]).map((call) => call.pageSize),
    [100, 100, 100],
  );
});

test("clearing a large fixed page archives at most 40 blocks per resumable step", async () => {
  const { notion, pages, stats } = createNotionMock();
  const key = "save";
  pages.get(WORLD_PAGE_IDS[key]).children.push(
    ...Array.from({ length: 73 }, (_, index) => ({
      id: `${key}-clear-${index + 1}`,
      type: "paragraph",
      text: `clear batch block ${index + 1}`,
    })),
  );
  const cache = createCache();
  const request = input("archive-reset-batched-clear-001");
  const deps = { notion, github: { configured: false }, cache };
  await cache.put("world-reset:active", {
    phase: "archive_verified",
    expectedWorldId: WORLD_ID,
    operationKey: request.operationKey,
    archive: { sourcePages: [] },
    archivedKeys: STATE_PAGE_KEYS,
  });

  await markStagedPageResetting({}, request, key, deps);
  const batchSizes = [];
  let state = { done: false };
  while (!state.done) {
    const before = stats.archivedBlockIds.length;
    state = await clearStagedPageBatch({}, request, key, deps);
    batchSizes.push(stats.archivedBlockIds.length - before);
  }
  await markStagedPageEmpty({}, request, key, deps);

  assert.equal(batchSizes.length, 2);
  assert.equal(Math.max(...batchSizes) <= 40, true);
  assert.equal(batchSizes.reduce((sum, value) => sum + value, 0), 74);
  const live = pages.get(WORLD_PAGE_IDS[key]).children.filter((item) => !item.archived);
  assert.equal(live.length, 1);
  assert.equal(parseWorldMarkers([block(live[0].id, live[0].type, live[0].text)]).worldState, "EMPTY");
});

test("a new workflow attempt trusts already verified V1 page checkpoints", async () => {
  const { notion, pages } = createNotionMock();
  const cache = createCache();
  const request = input("archive-reset-existing-checkpoints-001");
  const sourcePages = ["save", "character", "timeline"].map((key, index) => ({
    key,
    pageId: `existing-source-${index + 1}`,
    sha256: "a".repeat(64),
    bytes: 123,
  }));
  await cache.put("world-reset:active", {
    phase: "archiving",
    archiveId: "existing-archive",
    archivePageId: "existing-world-page",
    expectedWorldId: WORLD_ID,
    operationKey: request.operationKey,
    archive: { archiveId: "existing-archive", archivePageId: "existing-world-page", sourcePages },
    archivedKeys: sourcePages.map((source) => source.key),
  });
  const archiveChildrenBefore = [...pages.values()]
    .flatMap((page) => page.children)
    .filter((item) => item.type === "child_page").length;

  const state = await beginStagedPageArchive({}, request, "save", {
    notion, github: { configured: false }, cache,
  });

  assert.equal(state.done, true);
  const archiveChildrenAfter = [...pages.values()]
    .flatMap((page) => page.children)
    .filter((item) => item.type === "child_page").length;
  assert.equal(archiveChildrenAfter, archiveChildrenBefore);
});
