import assert from "node:assert/strict";
import test from "node:test";

import { createSessionToken, verifySessionToken } from "../lib/auth.js";
import { buildTurnRequest, extractPartialJsonString } from "../lib/openai.js";
import { summarizeWorldSnapshot } from "../lib/world.js";
import { onRequest as sessionHandler } from "../functions/api/session.js";
import { onRequest as turnHandler } from "../functions/api/game/turn.js";

function paragraph(text) {
  return { type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } };
}

function snapshot() {
  return {
    loadedAt: "2026-07-19T13:00:00.000Z",
    meta: {
      cache: "hit",
      world: {
        worldState: "ACTIVE",
        worldId: "W20260719-TEST0001",
        simTick: 16,
        revision: 17,
      },
    },
    pages: [
      {
        key: "save",
        title: "02｜現行世界存檔",
        children: [
          paragraph("SAVE_SCHEMA_VERSION：SAVE_V3.2｜WORLD_STATE：ACTIVE｜WORLD_ID：W20260719-TEST0001\nSIM_TICK：16｜狀態修訂：17"),
          paragraph("當前主線：楚凌霄與三名修士在岩坪上互相牽制。"),
          paragraph("初始位置：禁山"),
          paragraph("當前位置與局勢｜村西廢棄石窯"),
          paragraph("當前位置與局勢｜深夜禁山半圓岩坪"),
          paragraph("VOID｜這一行不能進入模型上下文"),
        ],
      },
      {
        key: "character",
        title: "03｜主角與角色資料",
        children: [
          paragraph("姓名：楚凌霄"),
          paragraph("年齡：16歲"),
          paragraph("外貌：身形修長，衣著樸素，目光敏銳。"),
          paragraph("身世背景：山村採藥少年，尚未踏入修行。"),
          paragraph("座右銘：山路再險，也要看清下一步。"),
          paragraph("玩家已知能力：辨識草藥、熟悉山路、攀爬追蹤、簡單傷口處理。"),
          paragraph("楚凌霄左踝重傷，右肩滲血。"),
        ],
      },
    ],
  };
}

test("signed owner sessions reject tampering and expiry", async () => {
  const token = await createSessionToken({ version: 1, subject: "owner", expiresAt: 2_000 }, "secret");
  assert.equal(await verifySessionToken(token, "secret", 1_999), true);
  assert.equal(await verifySessionToken(token, "secret", 2_000), false);
  assert.equal(await verifySessionToken(`${token}x`, "secret", 1_999), false);
});

test("login creates an HttpOnly strict session cookie", async () => {
  const env = { PWA_ACCESS_KEY: "moon-gate", PWA_SESSION_SECRET: "session-secret" };
  const response = await sessionHandler({
    request: new Request("https://game.example/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://game.example" },
      body: JSON.stringify({ passphrase: "moon-gate" }),
    }),
    env,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /__Host-xuanche_session=/);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(response.headers.get("set-cookie"), /SameSite=Strict/);
});

test("partial function argument parser streams escaped narrative text", () => {
  const partial = extractPartialJsonString('{"narrative":"山風掠過\\n岩坪，楚凌霄', "narrative");
  assert.equal(partial.value, "山風掠過\n岩坪，楚凌霄");
  assert.equal(partial.complete, false);
  const complete = extractPartialJsonString('{"narrative":"他說：\\"先停手。\\"","summary":"x"}', "narrative");
  assert.equal(complete.value, '他說："先停手。"');
  assert.equal(complete.complete, true);
});

test("OpenAI request forces one strict server commit tool", () => {
  const world = { state: summarizeWorldSnapshot(snapshot()), text: "世界資料" };
  const request = buildTurnRequest({
    env: {},
    worldContext: world,
    playerAction: "追問劍印。",
    style: "austere",
    length: "brief",
  });
  assert.equal(request.model, "gpt-5.6-terra");
  assert.deepEqual(request.tool_choice, { type: "function", name: "commit_turn" });
  assert.equal(request.parallel_tool_calls, false);
  assert.equal(request.tools[0].strict, true);
  assert.equal(request.tools[0].parameters.additionalProperties, false);
  assert.deepEqual(request.tools[0].parameters.required, [
    "narrative", "summary", "mainline", "visibleResult", "visibleCost",
    "situation", "choices", "facts", "playerState",
  ]);
  assert.deepEqual(request.tools[0].parameters.properties.playerState.required, [
    "name", "cultivation", "body", "equipment", "location", "constraints", "abilities",
  ]);
});

test("world summary exposes profile and marks a legacy player state for calibration", () => {
  const state = summarizeWorldSnapshot(snapshot());
  assert.equal(state.profile.name, "楚凌霄");
  assert.equal(state.profile.age, "16歲");
  assert.equal(state.profile.portrait, "/images/chulingxiao-v1.webp");
  assert.equal(state.situation, "深夜禁山半圓岩坪");
  assert.equal(state.playerState.calibrated, false);
  assert.match(state.playerState.abilities, /辨識草藥/);
});

