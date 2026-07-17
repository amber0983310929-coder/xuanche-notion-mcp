import { CacheStore } from "./cache.js";
import { GitHubClient } from "./github.js";
import { NotionClient } from "./notion.js";
import { ApiError, mapLimit, nowIso } from "./utils.js";
import {
  STATE_PAGE_KEYS,
  WORLD_PAGE_IDS,
  blockPlainText,
  blocksPlainText,
  parseWorldMarkers,
  validateLoadedWorld,
} from "./world-state.js";

const MARKER_TYPES = new Set([
  "paragraph", "callout", "heading_1", "heading_2", "heading_3",
  "bulleted_list_item", "numbered_list_item", "quote", "toggle",
]);

const STATUS_MIRROR_PAGE_IDS = Object.freeze({
  home: "5f4c8de4a4c246478a4658d1ebc2a1a2",
  route: "39cc845007ae8184b97dd0e8c0122768",
});

export async function initializeWorld(env, input, dependencies = {}) {
  validateInput(input);
  const notion = dependencies.notion || new NotionClient(env);
  const github = dependencies.github || new GitHubClient(env);
  const cache = dependencies.cache || new CacheStore(env);
  const statusMirrorsEnabled = dependencies.statusMirrors !== false;
  const timestamp = nowIso();
  const pages = await readStatePages(notion);
  const canonical = pages.find((page) => page.key === "save");

  if (
    canonical.markers.worldState === "ACTIVE" &&
    blocksPlainText(canonical.children).includes("SAVE_KEY：" + input.saveKey)
  ) {
    const world = validateLoadedWorld(
      pages.map((page) => ({ key: page.key, children: page.children })),
      { required: true },
    );
    if (world.worldState !== "ACTIVE") {
      throw new ApiError(409, "The matching SAVE_KEY does not belong to an ACTIVE world");
    }
    return finalizeInitialization({
      notion,
      github,
      cache,
      input,
      worldId: canonical.markers.worldId,
      timestamp,
      idempotent: true,
      statusMirrorsEnabled,
      verification: { status: "complete", validatedPageKeys: world.validatedPageKeys },
    });
  }

  const conflicts = pages
    .filter((page) => page.markers.worldState !== "EMPTY" || page.markers.worldId !== "PENDING")
    .map((page) => ({
      key: page.key,
      worldState: page.markers.worldState,
      worldId: page.markers.worldId,
    }));
  if (conflicts.length) {
    throw new ApiError(409, "A new world can only be initialized from a fully EMPTY/PENDING state", { conflicts });
  }

  const worldId = createWorldId();
  const staged = [];
  const committed = [];
  let verification = { status: "pending", validatedPageKeys: [] };
  try {
    for (const page of pages) {
      const result = await notion.appendBlocks(
        WORLD_PAGE_IDS[page.key],
        pagePayload(page.key, input, worldId, timestamp),
      );
      staged.push({
        key: page.key,
        blockIds: (result?.results || []).map((block) => block.id).filter(Boolean),
      });
    }

    const commitOrder = [...pages.filter((page) => page.key !== "save"), canonical];
    for (const page of commitOrder) {
      await notion.updateBlock(page.marker.id, {
        type: page.marker.type,
        text: activeMarker(worldId, input.saveKey),
      });
      committed.push(page);
    }

    try {
      const readback = await readStatePages(notion);
      const world = validateLoadedWorld(
        readback.map((page) => ({ key: page.key, children: page.children })),
        { required: true },
      );
      if (world.worldState !== "ACTIVE" || world.worldId !== worldId) {
        throw new ApiError(409, "World initialization readback did not match the staged world identity");
      }
      verification = { status: "complete", validatedPageKeys: world.validatedPageKeys };
    } catch (error) {
      if (committed.length !== pages.length || !isTransientUpstreamError(error)) throw error;
      verification = {
        status: "deferred",
        validatedPageKeys: [],
        cause: error?.message || String(error),
      };
    }
  } catch (error) {
    const rollbackErrors = await rollbackInitialization(notion, staged, committed);
    const reconciliation = await reconcileWorld(notion, worldId, input.saveKey);
    if (reconciliation.status === "active") {
      return finalizeInitialization({
        notion,
        github,
        cache,
        input,
        worldId,
        timestamp,
        idempotent: false,
        statusMirrorsEnabled,
        verification: {
          status: "recovered",
          validatedPageKeys: reconciliation.validatedPageKeys,
          cause: error?.message || String(error),
          rollbackErrors,
        },
      });
    }
    const cacheInvalidation = await invalidateWorldCache(cache);
    if (reconciliation.status === "empty") {
      throw new ApiError(error?.status || 500, "World initialization failed; authoritative markers were restored to EMPTY/PENDING", {
        cause: error?.message || String(error),
        cacheInvalidation,
        rolledBack: true,
        cleanupPending: rollbackErrors.length > 0,
        rollbackErrors,
      });
    }
    throw new ApiError(500, "World initialization failed and authoritative state could not be reconciled", {
      cause: error?.message || String(error),
      rollbackErrors,
      reconciliation,
      cacheInvalidation,
      worldConflict: true,
    });
  }

  return finalizeInitialization({
    notion,
    github,
    cache,
    input,
    worldId,
    timestamp,
    idempotent: false,
    statusMirrorsEnabled,
    verification,
  });
}

