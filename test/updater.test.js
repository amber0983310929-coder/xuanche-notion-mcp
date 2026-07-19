import test from "node:test";
import assert from "node:assert/strict";
import { updateWorld } from "../src/updater.js";
import { WORLD_PAGE_IDS } from "../src/world-state.js";

function paragraph(text, id) {
  return { id, type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } };
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

test("world update invalidates only the changed page cache and legacy profiles", async () => {
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

  assert.deepEqual(invalidated, [
    "world:page:39fc8450-07ae-81f2-95ec-ef235d229ff2:",
    "world:v",
  ]);
  assert.equal(result.cacheEntriesInvalidated, 6);
  assert.equal(appended[0].children.at(-1), "SAVE_KEY：TEST-SAVE-001");
});

test("world update rejects pages outside the fixed write allowlist", async () => {
  await assert.rejects(
    updateWorld({}, validInput({ pageId: "11111111111111111111111111111111" }), {}),
    /write allowlist/,
  );
});

test("world update resolves pageKey and semantic block prefixes without caller-supplied Notion IDs", async () => {
  const updates = [];
  const blocks = canonicalBlocks("ACTIVE", "W20260719-12345678");
  blocks[2].id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const result = await updateWorld({}, validInput({
    pageId: undefined,
    pageKey: "save",
    expectedWorldState: "ACTIVE",
    expectedWorldId: "W20260719-12345678",
    children: ["turn"],
    blockUpdates: [{
      matchPrefix: "SIM_TICK：",
      type: "paragraph",
      text: "SIM_TICK：1",
      expectedText: "SIM_TICK：0",
    }],
  }), {
    notion: {
      listAllBlockChildren: async () => blocks,
      updateBlock: async (blockId, input) => {
        updates.push({ blockId, input });
        return { id: blockId };
      },
      appendBlocks: async () => ({ results: [] }),
    },
    github: { configured: false },
    cache: { deletePrefix: async () => 0 },
  });

  assert.equal(result.idempotent, false);
  assert.equal(updates[0].blockId, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  assert.equal(updates[0].input.text, "SIM_TICK：1");
});

test("legacy pageId 2 and malformed blockId fall back to the fixed save page and expected text", async () => {
  const updates = [];
  const blocks = canonicalBlocks("ACTIVE", "W20260719-12345678");
  blocks[2].id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await updateWorld({}, validInput({
    pageId: "2",
    expectedWorldState: "ACTIVE",
    expectedWorldId: "W20260719-12345678",
    children: ["turn"],
    blockUpdates: [{
      blockId: "2",
      type: "paragraph",
      text: "SIM_TICK：1",
      expectedText: "SIM_TICK：0",
    }],
  }), {
    notion: {
      listAllBlockChildren: async () => blocks,
      updateBlock: async (blockId) => {
        updates.push(blockId);
        return { id: blockId };
      },
      appendBlocks: async () => ({ results: [] }),
    },
    github: { configured: false },
    cache: { deletePrefix: async () => 0 },
  });

  assert.deepEqual(updates, ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"]);
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

test("same SAVE_KEY remains idempotent after the canonical revision advances", async () => {
  let writes = 0;
  const result = await updateWorld({}, validInput({
    expectedRevision: 0,
    expectedWorldState: "ACTIVE",
    expectedWorldId: "W20260719-12345678",
  }), {
    notion: {
      listAllBlockChildren: async () => {
        const blocks = canonicalBlocks("ACTIVE", "W20260719-12345678");
        blocks[3] = paragraph("狀態修訂：1");
        return [...blocks, paragraph("SAVE_KEY：TEST-SAVE-001")];
      },
      appendBlocks: async () => {
        writes += 1;
      },
    },
    github: { configured: false },
  });
  assert.equal(result.idempotent, true);
  assert.equal(writes, 0);
});

test("a retry repairs a response-lost block update without appending the turn twice", async () => {
  const blocks = canonicalBlocks("ACTIVE", "W20260719-12345678");
  blocks[3].id = "cccccccccccccccccccccccccccccccc";
  let appends = 0;
  let firstUpdate = true;
  const notion = {
    listAllBlockChildren: async () => blocks,
    appendBlocks: async (_pageId, children) => {
      appends += 1;
      blocks.push(paragraph(children.at(-1)));
      return { results: [] };
    },
    updateBlock: async (blockId, input) => {
      blocks[3] = paragraph(input.text, blockId);
      if (firstUpdate) {
        firstUpdate = false;
        throw new Error("response lost after commit");
      }
      return { id: blockId };
    },
  };
  const input = validInput({
    expectedWorldState: "ACTIVE",
    expectedWorldId: "W20260719-12345678",
    blockUpdates: [{
      matchPrefix: "狀態修訂：",
      type: "paragraph",
      text: "狀態修訂：1",
      expectedText: "狀態修訂：0",
    }],
  });

  await assert.rejects(updateWorld({}, input, {
    notion,
    github: { configured: false },
    cache: { deletePrefix: async () => 0 },
  }), /response lost/);
  const replay = await updateWorld({}, input, {
    notion,
    github: { configured: false },
    cache: { deletePrefix: async () => 0 },
  });

  assert.equal(replay.idempotent, true);
  assert.equal(appends, 1);
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
  assert.equal(result.cacheEntriesInvalidated, 2);
});

test("batched world update verifies the canonical save once", async () => {
  const reads = [];
  const appends = [];
  const result = await updateWorld({}, validInput({
    pageId: undefined,
    children: undefined,
    mutations: [
      { pageId: WORLD_PAGE_IDS.save, children: ["tick"] },
      { pageId: WORLD_PAGE_IDS.timeline, children: ["major event"] },
    ],
  }), {
    notion: {
      async listAllBlockChildren(pageId) {
        reads.push(pageId);
        return canonicalBlocks();
      },
      async appendBlocks(pageId, children) {
        appends.push({ pageId, children });
        return { results: [] };
      },
    },
    github: { configured: false },
    cache: { deletePrefix: async () => 0 },
  });

  assert.equal(reads.filter((pageId) => pageId.replaceAll("-", "") === WORLD_PAGE_IDS.save).length, 1);
  assert.equal(appends.length, 2);
  assert.equal(result.notion.mutations.length, 2);
});