test("world summary returns a committed canonical player state as calibrated", () => {
  const source = snapshot();
  source.meta.world.playerState = {
    name: "楚凌霄",
    cultivation: "凡人，尚未引氣",
    body: "左踝重傷",
    equipment: "採藥短刀",
    location: "禁山岩坪",
    constraints: "行動不便",
    abilities: "辨識草藥；尚無神通",
  };
  const state = summarizeWorldSnapshot(source);
  assert.equal(state.playerState.calibrated, true);
  assert.equal(state.playerState.equipment, "採藥短刀");
});

test("PWA turn streams narrative and commits through the bound engine", async () => {
  const narrative = "山風貼著岩坪刮過，將四人之間的沉默磨得更薄。楚凌霄沒有去看韓峻的劍，只盯著受傷劍修袖口露出的殘印，問那東西究竟能打開什麼。斗笠人的弩口先移了半寸，韓峻才冷聲叫他別碰不該碰的事。受傷劍修卻笑了，承認劍印只夠開啟遺址外層禁制，並故意沒有說另一半在誰手裡。這一句話讓韓峻握劍的指節緊了起來。";
  const generated = {
    narrative,
    summary: "楚凌霄追問劍印，迫使雙方透露遺址禁制的有限情報。",
    mainline: "岩坪談判繼續；楚凌霄得知殘缺劍印只能開啟遺址外層禁制，另一半去向仍未知。",
    visibleResult: "受傷劍修承認劍印與一處遺址禁制有關。",
    visibleCost: "韓峻更警惕楚凌霄介入此事。",
    situation: "深夜禁山岩坪，四人仍互相牽制，談判尚未破裂。",
    choices: [
      { id: "ask", label: "追問另一半劍印", intent: "繼續施壓取得情報" },
      { id: "watch", label: "觀察韓峻", intent: "判斷他隱瞞了什麼" },
    ],
    facts: ["殘缺劍印只能開啟遺址外層禁制"],
    playerState: {
      name: "楚凌霄",
      cultivation: "凡人，尚未引氣入體",
      body: "左踝重傷，右肩滲血",
      equipment: "採藥短刀、兩片銀脈青葉",
      location: "深夜禁山岩坪",
      constraints: "行動不便，受三名修士牽制",
      abilities: "辨識草藥、熟悉山路、攀爬追蹤；尚無神通法術",
    },
  };
  const args = JSON.stringify(generated);
  const split = Math.floor(args.length / 2);
  const openAiEvents = [
    { type: "response.function_call_arguments.delta", delta: args.slice(0, split) },
    { type: "response.function_call_arguments.delta", delta: args.slice(split) },
    { type: "response.function_call_arguments.done", arguments: args },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";

  const originalFetch = globalThis.fetch;
  let openAiRequest;
  globalThis.fetch = async (_url, options) => {
    openAiRequest = JSON.parse(options.body);
    return new Response(openAiEvents, { headers: { "content-type": "text/event-stream" } });
  };
  let committedInput;
  const env = {
    OPENAI_API_KEY: "test-openai",
    XUANCHE_API_KEY: "engine-key",
    PWA_SESSION_SECRET: "session-secret",
    XUANCHE_ENGINE: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/world/load") return Response.json({ ok: true, data: snapshot() });
        if (path === "/world/turn/commit") {
          committedInput = await request.json();
          return Response.json({
            ok: true,
            data: {
              committed: true,
              worldId: committedInput.expectedWorldId,
              simTick: 17,
              revision: 18,
              actionKey: committedInput.actionKey,
              choices: committedInput.choices,
              playerState: committedInput.playerState,
            },
          });
        }
        return Response.json({ ok: false, error: "unexpected" }, { status: 404 });
      },
    },
  };
  const tasks = [];
  try {
    const sessionToken = await createSessionToken({
      version: 1,
      subject: "owner",
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    }, "session-secret");
    const response = await turnHandler({
      request: new Request("https://game.example/api/game/turn", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://game.example",
          cookie: `__Host-xuanche_session=${sessionToken}`,
        },
        body: JSON.stringify({
          action: "追問劍印能打開什麼。",
          actionKey: "11111111-2222-4333-8444-555555555555",
          expectedWorldId: "W20260719-TEST0001",
          expectedSimTick: 16,
          expectedRevision: 17,
          style: "immersive",
          length: "standard",
        }),
      }),
      env,
      waitUntil(promise) { tasks.push(promise); },
    });
    assert.equal(response.status, 200);
    const streamText = await response.text();
    await Promise.all(tasks);
    assert.match(streamText, /event: delta/);
    assert.match(streamText, /event: checkpoint/);
    assert.match(streamText, /event: committed/);
    assert.match(streamText, /event: done/);
    assert.equal(committedInput.expectedSimTick, 16);
    assert.equal(committedInput.narrative, narrative);
    assert.deepEqual(committedInput.playerState, generated.playerState);
    assert.equal(openAiRequest.model, "gpt-5.6-terra");
    assert.equal(openAiRequest.tools[0].strict, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