async function finalizeInitialization({
  notion,
  github,
  cache,
  input,
  worldId,
  timestamp,
  idempotent,
  statusMirrorsEnabled,
  verification,
}) {
  const statusMirror = statusMirrorsEnabled
    ? await mirrorNotionWorldStatus(notion, {
      worldId,
      saveKey: input.saveKey,
      characterName: input.character.name,
    })
    : { status: "disabled" };
  const mirror = await mirrorInitialization(github, input, worldId, timestamp);
  const cacheInvalidation = await invalidateWorldCache(cache);
  return {
    idempotent,
    initialized: true,
    worldId,
    worldState: "ACTIVE",
    simTick: 0,
    revision: 1,
    saveKey: input.saveKey,
    validatedPageKeys: verification.validatedPageKeys,
    verification,
    statusMirror,
    mirror,
    cacheInvalidation,
  };
}

async function invalidateWorldCache(cache) {
  try {
    return { status: "complete", entriesInvalidated: await cache.deletePrefix("world:") };
  } catch (error) {
    return { status: "pending", error: error?.message || String(error) };
  }
}

async function reconcileWorld(notion, expectedWorldId, saveKey) {
  try {
    const pages = await readStatePages(notion);
    const world = validateLoadedWorld(
      pages.map((page) => ({ key: page.key, children: page.children })),
      { required: true },
    );
    const canonical = pages.find((page) => page.key === "save");
    if (
      world.worldState === "ACTIVE" &&
      world.worldId === expectedWorldId &&
      blocksPlainText(canonical.children).includes("SAVE_KEY：" + saveKey)
    ) {
      return { status: "active", validatedPageKeys: world.validatedPageKeys };
    }
    if (world.worldState === "EMPTY" && world.worldId === "PENDING") {
      return { status: "empty", validatedPageKeys: world.validatedPageKeys };
    }
    return {
      status: "mixed",
      worldState: world.worldState,
      worldId: world.worldId,
      validatedPageKeys: world.validatedPageKeys,
    };
  } catch (error) {
    return {
      status: "unavailable",
      error: error?.message || String(error),
      httpStatus: error?.status || null,
    };
  }
}

async function mirrorNotionWorldStatus(notion, { worldId, saveKey, characterName }) {
  try {
    let updates = 0;
    for (const [key, pageId] of Object.entries(STATUS_MIRROR_PAGE_IDS)) {
      const tree = await notion.getPageTree(pageId, {
        maxDepth: 0,
        maxNodes: 250,
        concurrency: 1,
        includePage: false,
      });
      for (const block of tree.children) {
        const current = blockPlainText(block);
        const next = statusMirrorText(key, current, { worldId, saveKey, characterName });
        if (!next || next === current || !MARKER_TYPES.has(block.type)) continue;
        await notion.updateBlock(block.id, { type: block.type, text: next });
        updates += 1;
      }
    }

    for (const [key, pageId] of Object.entries(STATUS_MIRROR_PAGE_IDS)) {
      const tree = await notion.getPageTree(pageId, {
        maxDepth: 0,
        maxNodes: 250,
        concurrency: 1,
        includePage: false,
      });
      const text = blocksPlainText(tree.children);
      if (!statusMirrorMatches(key, text, worldId)) {
        throw new ApiError(409, "Notion display-status mirror did not match the ACTIVE world", {
          page: key,
          worldId,
        });
      }
    }
    return { status: "complete", pages: Object.keys(STATUS_MIRROR_PAGE_IDS), updates };
  } catch (error) {
    return {
      status: "pending",
      error: error?.message || String(error),
      httpStatus: error?.status || null,
    };
  }
}

