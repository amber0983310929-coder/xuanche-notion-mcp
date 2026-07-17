import test from "node:test";
import assert from "node:assert/strict";

import { initializeWorld } from "../src/initializer.js";
import { STATE_PAGE_KEYS, WORLD_PAGE_IDS, parseWorldMarkers } from "../src/world-state.js";

function block(id, type, text) {
  return {
    id,
    type,
    [type]: { rich_text: [{ plain_text: text, text: { content: text } }] },
  };
}

function createNotionMock({ failCommitKey } = {}) {
  const pages = new Map(STATE_PAGE_KEYS.map((key) => [key, {
    markerId: key + "-marker",
    markerText: "SAVE_SCHEMA_VERSION：SAVE_V3.2｜WORLD_STATE：EMPTY｜WORLD_ID：PENDING\nSIM_TICK：0｜狀態修訂：0",
    staged: [],
  }]));
  const keyByPageId = new Map(STATE_PAGE_KEYS.map((key) => [WORLD_PAGE_IDS[key], key]));
  const keyByMarkerId = new Map(STATE_PAGE_KEYS.map((key) => [key + "-marker", key]));
  const operations = [];
  let nextBlock = 1;

  const notion = {
    pages,
    operations,
    async getPageTree(pageId) {
      const key = keyByPageId.get(pageId);
      const page = pages.get(key);
      return {
        children: [
          block(page.markerId, "callout", page.markerText),
          ...page.staged.filter((item) => !item.archived).map((item) => block(item.id, "paragraph", item.text)),
        ],
      };
    },
    async appendBlocks(pageId, children) {
      const key = keyByPageId.get(pageId);
      const page = pages.get(key);
      const results = children.map((text) => {
        const item = { id: key + "-staged-" + nextBlock++, text: String(text), archived: false };
        page.staged.push(item);
        return { id: item.id };
      });
      operations.push({ operation: "append", key, count: results.length });
      return { results };
    },
    async updateBlock(markerId, input) {
      const key = keyByMarkerId.get(markerId);
      operations.push({ operation: "marker", key, text: input.text });
      if (key === failCommitKey && input.text.includes("WORLD_STATE：ACTIVE")) {
        throw new Error("simulated commit failure for " + key);
      }
      pages.get(key).markerText = input.text;
      return { id: markerId };
    },
    async archiveBlock(blockId) {
      for (const [key, page] of pages) {
        const item = page.staged.find((candidate) => candidate.id === blockId);
        if (!item) continue;
        item.archived = true;
        operations.push({ operation: "archive", key, blockId });
        return { id: blockId, archived: true };
      }
      throw new Error("unknown staged block " + blockId);
    },
  };
  return notion;
}

function input(saveKey = "INIT-TEST-001") {
  return {
    saveKey,
    character: {
      name: "徐青塵",
      gender: "男",
      age: 17,
      motivation: "守護重要的人",
      relationships: ["師父：待世界生成"],
    },
    opening: {
      location: "青石村",
      premise: "山雨欲來",
      choices: ["查看異象", "留在村中", "自由行動"],
    },
  };
}

function dependencies(notion) {
  return {
    notion,
    github: { configured: false },
    cache: { deletePrefix: async () => 2 },
  };
}

test("initialization stages every fixed page, activates save last, and validates readback", async () => {
  const notion = createNotionMock();
  const result = await initializeWorld({}, input(), dependencies(notion));

  assert.equal(result.initialized, true);
  assert.equal(result.idempotent, false);
  assert.equal(result.worldState, "ACTIVE");
  assert.match(result.worldId, /^W\d{8}-[0-9A-F]{8}$/);
  assert.deepEqual(result.validatedPageKeys, STATE_PAGE_KEYS);
  assert.deepEqual(result.cacheInvalidation, { status: "complete", entriesInvalidated: 2 });

  for (const page of notion.pages.values()) {
    const markers = parseWorldMarkers([block("marker", "callout", page.markerText)]);
    assert.equal(markers.worldState, "ACTIVE");
    assert.equal(markers.worldId, result.worldId);
    assert.ok(page.staged.some((item) => item.text === "SAVE_KEY：INIT-TEST-001"));
  }
  const commits = notion.operations.filter((item) => item.operation === "marker" && item.text.includes("WORLD_STATE：ACTIVE"));
  assert.equal(commits.at(-1).key, "save");
});

test("initialization refuses a mixed or non-empty preflight without writing", async () => {
  const notion = createNotionMock();
  notion.pages.get("events").markerText = "SAVE_SCHEMA_VERSION：SAVE_V3.2｜WORLD_STATE：ACTIVE｜WORLD_ID：W-OTHER";

  await assert.rejects(
    initializeWorld({}, input(), dependencies(notion)),
    /fully EMPTY\/PENDING state/,
  );
  assert.equal(notion.operations.length, 0);
});

test("a commit failure restores every marker and archives every staged block", async () => {
  const notion = createNotionMock({ failCommitKey: "save" });

  await assert.rejects(
    initializeWorld({}, input(), dependencies(notion)),
    (error) => {
      assert.equal(error.details.rolledBack, true);
      assert.match(error.details.cause, /simulated commit failure/);
      return true;
    },
  );

  for (const page of notion.pages.values()) {
    const markers = parseWorldMarkers([block("marker", "callout", page.markerText)]);
    assert.equal(markers.worldState, "EMPTY");
    assert.equal(markers.worldId, "PENDING");
    assert.equal(page.staged.every((item) => item.archived), true);
  }
});

test("retrying the same SAVE_KEY is idempotent and does not stage another world", async () => {
  const notion = createNotionMock();
  const first = await initializeWorld({}, input(), dependencies(notion));
  const operationsAfterFirst = notion.operations.length;
  const second = await initializeWorld({}, input(), dependencies(notion));

  assert.equal(second.idempotent, true);
  assert.equal(second.worldId, first.worldId);
  assert.equal(notion.operations.length, operationsAfterFirst);
});

test("SAVE_KEY rejects whitespace and line-break marker injection", async () => {
  const notion = createNotionMock();
  await assert.rejects(initializeWorld({}, input(" bad-key"), dependencies(notion)), /surrounding whitespace/);
  await assert.rejects(initializeWorld({}, input("bad\nWORLD_STATE：ACTIVE"), dependencies(notion)), /line breaks/);
  assert.equal(notion.operations.length, 0);
});
