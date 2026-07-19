import { CacheStore } from "./cache.js";
import { GitHubClient } from "./github.js";
import { worldPageCachePrefix } from "./loader.js";
import { NotionClient } from "./notion.js";
import { assertWorldMutationUnlocked } from "./reset-lock.js";
import { ApiError, nowIso, normalizeNotionId } from "./utils.js";
import {
  WORLD_PAGE_IDS,
  assertExpectedWorld,
  blockPlainText,
  blocksPlainText,
  findCanonicalMarkerBlock,
  parseWorldMarkers,
} from "./world-state.js";

const EDITABLE_TEXT_TYPES = new Set([
  "paragraph", "callout", "heading_1", "heading_2", "heading_3",
  "bulleted_list_item", "numbered_list_item", "quote", "toggle",
]);

/**
 * Commits one player turn without accepting Notion IDs or arbitrary mutations
 * from the model.  The unique save header is the commit record; mirrors and
 * the append-only event can therefore be repaired by replaying actionKey.
 */
export async function commitTurn(env, rawInput, dependencies = {}) {
  const startedAt = Date.now();
  const input = validateTurnCommitInput(rawInput);
  const notion = dependencies.notion || new NotionClient(env);
  const github = dependencies.github || new GitHubClient(env);
  const cache = dependencies.cache || new CacheStore(env);
  await assertWorldMutationUnlocked(cache);

  const savePageId = normalizeNotionId(WORLD_PAGE_IDS.save);
  const blocks = await notion.listAllBlockChildren(savePageId, { maxNodes: 5_000 });
  const markers = parseWorldMarkers(blocks);
  const pageText = blocksPlainText(blocks);
  const historicalReplay = hasTurnActionKey(pageText, input.actionKey) &&
    markers.lastActionKey !== input.actionKey;

  if (historicalReplay) {
    return turnResult({
      input,
      markers,
      saveKey: markers.saveKey,
      idempotent: true,
      historicalReplay: true,
      repaired: [],
      eventAppended: false,
      mirror: { status: "unchanged" },
      cacheEntriesInvalidated: 0,
      startedAt,
    });
  }

  const repairingLatestCommit = markers.lastActionKey === input.actionKey;
  if (!repairingLatestCommit) {
    assertExpectedWorld(markers, {
      worldState: "ACTIVE",
      worldId: input.expectedWorldId,
      revision: input.expectedRevision,
    });
    if (markers.simTick !== input.expectedSimTick) {
      throw new ApiError(409, "World tick changed before this turn could be committed", {
        expectedSimTick: input.expectedSimTick,
        actualSimTick: markers.simTick,
      });
    }
  }

  if (markers.worldState !== "ACTIVE") {
    throw new ApiError(409, "Only an ACTIVE world can accept a gameplay turn", {
      worldState: markers.worldState,
    });
  }
  if (!Number.isInteger(markers.simTick) || !Number.isInteger(markers.revision)) {
    throw new ApiError(409, "Canonical save marker is missing a valid tick or revision");
  }

  const tick = repairingLatestCommit ? markers.simTick : markers.simTick + 1;
  const revision = repairingLatestCommit ? markers.revision : markers.revision + 1;
  const saveKey = repairingLatestCommit
    ? markers.saveKey || createTurnSaveKey(markers.worldId, tick, input.actionKey)
    : createTurnSaveKey(markers.worldId, tick, input.actionKey);
  const timestamp = nowIso();

  // Resolve every mutable target before advancing the authoritative header.
  // A malformed page therefore fails without creating a new world revision.
  const header = ensureEditable(findCanonicalMarkerBlock(blocks), "canonical save marker");
  const tickMirror = findUniqueMirror(blocks, ["SIM_TICK：", "SIM_TICK:"], "SIM_TICK mirror");
  const revisionMirror = findUniqueMirror(
    blocks,
    ["狀態修訂：", "狀態修訂:", "STATE_REVISION：", "STATE_REVISION:"],
    "revision mirror",
  );
  const mainlineMirror = findUniqueMirror(blocks, ["當前主線：", "當前主線:"], "current mainline");

  const repaired = [];
  if (!repairingLatestCommit) {
    await updateTextBlock(notion, header, canonicalHeader({
      worldId: markers.worldId,
      tick,
      revision,
      saveKey,
      actionKey: input.actionKey,
      timestamp,
    }));
    repaired.push("canonical");
  }

  const mirrors = [
    [tickMirror, `SIM_TICK：${tick}`, "tick"],
    [revisionMirror, `狀態修訂：${revision}`, "revision"],
    [mainlineMirror, `當前主線：${input.mainline}`, "mainline"],
  ];
  for (const [block, text, name] of mirrors) {
    if (blockPlainText(block) === text) continue;
    await updateTextBlock(notion, block, text);
    repaired.push(name);
  }

  let eventAppended = false;
  if (!hasTurnActionKey(pageText, input.actionKey)) {
    await notion.appendBlocks(savePageId, turnEventBlocks(input, tick, saveKey));
    eventAppended = true;
  }

  const mirror = await mirrorTurnToGitHub(github, input, {
    worldId: markers.worldId,
    tick,
    revision,
    saveKey,
    timestamp,
  });
  const cacheEntriesInvalidated = await invalidateTurnCache(cache, savePageId);

  return turnResult({
    input,
    markers: { ...markers, simTick: tick, revision, saveKey },
    saveKey,
    idempotent: repairingLatestCommit,
    historicalReplay: false,
    repaired,
    eventAppended,
    mirror,
    cacheEntriesInvalidated,
    startedAt,
  });
}