function statusMirrorText(page, current, { worldId, saveKey, characterName }) {
  if (page === "home") {
    if (current.includes("世界系統：") && current.includes("目前狀態：")) {
      return current.replace(/目前狀態：(EMPTY|ACTIVE|WORLD_CONFLICT)/, "目前狀態：ACTIVE");
    }
    if (/^固定世界資料｜目前(?:EMPTY|ACTIVE|WORLD_CONFLICT)$/.test(current)) {
      return "固定世界資料｜目前ACTIVE";
    }
    if (current.startsWith("目前WORLD_STATE：")) {
      return "目前WORLD_STATE：ACTIVE；目前WORLD_ID：" + worldId +
        "；現行主角：" + characterName + "；SIM_TICK：0；來源SAVE_KEY：" + saveKey + "。";
    }
  }
  if (page === "route" && current.startsWith("目前世界狀態：")) {
    return "目前世界狀態：ACTIVE。現行WORLD_ID：" + worldId +
      "；現行主角：" + characterName +
      "；SIM_TICK：0。續接時依本頁ACTIVE路由載入02、04、12、19與20；不得重新建立或覆寫現行世界。";
  }
  return null;
}

function statusMirrorMatches(page, text, worldId) {
  if (page === "home") {
    return text.includes("目前狀態：ACTIVE") &&
      text.includes("固定世界資料｜目前ACTIVE") &&
      text.includes("目前WORLD_STATE：ACTIVE；目前WORLD_ID：" + worldId);
  }
  return text.includes("目前世界狀態：ACTIVE。現行WORLD_ID：" + worldId);
}

function isTransientUpstreamError(error) {
  return [429, 500, 502, 503, 504, 529].includes(Number(error?.status));
}

async function readStatePages(notion) {
  return mapLimit(STATE_PAGE_KEYS, 2, async (key) => {
    const tree = await notion.getPageTree(WORLD_PAGE_IDS[key], {
      maxDepth: 0,
      maxNodes: 5_000,
      concurrency: 2,
      includePage: false,
    });
    const markers = parseWorldMarkers(tree.children);
    const marker = tree.children.find((block) => {
      const text = blockPlainText(block);
      return text.includes("WORLD_STATE") && text.includes("WORLD_ID");
    });
    if (!markers.worldState || !markers.worldId || !marker || !MARKER_TYPES.has(marker.type)) {
      throw new ApiError(409, "A fixed world page is missing an editable world-state marker", {
        key,
        worldState: markers.worldState,
        worldId: markers.worldId,
        markerType: marker?.type || null,
      });
    }
    return {
      key,
      children: tree.children,
      markers,
      marker: {
        id: marker.id,
        type: marker.type,
        originalText: blockPlainText(marker),
      },
    };
  });
}

async function rollbackInitialization(notion, staged, committed) {
  const errors = [];
  for (const page of [...committed].reverse()) {
    try {
      await notion.updateBlock(page.marker.id, {
        type: page.marker.type,
        text: page.marker.originalText,
      });
    } catch (error) {
      errors.push({ target: page.key, operation: "restore_marker", message: error?.message || String(error) });
    }
  }
  for (const page of [...staged].reverse()) {
    for (const blockId of [...page.blockIds].reverse()) {
      try {
        await notion.archiveBlock(blockId);
      } catch (error) {
        errors.push({ target: page.key, blockId, operation: "archive_staged_block", message: error?.message || String(error) });
      }
    }
  }
  return errors;
}

async function mirrorInitialization(github, input, worldId, timestamp) {
  if (!github.configured) return { status: "unavailable" };
  const errors = [];
  let memoryCommit;
  let cacheCommit;
  try {
    const existing = (await github.getJson("world/memory.json", { allowNotFound: true }))?.data || {};
    const events = existing.events || [];
    if (!events.some((event) => event?.saveKey === input.saveKey)) {
      const saved = await github.putJson("world/memory.json", {
        version: 3,
        schema: "SAVE_V3.2",
        updatedAt: timestamp,
        worldState: "ACTIVE",
        worldId,
        simTick: 0,
        purgeId: existing.purgeId,
        events: [...events, {
          timestamp,
          type: "world_initialize",
          summary: "Initialized world for " + input.character.name,
          saveKey: input.saveKey,
          worldId,
        }].slice(-1_000),
      }, { message: "chore(world): initialize " + worldId });
      memoryCommit = saved.commit?.sha;
    }
  } catch (error) {
    errors.push({ target: "world/memory.json", message: error?.message || String(error) });
  }
  try {
    const existing = (await github.getJson("world/cache.json", { allowNotFound: true }))?.data || {};
    if (existing.lastSaveKey !== input.saveKey) {
      const saved = await github.putJson("world/cache.json", {
        version: 3,
        schema: "SAVE_V3.2",
        updatedAt: timestamp,
        worldState: "ACTIVE",
        worldId,
        simTick: 0,
        lastSaveKey: input.saveKey,
        snapshot: null,
      }, { message: "chore(world): activate cache " + worldId });
      cacheCommit = saved.commit?.sha;
    }
  } catch (error) {
    errors.push({ target: "world/cache.json", message: error?.message || String(error) });
  }
  return {
    status: errors.length ? "pending" : "complete",
    memoryCommit,
    cacheCommit,
    errors,
  };
}

