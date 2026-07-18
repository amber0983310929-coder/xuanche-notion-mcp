import test from "node:test";
import assert from "node:assert/strict";

import { archiveAndResetWorld } from "../src/archive-reset.js";
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

  function toBlocks(items) {
    return items.filter((item) => !item.archived).map((item) => {
      if (item.type === "child_page") return { id: item.id, type: "child_page", child_page: { title: item.title } };
      return block(item.id, item.type, item.text);
    });
  }

  const notion = {
    async getPageTree(pageId) {
      const page = pages.get(pageId);
      if (!page) throw new Error(`unknown page ${pageId}`);
      return { page: { id: pageId }, children: toBlocks(page.children) };
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
        return { id: blockId, archived: true };
      }
      throw new Error(`unknown block ${blockId}`);
    },
  };
  return { notion, pages, pageKeyById };
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