export function validateTurnCommitInput(input = {}) {
  const expectedWorldId = singleLine(input.expectedWorldId, "expectedWorldId", 80);
  const actionKey = singleLine(input.actionKey, "actionKey", 100);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(actionKey)) {
    throw new ApiError(400, "actionKey must contain only letters, digits, underscores, or hyphens");
  }
  const expectedSimTick = nonNegativeInteger(input.expectedSimTick, "expectedSimTick");
  const expectedRevision = nonNegativeInteger(input.expectedRevision, "expectedRevision");
  const playerAction = boundedText(input.playerAction, "playerAction", 1, 800);
  const narrative = boundedText(input.narrative, "narrative", 80, 1_800);
  const summary = boundedText(input.summary, "summary", 10, 500);
  const mainline = boundedText(input.mainline, "mainline", 20, 900);
  const visibleResult = boundedText(input.visibleResult, "visibleResult", 1, 700);
  const visibleCost = boundedText(input.visibleCost, "visibleCost", 1, 700);
  const situation = boundedText(input.situation, "situation", 10, 900);
  const choices = validateChoices(input.choices);
  const facts = validateFacts(input.facts);
  return {
    expectedWorldId,
    expectedSimTick,
    expectedRevision,
    actionKey,
    playerAction,
    narrative,
    summary,
    mainline,
    visibleResult,
    visibleCost,
    situation,
    choices,
    facts,
  };
}

