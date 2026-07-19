import assert from "node:assert/strict";
import test from "node:test";

import { commitTurn } from "../src/turn-commit.js";

function paragraph(id, text) {
  return { id, type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } };
}

function textOf(block) {
  return block?.[block.type]?.rich_text?.map((item) => item.plain_text ?? item.text?.content ?? "").join("") || "";
}

function activeBlocks() {
  return [
    paragraph("header", [
      "SAVE_SCHEMA_VERSION：SAVE_V3.2｜WORLD_STATE：ACTIVE｜WORLD_ID：W20260719-TEST0001",
      "SIM_TICK：16｜狀態修訂：17｜SAVE_KEY：turn-old",
    ].join("\n")),
    paragraph("world", "WORLD_ID：W20260719-TEST0001"),
    paragraph("tick", "SIM_TICK：16"),
    paragraph("revision", "狀態修訂：17"),
    paragraph("mainline", "當前主線：舊局勢。"),
  ];
}

function validInput(overrides = {}) {
  return {
    expectedWorldId: "W20260719-TEST0001",
    expectedSimTick: 16,
    expectedRevision: 17,
    actionKey: "11111111-2222-4333-8444-555555555555",
    playerAction: "先問清楚殘缺劍印的來歷。",
    narrative: "岩坪上的風從四人之間穿過。楚凌霄沒有急著起身，只將目光落在那枚殘缺劍印上，先問它為何值得斷嶽門連夜追入禁山。韓峻的劍鋒沒有移開，受傷劍修卻先笑了一聲。斗笠下的短弩微微偏轉，像是在衡量先射誰。片刻沉默後，劍修承認劍印並不完整，只能打開遺址外層的一道禁制；更深處還缺另一半鑰匙。",
    summary: "楚凌霄追問殘缺劍印，迫使雙方開始交換有限情報。",
    mainline: "楚凌霄在岩坪上追問殘缺劍印；韓峻與受傷劍修仍互相戒備，但開始交換有限情報。",
    visibleResult: "受傷劍修承認劍印只能開啟一部分遺址禁制。",
    visibleCost: "斗笠短弩手將楚凌霄視為可能影響談判的變數。",
    situation: "深夜，禁山半圓岩坪。四人仍處於互相牽制的談判局面。",
    choices: [
      { id: "press", label: "追問遺址位置", intent: "趁對方願意說話取得更多情報" },
      { id: "observe", label: "觀察韓峻反應", intent: "先判斷誰在隱瞞關鍵事實" },
      { id: "withdraw", label: "要求先處理傷勢", intent: "用合作作為交換條件" },
    ],
    facts: ["殘缺劍印只能開啟部分禁制"],
    playerState: {
      name: "楚凌霄",
      cultivation: "凡人，尚未引氣入體",
      body: "左踝重傷，右肩滲血，行動受限",
      equipment: "採藥短刀、兩片銀脈青葉、碎銀",
      location: "深夜禁山半圓岩坪",
      constraints: "左腕與韓峻腰間以布帶相連",
      abilities: "辨識草藥、熟悉山路、攀爬追蹤、簡單傷口處理；尚無神通法術",
    },
    ...overrides,
  };
}

function notionHarness(blocks, options = {}) {
  const operations = [];
  let failHeaderOnce = options.failHeaderOnce === true;
  return {
    operations,
    notion: {
      async listAllBlockChildren() {
        return blocks;
      },
      async updateBlock(id, input) {
        operations.push({ kind: "update", id, text: input.text });
        const index = blocks.findIndex((block) => block.id === id);
        blocks[index] = paragraph(id, input.text);
        if (id === "header" && failHeaderOnce) {
          failHeaderOnce = false;
          throw new Error("response lost after canonical commit");
        }
        return { id };
      },
      async appendBlocks(_pageId, children) {
        operations.push({ kind: "append", children });
        for (const [index, child] of children.entries()) {
          blocks.push(paragraph(`append-${operations.length}-${index}`, child));
        }
        return { results: [] };
      },
    },
  };
}

const cache = { deletePrefix: async () => 1 };
const github = { configured: false };

test("server-managed turn advances the canonical header before appending its event", async () => {
  const blocks = activeBlocks();
  const harness = notionHarness(blocks);
  const result = await commitTurn({}, validInput(), {
    notion: harness.notion,
    github,
    cache,
  });

  assert.equal(result.simTick, 17);
  assert.equal(result.revision, 18);
  assert.equal(result.idempotent, false);
  assert.equal(harness.operations[0].kind, "update");
  assert.equal(harness.operations[0].id, "header");
  assert.match(harness.operations[0].text, /SAVE_SCHEMA_VERSION：SAVE_V3\.3/);
  assert.match(harness.operations[0].text, /LAST_ACTION_KEY：11111111-/);
  assert.match(harness.operations[0].text, /PLAYER_STATE_V1：/);
  assert.deepEqual(result.playerState, validInput().playerState);
  assert.equal(harness.operations.at(-1).kind, "append");
  assert.ok(harness.operations.at(-1).children.some((text) => text.startsWith("TURN_ACTION_KEY：")));
  assert.ok(harness.operations.at(-1).children.some((text) => text.startsWith("主角狀態｜")));
  assert.equal(textOf(blocks.find((block) => block.id === "tick")), "SIM_TICK：17");
  assert.equal(textOf(blocks.find((block) => block.id === "revision")), "狀態修訂：18");
});

test("same actionKey safely replays after the canonical update response is lost", async () => {
  const blocks = activeBlocks();
  const harness = notionHarness(blocks, { failHeaderOnce: true });
  await assert.rejects(commitTurn({}, validInput(), {
    notion: harness.notion,
    github,
    cache,
  }), /response lost/);

  const replay = await commitTurn({}, validInput(), {
    notion: harness.notion,
    github,
    cache,
  });
  const appends = harness.operations.filter((operation) => operation.kind === "append");
  assert.equal(replay.idempotent, true);
  assert.equal(replay.simTick, 17);
  assert.equal(replay.revision, 18);
  assert.equal(appends.length, 1);
  assert.equal(textOf(blocks.find((block) => block.id === "mainline")), `當前主線：${validInput().mainline}`);
});

test("invalid mirror layout fails before the canonical header changes", async () => {
  const blocks = [...activeBlocks(), paragraph("second-mainline", "當前主線：重複局勢。")];
  const harness = notionHarness(blocks);
  await assert.rejects(commitTurn({}, validInput(), {
    notion: harness.notion,
    github,
    cache,
  }), /exactly one current mainline/);
  assert.equal(harness.operations.length, 0);
  assert.match(textOf(blocks[0]), /SIM_TICK：16/);
});

test("stale revision is rejected without writes", async () => {
  const blocks = activeBlocks();
  const harness = notionHarness(blocks);
  await assert.rejects(commitTurn({}, validInput({ expectedRevision: 16 }), {
    notion: harness.notion,
    github,
    cache,
  }), /World revision changed/);
  assert.equal(harness.operations.length, 0);
});

test("turn commit rejects a missing or malformed structured player state", async () => {
  const missing = validInput();
  delete missing.playerState;
  await assert.rejects(commitTurn({}, missing, { notion: {}, github, cache }), /playerState must be a structured object/);
  await assert.rejects(commitTurn({}, validInput({
    playerState: { ...validInput().playerState, body: "line one\nline two" },
  }), { notion: {}, github, cache }), /playerState\.body must be a single line/);
});
