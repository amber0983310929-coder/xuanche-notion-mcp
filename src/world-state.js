import { ApiError, normalizeNotionId } from "./utils.js";

export const WORLD_PAGE_IDS = Object.freeze({
  save: "39fc845007ae81f295ecef235d229ff2",
  character: "39fc845007ae81f2a723dca974a8342a",
  timeline: "39fc845007ae8193a691e96f0323561c",
  knowledge: "3a0c845007ae81518960f13469012b3b",
  relationships: "3a0c845007ae81318eb6c9af267def40",
  causality: "3a0c845007ae81148a7ee469dc58cf2a",
  clues: "3a0c845007ae818cba00fc7ef100b7eb",
  events: "3a0c845007ae8144a64de3a6c646332c",
  director: "3a0c845007ae81888deaff5b06b6a168",
  experience: "39fc845007ae81eeb4fac2a18a75abd7",
});

export const WORLD_PAGE_KEYS = Object.freeze(Object.keys(WORLD_PAGE_IDS));

const PAGE_KEY_ALIASES = new Map([
  ...WORLD_PAGE_KEYS.map((key) => [key, key]),
  ["2", "save"],
  ["02", "save"],
  ["03", "character"],
  ["04", "timeline"],
  ["05", "knowledge"],
  ["06", "relationships"],
  ["07", "causality"],
  ["08", "clues"],
  ["09", "events"],
  ["11", "director"],
  ["31", "experience"],
]);

const PAGE_KEY_BY_ID = new Map(
  Object.entries(WORLD_PAGE_IDS).map(([key, id]) => [normalizeNotionId(id), key]),
);

export const STATE_PAGE_KEYS = Object.freeze([
  "save", "character", "timeline", "knowledge", "relationships",
  "causality", "clues", "events", "director",
]);

const WRITABLE_IDS = new Set(Object.values(WORLD_PAGE_IDS).map(normalizeNotionId));
// RESETTING is an intentionally non-playable state. It is written only after
// a complete archive has been verified and remains in place if clearing the
// fixed pages needs to be resumed. This makes a partially completed reset
// fail closed instead of exposing a mixed world as playable.
const WORLD_STATES = new Set(["EMPTY", "ACTIVE", "RESETTING", "WORLD_CONFLICT"]);

export function assertWritableWorldPage(pageId) {
  const normalized = normalizeNotionId(pageId);
  if (!WRITABLE_IDS.has(normalized)) {
    throw new ApiError(403, "The requested page is not in the fixed world-state write allowlist", {
      pageId: normalized,
      allowedPageKeys: Object.keys(WORLD_PAGE_IDS),
    });
  }
  return normalized;
}

export function resolveWritableWorldPageReference(input = {}) {
  const pageKey = input.pageKey === undefined ? null : normalizeWritablePageKey(input.pageKey);
  const pageId = input.pageId === undefined ? null : resolveWritablePageIdOrAlias(input.pageId);
  if (!pageKey && !pageId) {
    throw new ApiError(400, "Every world update requires pageKey or pageId", {
      allowedPageKeys: WORLD_PAGE_KEYS,
    });
  }

  const keyId = pageKey ? normalizeNotionId(WORLD_PAGE_IDS[pageKey]) : null;
  if (pageId && keyId && pageId !== keyId) {
    throw new ApiError(400, "pageKey and pageId refer to different fixed world pages", {
      pageKey,
      pageId,
    });
  }

  const resolvedPageId = keyId || pageId;
  return {
    pageId: resolvedPageId,
    pageKey: pageKey || PAGE_KEY_BY_ID.get(resolvedPageId),
  };
}

function normalizeWritablePageKey(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, "pageKey must name a fixed world page", {
      allowedPageKeys: WORLD_PAGE_KEYS,
    });
  }
  const key = PAGE_KEY_ALIASES.get(value.trim().toLowerCase());
  if (!key) {
    throw new ApiError(400, "Unknown fixed world pageKey", {
      pageKey: value,
      allowedPageKeys: WORLD_PAGE_KEYS,
    });
  }
  return key;
}

function resolveWritablePageIdOrAlias(value) {
  if (typeof value === "string") {
    const alias = PAGE_KEY_ALIASES.get(value.trim().toLowerCase());
    if (alias) return normalizeNotionId(WORLD_PAGE_IDS[alias]);
  }
  try {
    return assertWritableWorldPage(value);
  } catch (error) {
    if (error instanceof ApiError && error.message === "Invalid Notion page or block ID") {
      throw new ApiError(400, "Invalid world page target; use pageKey instead of a Notion ID", {
        pageId: value,
        allowedPageKeys: WORLD_PAGE_KEYS,
      });
    }
    throw error;
  }
}

