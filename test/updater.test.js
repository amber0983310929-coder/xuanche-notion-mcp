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
