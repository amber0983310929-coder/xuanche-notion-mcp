import test from "node:test";
import assert from "node:assert/strict";
import { updateWorld } from "../src/updater.js";
import { WORLD_PAGE_IDS } from "../src/world-state.js";

function paragraph(text) {
  return { type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } };
}

function canonicalBlocks(worldState = "EMPTY", worldId = "PENDING") {
  return [
    paragraph("WORLD_STATE：" + worldState),
    paragraph("WORLD_ID：" + worldId),
    paragraph("SIM_TICK：0"),
    paragraph("狀態修訂：0"),
  ];
}

function validInput(overrides = {}) {
  return {
    pageId: WORLD_PAGE_IDS.save,
    saveKey: "TEST-SAVE-001",
    expectedWorldState: "EMPTY",
    expectedWorldId: "PENDING",
    expectedRevision: 0,
    children: ["save"],
    ...overrides,
  };
}

test("world update validates GitHub storage before mutating Notion", async () => {
  let notionReads = 0;
  const notion = {
    listAllBlockChildren: async () => {
      notionReads += 1;
      return canonicalBlocks();
    },
  };
  const github = { configured: false };

  await assert.rejects(
    updateWorld({}, validInput({ memoryEvent: "event" }), { notion, github }),
    /GitHub storage must be configured/,
  );
  assert.equal(notionReads, 0);
});

test("world update invalidates every cached world profile", async () => {
  const invalidated = [];
  const appended = [];
  const result = await updateWorld({}, validInput(), {
    notion: {
      listAllBlockChildren: async () => canonicalBlocks(),
      appendBlocks: async (pageId, children) => {
        appended.push({ pageId, children });
        return { results: [] };
      },
    },
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
  assert.equal(appended[0].children.at(-1), "SAVE_KEY：TEST-SAVE-001");
});

test("world update rejects pages outside the fixed write allowlist", async () => {
  await assert.rejects(
    updateWorld({}, validInput({ pageId: "11111111111111111111111111111111" }), {}),
    /write allowlist/,
  );
});

test("world update is idempotent when SAVE_KEY already exists", async () => {
  let writes = 0;
  const result = await updateWorld({}, validInput(), {
    notion: {
      listAllBlockChildren: async () => [...canonicalBlocks(), paragraph("SAVE_KEY：TEST-SAVE-001")],
      appendBlocks: async () => {
        writes += 1;
      },
    },
    github: { configured: false },
  });
  assert.equal(result.idempotent, true);
  assert.equal(writes, 0);
});

test("an idempotent retry repairs a missing GitHub mirror without rewriting Notion", async () => {
  let notionWrites = 0;
  let githubWrites = 0;
  const result = await updateWorld({}, validInput({ memoryEvent: "repair mirror" }), {
    notion: {
      listAllBlockChildren: async () => [...canonicalBlocks(), paragraph("SAVE_KEY：TEST-SAVE-001")],
      appendBlocks: async () => {
        notionWrites += 1;
      },
    },
    github: {
      configured: true,
      getJson: async () => ({ data: { version: 3, events: [] } }),
      putJson: async (path, value) => {
        githubWrites += 1;
        assert.equal(value.events[0].saveKey, "TEST-SAVE-001");
        return { commit: { sha: "mirror-repaired" } };
      },
    },
    cache: { deletePrefix: async () => 1 },
  });
  assert.equal(result.idempotent, true);
  assert.equal(result.memoryCommit, "mirror-repaired");
  assert.equal(notionWrites, 0);
  assert.equal(githubWrites, 1);
});

test("world update rejects stale world identity and revision", async () => {
  await assert.rejects(
    updateWorld({}, validInput(), {
      notion: { listAllBlockChildren: async () => canonicalBlocks("ACTIVE", "W-OTHER") },
      github: { configured: false },
    }),
    /World state changed/,
  );
});

test("block updates cannot cross fixed page boundaries", async () => {
  await assert.rejects(
    updateWorld({}, validInput({
      pageId: WORLD_PAGE_IDS.character,
      children: undefined,
      blockUpdates: [{
        blockId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        type: "paragraph",
        text: "new",
      }],
    }), {
      notion: {
        listAllBlockChildren: async (id) => id.replaceAll("-", "") === WORLD_PAGE_IDS.save
          ? canonicalBlocks()
          : [],
        getBlock: async () => ({
          id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          parent: { type: "page_id", page_id: WORLD_PAGE_IDS.save },
          type: "paragraph",
          paragraph: { rich_text: [{ plain_text: "old" }] },
        }),
      },
      github: { configured: false },
    }),
    /cannot cross fixed world-page boundaries/,
  );
});

test("a GitHub mirror failure does not undo the authoritative Notion write", async () => {
  const result = await updateWorld({}, validInput({ memoryEvent: "event" }), {
    notion: {
      listAllBlockChildren: async () => canonicalBlocks(),
      appendBlocks: async () => ({ results: [] }),
    },
    github: {
      configured: true,
      getJson: async () => {
        throw new Error("temporary GitHub outage");
      },
    },
    cache: { deletePrefix: async () => 1 },
  });
  assert.equal(result.githubSync.status, "pending");
  assert.match(result.githubSync.errors[0].message, /outage/);
  assert.equal(result.cacheEntriesInvalidated, 1);
});