function validateInput(input = {}) {
  if (
    typeof input.saveKey !== "string" ||
    !input.saveKey.trim() ||
    input.saveKey.trim() !== input.saveKey ||
    input.saveKey.length > 200 ||
    /[\r\n]/.test(input.saveKey)
  ) {
    throw new ApiError(400, "saveKey is required, must not contain surrounding whitespace or line breaks, and must be at most 200 characters");
  }
  if (!input.character || typeof input.character !== "object" || Array.isArray(input.character)) {
    throw new ApiError(400, "character must be an object");
  }
  if (typeof input.character.name !== "string" || !input.character.name.trim()) {
    throw new ApiError(400, "character.name is required");
  }
}

function activeMarker(worldId, saveKey) {
  return [
    "SAVE_SCHEMA_VERSION：SAVE_V3.2｜WORLD_STATE：ACTIVE｜WORLD_ID：" + worldId,
    "SIM_TICK：0｜狀態修訂：1｜SAVE_KEY：" + saveKey,
  ].join("\n");
}

function pagePayload(key, input, worldId, timestamp) {
  const character = input.character;
  const opening = input.opening || {};
  const common = [
    "SAVE_KEY：" + input.saveKey,
    "WORLD_ID：" + worldId,
    "初始化時間：" + timestamp,
  ];
  const payloads = {
    save: [
      ...common,
      "主角：" + character.name,
      "SIM_TICK：0",
      "狀態修訂：1",
      "初始位置：" + text(opening.location, "待生成"),
      "初始時間：" + text(opening.time, "待生成"),
      "當前主線：" + text(opening.premise, "守護珍視的人事物並踏上修行之路"),
    ],
    character: [
      ...common,
      "角色固定資料",
      ...objectLines(character),
      "玩家已知能力：" + list(opening.knownAbilities),
    ],
    timeline: [
      ...common,
      "TIME_EVENT_ID：INIT-" + worldId,
      "事件：角色確認並建立新世界",
      "主角：" + character.name,
    ],
    knowledge: [
      ...common,
      "INFO_ID：INIT-KNOWLEDGE-" + worldId,
      "初始已知能力：" + list(opening.knownAbilities),
      "初始已知世界資訊：" + list(opening.knownWorldFacts),
    ],
    relationships: [
      ...common,
      "ENTITY_ID：INIT-RELATIONSHIP-" + worldId,
      "初始關係：" + list(character.relationships),
    ],
    causality: [
      ...common,
      "CAUSE_ID：INIT-CAUSE-" + worldId,
      "人生目標：" + text(character.motivation, "保護珍視的人事物"),
      "底線：" + text(character.bottomLine, "不得背棄珍視之人"),
      "承諾與代價：" + list(opening.promises),
    ],
    clues: [
      ...common,
      "CLUE_ID：INIT-CLUE-" + worldId,
      "玩家可見初始線索：" + text(opening.visibleClue, "尚未察覺"),
    ],
    events: [
      ...common,
      "EVENT_ID：INIT-EVENT-" + worldId,
      "初始事件：" + text(opening.premise, "新的命運即將展開"),
      "第一個決策點：" + list(opening.choices),
      "狀態：READY",
    ],
    director: [
      ...common,
      "HIDDEN_ID：INIT-HIDDEN-" + worldId,
      "六項開局契約：" + list(opening.contracts),
      "隱藏起源：" + text(opening.hiddenOrigin, "由世界因果生成，未向玩家揭露"),
      "導演備註：" + text(opening.directorNotes, "不得提前揭露隱藏資訊"),
    ],
  };
  return payloads[key].map((value) => truncate(value));
}

function objectLines(value) {
  return Object.entries(value)
    .filter(([key]) => key !== "relationships")
    .map(([key, item]) => key + "：" + (Array.isArray(item) ? list(item) : text(item, "未設定")));
}

function list(value) {
  if (!Array.isArray(value) || value.length === 0) return "待世界演化";
  return value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join("；");
}

function text(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function truncate(value) {
  const content = String(value);
  return content.length <= 1_800 ? content : content.slice(0, 1_797) + "…";
}

function createWorldId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return "W" + date + "-" + crypto.randomUUID().split("-")[0].toUpperCase();
}
