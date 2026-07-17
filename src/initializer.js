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

export async function initializeWorld(env, input, dependencies = {}) {
  validateInput(input);
  const notion = dependencies.notion || new NotionClient(env);
  const github = dependencies.github || new GitHubClient(env);
  const cache = dependencies.cache || new CacheStore(env);
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
    const mirror = await mirrorInitialization(github, input, canonical.markers.worldId, timestamp);
    const cacheInvalidation = await invalidateWorldCache(cache);
    return {
      idempotent: true,
      initialized: true,
      worldId: canonical.markers.worldId,
      worldState: "ACTIVE",
      saveKey: input.saveKey,
      mirror,
      cacheInvalidation,
    };
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

    const readback = await readStatePages(notion);
    const world = validateLoadedWorld(
      readback.map((page) => ({ key: page.key, children: page.children })),
      { required: true },
    );
    if (world.worldState !== "ACTIVE" || world.worldId !== worldId) {
      throw new ApiError(409, "World initialization readback did not match the staged world identity");
    }
  } catch (error) {
    const rollbackErrors = await rollbackInitialization(notion, staged, committed);
    const cacheInvalidation = await invalidateWorldCache(cache);
    if (rollbackErrors.length) {
      throw new ApiError(500, "World initialization failed and rollback was incomplete", {
        cause: error?.message || String(error),
        rollbackErrors,
        cacheInvalidation,
        worldConflict: true,
      });
    }
    throw new ApiError(error?.status || 500, "World initialization failed; every page was restored to EMPTY/PENDING", {
      cause: error?.message || String(error),
      cacheInvalidation,
      rolledBack: true,
    });
  }

  const mirror = await mirrorInitialization(github, input, worldId, timestamp);
  const cacheInvalidation = await invalidateWorldCache(cache);
  return {
    idempotent: false,
    initialized: true,
    worldId,
    worldState: "ACTIVE",
    simTick: 0,
    revision: 1,
    saveKey: input.saveKey,
    validatedPageKeys: [...STATE_PAGE_KEYS],
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

async function readStatePages(notion) {
  return mapLimit(STATE_PAGE_KEYS, 2, async (key) => {
    const tree = await notion.getPageTree(WORLD_PAGE_IDS[key], {
      maxDepth: 0,
      maxNodes: 5_000,
      concurrency: 2,
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