export function blockPlainText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const payload = block[block.type] || block;
  if (Array.isArray(payload?.cells)) {
    return payload.cells.map(richTextPlainText).filter(Boolean).join(" | ");
  }
  const own = richTextPlainText(payload?.rich_text || payload?.caption || payload?.title);
  const nested = Array.isArray(block.children)
    ? block.children.map(blockPlainText).filter(Boolean).join("\n")
    : "";
  return [own, nested].filter(Boolean).join("\n");
}

export function blocksPlainText(blocks) {
  return (Array.isArray(blocks) ? blocks : []).map(blockPlainText).filter(Boolean).join("\n");
}

export function parseWorldMarkers(blocks) {
  const text = blocksPlainText(blocks);
  const worldState = marker(text, "WORLD_STATE")?.toUpperCase();
  const worldId = marker(text, "WORLD_ID");
  const simTickRaw = marker(text, "SIM_TICK");
  const revisionRaw = text.match(/(?:狀態修訂|STATE_REVISION|REVISION)\s*[：:]\s*(\d+)/i)?.[1];
  return {
    worldState: WORLD_STATES.has(worldState) ? worldState : worldState || null,
    worldId: worldId || null,
    simTick: simTickRaw != null && /^\d+$/.test(simTickRaw) ? Number(simTickRaw) : null,
    revision: revisionRaw != null ? Number(revisionRaw) : null,
    text,
  };
}

export function assertExpectedWorld(markers, expected = {}) {
  if (!markers.worldState || !markers.worldId) {
    throw new ApiError(409, "Canonical save page is missing WORLD_STATE or WORLD_ID", {
      worldState: markers.worldState,
      worldId: markers.worldId,
    });
  }
  if (markers.worldState !== expected.worldState || markers.worldId !== expected.worldId) {
    throw new ApiError(409, "World state changed before this update could be applied", {
      expectedWorldState: expected.worldState,
      actualWorldState: markers.worldState,
      expectedWorldId: expected.worldId,
      actualWorldId: markers.worldId,
    });
  }
  if (expected.revision !== undefined && expected.revision !== null && markers.revision !== Number(expected.revision)) {
    throw new ApiError(409, "World revision changed before this update could be applied", {
      expectedRevision: Number(expected.revision),
      actualRevision: markers.revision,
    });
  }
}

export function validateLoadedWorld(pages, { required = false } = {}) {
  const statePages = (Array.isArray(pages) ? pages : []).filter((page) => STATE_PAGE_KEYS.includes(page.key));
  const byKey = new Map(statePages.map((page) => [page.key, parseWorldMarkers(page.children)]));
  const save = byKey.get("save");
  if (!save) {
    if (required) throw new ApiError(409, "World load profile did not include the canonical save page");
    return null;
  }
  if (!save.worldState || !save.worldId) {
    throw new ApiError(409, "Canonical save page is missing WORLD_STATE or WORLD_ID");
  }
  const conflicts = [];
  for (const [key, markers] of byKey) {
    if (!markers.worldState || !markers.worldId) {
      conflicts.push({ key, reason: "missing_markers" });
      continue;
    }
    if (markers.worldState !== save.worldState || markers.worldId !== save.worldId) {
      conflicts.push({ key, worldState: markers.worldState, worldId: markers.worldId });
    }
  }
  if (conflicts.length) {
    throw new ApiError(409, "Configured world pages contain mixed save identities", {
      canonical: { worldState: save.worldState, worldId: save.worldId },
      conflicts,
    });
  }
  return {
    worldState: save.worldState,
    worldId: save.worldId,
    simTick: save.simTick,
    revision: save.revision,
    validatedPageKeys: [...byKey.keys()],
  };
}

export async function resolveBlockPageId(notion, blockId) {
  return (await resolveBlockTarget(notion, blockId)).pageId;
}

export async function resolveBlockTarget(notion, blockId) {
  let current = normalizeNotionId(blockId);
  let targetBlock;
  const visited = new Set();
  for (let depth = 0; depth < 12; depth += 1) {
    if (visited.has(current)) break;
    visited.add(current);
    const block = await notion.getBlock(current);
    if (!targetBlock) targetBlock = block;
    const parent = block?.parent;
    if (parent?.type === "page_id") {
      return { pageId: normalizeNotionId(parent.page_id), block: targetBlock };
    }
    if (parent?.type === "block_id") {
      current = normalizeNotionId(parent.block_id);
      continue;
    }
    break;
  }
  throw new ApiError(409, "Could not resolve the target block to a fixed world page", { blockId });
}

function marker(text, name) {
  return text.match(new RegExp(name + "\\s*[：:]\\s*([^\\s|｜]+)", "i"))?.[1] || null;
}

function richTextPlainText(value) {
  if (!Array.isArray(value)) return "";
  return value.map((item) => item?.plain_text ?? item?.text?.content ?? "").join("");
}
