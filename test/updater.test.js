import test from "node:test";
import assert from "node:assert/strict";
import { updateWorld } from "../src/updater.js";

test("world update validates GitHub storage before mutating Notion", async () => {
  let notionWrites = 0;
  const notion = {
    appendBlocks: async () => {
      notionWrites += 1;
      return {};
    },
  };
  const github = { configured: false };

  await assert.rejects(
    updateWorld({}, {
      pageId: "11111111111111111111111111111111",
      children: ["save"],
      memoryEvent: "event",
    }, { notion, github }),
    /GitHub storage must be configured/,
  );
  assert.equal(notionWrites, 0);
});

test("world update invalidates every cached world profile", async () => {
  const invalidated = [];
  const result = await updateWorld({}, {
    pageId: "11111111111111111111111111111111",
    children: ["save"],
  }, {
    notion: { appendBlocks: async () => ({ results: [] }) },
    github: { configured: false },
    cache: {
      async deletePrefix(prefix) {
        invalidated.push(prefix);
        return 3;
      },
    },
  });

  assert.deepEqual(invalidated, ["world:"]);
  assert.equal(result.cacheEntriesInvalidated, 3);
});
