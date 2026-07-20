import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createSessionToken, verifySessionToken } from "../lib/auth.js";
import { buildTurnRequest, extractPartialJsonString, normalizeGeneratedTurn } from "../lib/openai.js";
import { buildModelWorldContext, summarizeWorldSnapshot } from "../lib/world.js";
import { onRequest as archiveHandler } from "../functions/api/game/archive.js";
import { onRequest as archiveStatusHandler } from "../functions/api/game/archive/status.js";
import { onRequest as initializeHandler } from "../functions/api/game/initialize.js";
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

test("PWA shell exposes continue plus three guarded world-management actions", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/app.css", import.meta.url), "utf8");
  assert.match(html, /id="continue-game-button"/);
  assert.match(html, /id="world-control-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="operation-confirmation-field"[^>]*for="operation-confirmation"/);
  assert.match(html, /id="new-game-button"[^>]*>新的遊戲/);
  assert.match(html, /id="restart-game-button"[^>]*>重新遊戲/);
  assert.match(html, /id="reset-world-button"[^>]*>重置世界/);
  assert.doesNotMatch(html, /id="(?:new-game|restart-game|reset-world)-button"[^>]*\sdisabled/);
  assert.match(html, /id="world-operation-dialog"/);
  assert.match(html, /id="character-dialog"/);
  assert.match(html, /id="handbook-dialog"/);
  assert.match(html, /id="mobile-nav"/);
  assert.match(html, /aria-label="角色與世界狀態儀表板"/);
  assert.match(html, /id="status-panel-player" class="status-panel"/);
  assert.match(html, /id="status-panel-world" class="status-panel"/);
  assert.match(html, /class="constraints-state"/);
  assert.match(html, /data-mobile-target="player"[^>]*><span[^>]*>態<\/span>狀態<\/button>/);
  assert.match(html, /id="turn-change-template"/);
  assert.match(html, /id="character-quick-rail"/);
  assert.match(html, /id="quick-mainline"/);
  assert.equal((html.match(/data-character-target=/g) || []).length, 13);
  assert.match(html, /data-character-target="name"/);
  assert.match(html, /data-character-target="premise"/);
  assert.match(html, /每一欄都能從範例快速帶入/);
  assert.match(app, /typedConfirmation/);
  assert.match(app, /xuanche:pwa:world-operation:v1/);
  assert.match(app, /buildCommittedSummary/);
  assert.match(app, /committedSummary/);
  assert.match(app, /function applyCharacterPreset/);
  assert.match(app, /xuanche:pwa:draft:v1/);
  assert.match(app, /function createNarrativeWriter/);
  assert.match(app, /requestAnimationFrame\(commitPending\)/);
  assert.match(app, /function hydrateCachedState/);
  assert.match(app, /function repairLocalProtagonistIdentity/);
  assert.match(app, /turn\?\.actionKey !== game\.state\.lastActionKey/);
  assert.match(app, /key === "action" \? item : replaceLegacyIdentity/);
  assert.match(app, /document\.createDocumentFragment\(\)/);
  assert.match(app, /window\.history\.scrollRestoration = "manual"/);
  assert.match(app, /function scheduleCurrentTurnNavigation/);
  assert.match(app, /function currentTurnTarget/);
  assert.match(app, /target\.scrollIntoView\(\{ behavior: "auto", block: "start" \}\)/);
  assert.match(app, /function fitStateCards/);
  assert.match(app, /function openAppDialog/);
  assert.match(app, /function closeAppDialog/);
  assert.match(app, /function setOperationConfirmationVisible/);
  assert.doesNotMatch(app, /operationConfirmation\.closest\("label"\)/);
  assert.match(app, /function createUuid/);
  assert.match(app, /目前正在「\$\{activity\}」；完成後即可管理世界/);
  assert.match(app, /classList\.toggle\("state-card-wide", needsMoreRoom\)/);
  assert.doesNotMatch(app, /behavior:\s*["']smooth["']/);
  assert.match(app, /handbookDirty/);
  assert.match(app, /setAttribute\("aria-busy"/);
  assert.match(html, /行動草稿會自動保留/);
  assert.match(css, /@media \(min-width: 1550px\)/);
  assert.match(css, /grid-template-columns: minmax\(240px, 280px\) minmax\(380px, 440px\) minmax\(0, 860px\)/);
  assert.match(css, /\.world-panel\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(css, /\.state-list \.state-card-wide\s*\{\s*grid-column:\s*1 \/ -1/);
  assert.match(css, /html\s*\{[^}]*scroll-behavior:\s*auto/s);
  const decisionRule = css.match(/(?:^|\n)\.decision-area\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(decisionRule, /position:\s*static/);
  assert.doesNotMatch(decisionRule, /position:\s*sticky/);
});

test("PWA service worker keeps navigation fresh and returns cached shell assets immediately", async () => {
  const worker = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(worker, /xuanche-pwa-v0\.6\.0-combat-v5-identity-v1/);
  assert.match(worker, /request\.mode === "navigate"/);
  assert.match(worker, /networkFirst\(request, "\/index\.html"\)/);
  assert.match(worker, /staleWhileRevalidate\(event, request\)/);
  assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(worker, /response\.type !== "opaque"/);
});

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

test("custom protagonist identity is injected into every turn and obsolete names fail closed", () => {
  const source = snapshot();
  source.pages.find((page) => page.key === "character").children = [
    paragraph("name：沐聽雨"),
    paragraph("age：16歲"),
  ];
  source.meta.world.playerState = {
    name: "楚凌霄",
    cultivation: "凡人",
    body: "健康",
    equipment: "短弓",
    location: "山村",
    constraints: "家人受威脅",
    abilities: "狩獵射術",
  };
  const world = { state: summarizeWorldSnapshot(source), text: "世界資料" };
  const request = buildTurnRequest({
    env: {},
    worldContext: world,
    playerAction: "繼續觀察。",
    style: "immersive",
    length: "brief",
  });
  assert.match(request.instructions, /權威主角姓名是 "沐聽雨"/);
  assert.match(request.instructions, /玩家只控制沐聽雨/);
  assert.match(request.instructions, /楚凌霄.*不屬於本世界/);

  const generated = {
    narrative: "沐聽雨穩住呼吸，沿著門框的陰影觀察青袍修士握符的手勢，沒有讓弓弦發出第二聲震鳴。院內家人的腳步仍在，對方右腕的箭傷也未止血，僵局尚未解除。",
    summary: "沐聽雨保持距離，確認敵我狀態。",
    mainline: "沐聽雨仍在院外牽制受傷的青袍修士，家人尚未脫離威脅。",
    visibleResult: "確認敵人右腕仍受箭傷影響。",
    visibleCost: "雙方僵持持續，家人仍受威脅。",
    situation: "山村自家庭院外，雙方隔著門前空地互相牽制。",
    choices: [
      { id: "hold", label: "繼續牽制", intent: "等待敵人露出破綻" },
      { id: "call", label: "出聲警告", intent: "迫使敵人分心" },
    ],
    facts: ["敵人右腕箭傷仍在流血"],
    playerState: {
      name: "沐聽雨",
      cultivation: "凡人",
      body: "健康",
      equipment: "短弓、獵箭19支",
      location: "山村自家庭院外",
      constraints: "家人受門前修真者威脅",
      abilities: "狩獵射術",
    },
  };
  assert.equal(normalizeGeneratedTurn(generated, "沐聽雨").playerState.name, "沐聽雨");
  assert.throws(() => normalizeGeneratedTurn({
    ...generated,
    summary: "楚凌霄保持距離。",
  }, "沐聽雨"), /混入舊角色姓名/);
  assert.throws(() => normalizeGeneratedTurn({
    ...generated,
    playerState: { ...generated.playerState, name: "楚凌霄" },
  }, "沐聽雨"), /主角姓名不符/);
});

test("COMBAT_V5 content is included in the mandatory model context", () => {
  const source = snapshot();
  source.pages.push({
    key: "combat",
    title: "16｜戰鬥、難度與公平性",
    children: [paragraph("COMBAT_RULE_VERSION：COMBAT_V5｜Exceptional, Traceable, Consequential")],
  });
  const context = buildModelWorldContext(source);
  assert.match(context.text, /COMBAT_RULE_VERSION：COMBAT_V5/);
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

test("world summary exposes a safe EMPTY/PENDING state without inventing a protagonist", () => {
  const source = snapshot();
  source.meta.world = {
    worldState: "EMPTY",
    worldId: "PENDING",
    simTick: 0,
    revision: 0,
  };
  const state = summarizeWorldSnapshot(source);
  assert.equal(state.empty, true);
  assert.equal(state.worldState, "EMPTY");
  assert.equal(state.worldId, "PENDING");
  assert.equal(state.profile, null);
  assert.equal(state.playerState, null);
});

test("world summary reads initializer English character keys for custom protagonists", () => {
  const source = snapshot();
  source.pages.find((page) => page.key === "character").children = [
    paragraph("name：沈青禾"),
    paragraph("age：19歲"),
    paragraph("appearance：青衣負笛，神色沉靜。"),
    paragraph("background：自河港小城而來。"),
    paragraph("motivation：找回失散的師父。"),
    paragraph("equipment：短笛、舊斗篷"),
    paragraph("玩家已知能力：辨音、泅水"),
  ];
  const state = summarizeWorldSnapshot(source);
  assert.equal(state.profile.name, "沈青禾");
  assert.equal(state.profile.age, "19歲");
  assert.equal(state.profile.portrait, null);
  assert.equal(state.playerState.equipment, "短笛、舊斗篷");
});

test("PWA archive endpoint injects the only accepted destructive confirmation", async () => {
  const sessionToken = await createSessionToken({
    version: 1,
    subject: "owner",
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
  }, "session-secret");
  let forwarded;
  const env = {
    XUANCHE_API_KEY: "engine-key",
    PWA_SESSION_SECRET: "session-secret",
    XUANCHE_ENGINE: {
      async fetch(request) {
        forwarded = {
          path: new URL(request.url).pathname,
          apiKey: request.headers.get("x-api-key"),
          body: await request.json(),
        };
        return Response.json({
          ok: true,
          data: { accepted: true, workflowStatus: "queued", worldState: "ARCHIVING" },
        }, { status: 202 });
      },
    },
  };
  const response = await archiveHandler({
    request: new Request("https://game.example/api/game/archive", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://game.example",
        cookie: `__Host-xuanche_session=${sessionToken}`,
      },
      body: JSON.stringify({
        mode: "restart_game",
        expectedWorldId: "W20260719-AABB0001",
        operationKey: "pwa-world-operation-001",
        typedConfirmation: "重新開始",
        confirmation: "UNTRUSTED_CLIENT_VALUE",
      }),
    }),
    env,
  });
  assert.equal(response.status, 202);
  assert.equal(forwarded.path, "/world/archive-reset");
  assert.equal(forwarded.apiKey, "engine-key");
  assert.deepEqual(forwarded.body, {
    confirmation: "ARCHIVE_AND_RESET",
    expectedWorldId: "W20260719-AABB0001",
    operationKey: "pwa-world-operation-001",
  });
});

test("PWA archive endpoint rejects an omitted typed confirmation before reaching the engine", async () => {
  const sessionToken = await createSessionToken({
    version: 1,
    subject: "owner",
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
  }, "session-secret");
  let called = false;
  const response = await archiveHandler({
    request: new Request("https://game.example/api/game/archive", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://game.example",
        cookie: `__Host-xuanche_session=${sessionToken}`,
      },
      body: JSON.stringify({
        mode: "reset_world",
        expectedWorldId: "W20260719-AABB0001",
        operationKey: "pwa-world-operation-003",
      }),
    }),
    env: {
      XUANCHE_API_KEY: "engine-key",
      PWA_SESSION_SECRET: "session-secret",
      XUANCHE_ENGINE: { async fetch() { called = true; } },
    },
  });
  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test("PWA archive status reads only the matching durable operation", async () => {
  const sessionToken = await createSessionToken({
    version: 1,
    subject: "owner",
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
  }, "session-secret");
  let receivedUrl;
  const env = {
    XUANCHE_API_KEY: "engine-key",
    PWA_SESSION_SECRET: "session-secret",
    XUANCHE_ENGINE: {
      async fetch(request) {
        receivedUrl = new URL(request.url);
        return Response.json({ ok: true, data: { accepted: true, workflowStatus: "running" } });
      },
    },
  };
  const query = new URLSearchParams({
    mode: "reset_world",
    expectedWorldId: "W20260719-AABB0001",
    operationKey: "pwa-world-operation-002",
  });
  const response = await archiveStatusHandler({
    request: new Request(`https://game.example/api/game/archive/status?${query}`, {
      headers: { cookie: `__Host-xuanche_session=${sessionToken}` },
    }),
    env,
  });
  assert.equal(response.status, 200);
  assert.equal(receivedUrl.pathname, "/world/archive-reset/status");
  assert.equal(receivedUrl.searchParams.get("expectedWorldId"), "W20260719-AABB0001");
  assert.equal(receivedUrl.searchParams.get("operationKey"), "pwa-world-operation-002");
});

test("PWA initialization validates and forwards a bounded character without UI-only mode", async () => {
  const sessionToken = await createSessionToken({
    version: 1,
    subject: "owner",
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
  }, "session-secret");
  let forwarded;
  const env = {
    XUANCHE_API_KEY: "engine-key",
    PWA_SESSION_SECRET: "session-secret",
    XUANCHE_ENGINE: {
      async fetch(request) {
        forwarded = await request.json();
        return Response.json({ ok: true, data: { initialized: true, worldId: "W20260719-NEW00001" } });
      },
    },
  };
  const response = await initializeHandler({
    request: new Request("https://game.example/api/game/initialize", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://game.example",
        cookie: `__Host-xuanche_session=${sessionToken}`,
      },
      body: JSON.stringify({
        mode: "new_game",
        saveKey: "pwa-new-game-0001",
        character: {
          name: "沈青禾",
          age: "19歲",
          personality: ["沉靜", "敏銳"],
          equipment: "短笛",
        },
        opening: {
          location: "河港",
          knownAbilities: ["辨音"],
          choices: ["觀察河面"],
        },
      }),
    }),
    env,
  });
  assert.equal(response.status, 200);
  assert.equal(forwarded.mode, undefined);
  assert.equal(forwarded.character.name, "沈青禾");
  assert.deepEqual(forwarded.opening.knownAbilities, ["辨音"]);
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
    const committedPacket = streamText.split("\n\n")
      .find((packet) => packet.startsWith("event: committed"));
    const committedData = JSON.parse(committedPacket.split("\n").find((line) => line.startsWith("data: ")).slice(6));
    assert.equal(committedData.visibleResult, generated.visibleResult);
    assert.equal(committedData.visibleCost, generated.visibleCost);
    assert.deepEqual(committedData.facts, generated.facts);
    assert.deepEqual(committedData.playerState, generated.playerState);
    assert.equal(committedInput.expectedSimTick, 16);
    assert.equal(committedInput.narrative, narrative);
    assert.deepEqual(committedInput.playerState, generated.playerState);
    assert.equal(openAiRequest.model, "gpt-5.6-terra");
    assert.equal(openAiRequest.tools[0].strict, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