export function createTurnSaveKey(worldId, tick, actionKey) {
  const safeWorldId = String(worldId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  return `turn-${safeWorldId}-t${tick}-pwa-${actionKey}`.slice(0, 200);
}

function canonicalHeader({ worldId, tick, revision, saveKey, actionKey, timestamp }) {
  return [
    `SAVE_SCHEMA_VERSION：SAVE_V3.3｜WORLD_STATE：ACTIVE｜WORLD_ID：${worldId}`,
    `SIM_TICK：${tick}｜狀態修訂：${revision}｜SAVE_KEY：${saveKey}`,
    `LAST_ACTION_KEY：${actionKey}｜UPDATED_AT：${timestamp}`,
  ].join("\n");
}

function turnEventBlocks(input, tick, saveKey) {
  const choiceText = input.choices
    .map((choice, index) => `${index + 1}. ${choice.label}`)
    .join("｜");
  const blocks = [
    `回合 ${tick}｜${input.summary}`,
    `玩家行動｜${input.playerAction}`,
    `敘事正文｜${input.narrative}`,
    `可見結果｜${input.visibleResult}`,
    `可見代價｜${input.visibleCost}`,
    `當前位置與局勢｜${input.situation}`,
    `可選行動｜${choiceText}`,
  ];
  if (input.facts.length) blocks.push(`世界事實｜${input.facts.join("；")}`);
  blocks.push(`TURN_ACTION_KEY：${input.actionKey}`, `SAVE_KEY：${saveKey}`);
  return blocks;
}

function turnResult({
  input,
  markers,
  saveKey,
  idempotent,
  historicalReplay,
  repaired,
  eventAppended,
  mirror,
  cacheEntriesInvalidated,
  startedAt,
}) {
  return {
    committed: true,
    idempotent,
    historicalReplay,
    worldState: markers.worldState,
    worldId: markers.worldId,
    simTick: markers.simTick,
    revision: markers.revision,
    saveKey: saveKey || null,
    actionKey: input.actionKey,
    choices: input.choices,
    repaired,
    eventAppended,
    mirror,
    cacheEntriesInvalidated,
    durationMs: Date.now() - startedAt,
  };
}

function findUniqueMirror(blocks, prefixes, label) {
  const matches = flattenBlocks(blocks).filter((block) => {
    const text = blockPlainText(block).trimStart();
    return prefixes.some((prefix) => text.startsWith(prefix));
  });
  if (matches.length !== 1) {
    throw new ApiError(409, `Canonical save page must contain exactly one ${label}`, {
      target: label,
      matchCount: matches.length,
    });
  }
  return ensureEditable(matches[0], label);
}

function ensureEditable(block, label) {
  if (!block?.id || !EDITABLE_TEXT_TYPES.has(block.type)) {
    throw new ApiError(409, `${label} is not an editable text block`, {
      type: block?.type || null,
    });
  }
  return block;
}

function updateTextBlock(notion, block, text) {
  return notion.updateBlock(block.id, { type: block.type, text });
}

function hasTurnActionKey(text, actionKey) {
  return text.includes(`TURN_ACTION_KEY：${actionKey}`) || text.includes(`TURN_ACTION_KEY: ${actionKey}`);
}

async function mirrorTurnToGitHub(github, input, state) {
  if (!github.configured) return { status: "disabled" };
  try {
    const existing = (await github.getJson("world/memory.json", { allowNotFound: true }))?.data || {
      version: 3,
      events: [],
    };
    if ((existing.events || []).some((event) => event?.actionKey === input.actionKey)) {
      return { status: "complete", idempotent: true };
    }
    existing.version = Math.max(3, Number(existing.version || 0));
    existing.schema = "SAVE_V3.3";
    existing.worldState = "ACTIVE";
    existing.worldId = state.worldId;
    existing.simTick = state.tick;
    existing.revision = state.revision;
    existing.lastSaveKey = state.saveKey;
    existing.updatedAt = state.timestamp;
    existing.events = [...(existing.events || []), {
      timestamp: state.timestamp,
      type: "gameplay_turn",
      actionKey: input.actionKey,
      saveKey: state.saveKey,
      worldId: state.worldId,
      simTick: state.tick,
      playerAction: input.playerAction,
      summary: input.summary,
      facts: input.facts,
    }].slice(-1_000);
    const saved = await github.putJson("world/memory.json", existing, {
      message: `chore(world): record ${state.saveKey}`,
    });
    return { status: "complete", commit: saved.commit?.sha || null };
  } catch (error) {
    return { status: "pending", error: error?.message || String(error) };
  }
}

async function invalidateTurnCache(cache, pageId) {
  if (typeof cache.deletePrefix !== "function") return 0;
  try {
    let count = 0;
    count += Number(await cache.deletePrefix(worldPageCachePrefix(pageId))) || 0;
    count += Number(await cache.deletePrefix("world:v")) || 0;
    return count;
  } catch (error) {
    console.error("xuanche_turn_cache_invalidation_pending", {
      message: error?.message || String(error),
    });
    return 0;
  }
}

function validateChoices(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    throw new ApiError(400, "choices must contain between 2 and 4 actions");
  }
  const choices = value.map((choice, index) => ({
    id: singleLine(choice?.id || `choice${index + 1}`, `choices[${index}].id`, 40),
    label: boundedText(choice?.label, `choices[${index}].label`, 2, 120),
    intent: boundedText(choice?.intent, `choices[${index}].intent`, 2, 240),
  }));
  if (new Set(choices.map((choice) => choice.id)).size !== choices.length) {
    throw new ApiError(400, "choice ids must be unique");
  }
  return choices;
}

function validateFacts(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new ApiError(400, "facts must be an array with at most 8 items");
  }
  return value.map((fact, index) => boundedText(fact, `facts[${index}]`, 1, 240));
}

function boundedText(value, name, minimum, maximum) {
  if (typeof value !== "string") throw new ApiError(400, `${name} must be text`);
  const text = value.trim();
  if (text.length < minimum || text.length > maximum) {
    throw new ApiError(400, `${name} must contain between ${minimum} and ${maximum} characters`);
  }
  return text;
}

function singleLine(value, name, maximum) {
  const text = boundedText(value, name, 1, maximum);
  if (/[\r\n]/.test(text)) throw new ApiError(400, `${name} must be a single line`);
  return text;
}

function nonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ApiError(400, `${name} must be a non-negative integer`);
  }
  return value;
}

function flattenBlocks(blocks) {
  const output = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    output.push(block);
    if (Array.isArray(block?.children)) output.push(...flattenBlocks(block.children));
  }
  return output;
}
