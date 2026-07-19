import { CacheStore } from "./cache.js";
import { assertWorldMutationUnlocked } from "./reset-lock.js";
import { GitHubClient } from "./github.js";
import { worldPageCachePrefix } from "./loader.js";
import { NotionClient } from "./notion.js";
import { ApiError, mergeDeep, normalizeNotionId, nowIso } from "./utils.js";
import {
  WORLD_PAGE_IDS,
  assertExpectedWorld,
  blockPlainText,
  blocksPlainText,
  parseWorldMarkers,
  resolveBlockTarget,
  resolveWritableWorldPageReference,
} from "./world-state.js";

export async function updateWorld(env, input, dependencies = {}) {
  const startedAt = Date.now();
  const notion = dependencies.notion || new NotionClient(env);
  const github = dependencies.github || new GitHubClient(env);
  const cache = dependencies.cache || new CacheStore(env);
  await assertWorldMutationUnlocked(cache);
  const mutations = validateInput(input);

  if ((input.memoryEvent !== undefined || input.cachePatch !== undefined) && !github.configured) {
    throw new ApiError(503, "GitHub storage must be configured for memory or cache updates");
  }

  const canonicalReadStartedAt = Date.now();
  const canonicalSaveId = normalizeNotionId(WORLD_PAGE_IDS.save);
  const canonicalBlocks = await notion.listAllBlockChildren(canonicalSaveId, { maxNodes: 5_000 });
  const markers = parseWorldMarkers(canonicalBlocks);
  const canonicalIdempotent = hasSaveKey(canonicalBlocks, input.saveKey);
  assertExpectedWorld(markers, {
    worldState: input.expectedWorldState,
    worldId: input.expectedWorldId,
    // A response can be lost after Notion commits. The same SAVE_KEY must be
    // replayable even though the canonical revision has already advanced.
    revision: canonicalIdempotent ? undefined : input.expectedRevision,
  });
  const canonicalReadMs = Date.now() - canonicalReadStartedAt;

  const targetBlocksByPage = new Map([[canonicalSaveId, canonicalBlocks]]);
  const additionalPageIds = [...new Set(
    mutations.map((mutation) => mutation.pageId).filter((pageId) => pageId !== canonicalSaveId),
  )];
  await Promise.all(additionalPageIds.map(async (pageId) => {
    targetBlocksByPage.set(pageId, await notion.listAllBlockChildren(pageId, { maxNodes: 5_000 }));
  }));

  const mutationStartedAt = Date.now();
  const notionMutations = [];
  let allIdempotent = true;
  const orderedMutations = [...mutations].sort((left, right) =>
    Number(right.pageId === canonicalSaveId) - Number(left.pageId === canonicalSaveId));
  for (const mutation of orderedMutations) {
    const targetBlocks = targetBlocksByPage.get(mutation.pageId) || [];
    const idempotent = hasSaveKey(targetBlocks, input.saveKey);
    allIdempotent = allIdempotent && idempotent;
    const notionResult = { updated: [], append: null };
    const preparedUpdates = await prepareBlockUpdates(
      notion,
      mutation.pageId,
      mutation.blockUpdates || [],
      targetBlocks,
    );
    if (!idempotent) {
      const children = [...(mutation.children || []), "SAVE_KEY：" + input.saveKey];
      notionResult.append = await notion.appendBlocks(mutation.pageId, children, mutation.after);
    }
    // Append the idempotency marker before replacing mutable summary blocks.
    // If a Notion update commits but its response is lost, a retry sees the
    // SAVE_KEY and can safely finish or confirm these replacements.
    for (const update of preparedUpdates) {
      if (update.alreadyApplied) {
        notionResult.updated.push({ blockId: update.blockId, alreadyApplied: true });
        continue;
      }
      const result = await notion.updateBlock(update.blockId, update.input);
      notionResult.updated.push({ blockId: update.blockId, result });
    }
    notionMutations.push({ pageId: mutation.pageId, idempotent, ...notionResult });
  }
  const mutationMs = Date.now() - mutationStartedAt;

  if (allIdempotent && input.memoryEvent === undefined && input.cachePatch === undefined) {
    return {
      idempotent: true,
      saveKey: input.saveKey,
      worldState: markers.worldState,
      worldId: markers.worldId,
      timestamp: nowIso(),
      cacheEntriesInvalidated: 0,
      timings: { canonicalReadMs, mutationMs, totalMs: Date.now() - startedAt },
    };
  }

  const timestamp = nowIso();
  const output = {
    idempotent: allIdempotent,
    saveKey: input.saveKey,
    worldState: markers.worldState,
    worldId: markers.worldId,
    notion: mutations.length === 1
      ? { updated: notionMutations[0].updated, append: notionMutations[0].append }
      : { mutations: notionMutations },
    timestamp,
  };

  const githubStartedAt = Date.now();
  const githubErrors = [];
  if (input.memoryEvent !== undefined) {
    try {
      const existing = (await github.getJson("world/memory.json", { allowNotFound: true }))?.data || {
        version: 3,
        events: [],
      };
      const event = typeof input.memoryEvent === "string"
        ? { timestamp, summary: input.memoryEvent }
        : { timestamp, ...input.memoryEvent };
      if ((existing.events || []).some((item) => item?.saveKey === input.saveKey)) {
        output.memoryIdempotent = true;
      } else {
        existing.version = Math.max(3, Number(existing.version || 0));
        existing.worldState = input.expectedWorldState;
        existing.worldId = input.expectedWorldId;
        existing.events = [...(existing.events || []), {
          ...event,
          saveKey: input.saveKey,
          worldId: input.expectedWorldId,
        }].slice(-1_000);
        existing.updatedAt = timestamp;
        const saved = await github.putJson("world/memory.json", existing, {
          message: input.commitMessage || "chore(world): record " + input.saveKey,
        });
        output.memoryCommit = saved.commit?.sha;
      }
    } catch (error) {
      githubErrors.push({ target: "world/memory.json", message: error?.message || String(error) });
    }
  }

  if (input.cachePatch !== undefined) {
    try {
      const existing = (await github.getJson("world/cache.json", { allowNotFound: true }))?.data || {};
      if (existing.lastSaveKey === input.saveKey) {
        output.cacheIdempotent = true;
      } else {
        const next = mergeDeep(existing, input.cachePatch);
        next.version = Math.max(3, Number(next.version || 0));
        next.worldState = input.expectedWorldState;
        next.worldId = input.expectedWorldId;
        next.lastSaveKey = input.saveKey;
        next.updatedAt = timestamp;
        const saved = await github.putJson("world/cache.json", next, {
          message: input.commitMessage || "chore(world): cache " + input.saveKey,
        });
        output.cacheCommit = saved.commit?.sha;
      }
    } catch (error) {
      githubErrors.push({ target: "world/cache.json", message: error?.message || String(error) });
    }
  }

  output.githubSync = githubErrors.length
    ? { status: "pending", errors: githubErrors }
    : { status: "complete" };
  const githubMs = Date.now() - githubStartedAt;

  const cacheStartedAt = Date.now();
  let cacheEntriesInvalidated = 0;
  if (typeof cache.deletePrefix === "function") {
    const changedPageIds = notionMutations
      .filter((mutation) => !mutation.idempotent)
      .map((mutation) => mutation.pageId);
    for (const pageId of changedPageIds) {
      cacheEntriesInvalidated += Number(await cache.deletePrefix(worldPageCachePrefix(pageId))) || 0;
    }
    // Remove only legacy whole-profile entries from releases before the
    // page-granular cache. Unchanged page entries remain warm.
    cacheEntriesInvalidated += Number(await cache.deletePrefix("world:v")) || 0;
  }
  output.cacheEntriesInvalidated = cacheEntriesInvalidated;
  output.timings = {
    canonicalReadMs,
    mutationMs,
    githubMs,
    cacheInvalidationMs: Date.now() - cacheStartedAt,
    totalMs: Date.now() - startedAt,
  };
  return output;
}

function validateInput(input = {}) {
  if (typeof input.saveKey !== "string" || !input.saveKey.trim() || input.saveKey.length > 200 || /[\r\n]/.test(input.saveKey)) {
    throw new ApiError(400, "saveKey is required and must be a single line of at most 200 characters");
  }
  if (!["EMPTY", "ACTIVE", "WORLD_CONFLICT"].includes(input.expectedWorldState)) {
    throw new ApiError(400, "expectedWorldState must be EMPTY, ACTIVE, or WORLD_CONFLICT");
  }
  if (typeof input.expectedWorldId !== "string" || !input.expectedWorldId.trim()) {
    throw new ApiError(400, "expectedWorldId is required");
  }

  const usingBatch = input.mutations !== undefined;
  if (usingBatch && (
    input.pageId !== undefined || input.pageKey !== undefined || input.children !== undefined ||
    input.blockUpdates !== undefined || input.after !== undefined
  )) {
    throw new ApiError(400, "Use either mutations or a single page update, not both");
  }
  const rawMutations = usingBatch ? input.mutations : [input];
  if (!Array.isArray(rawMutations) || rawMutations.length === 0 || rawMutations.length > 9) {
    throw new ApiError(400, "mutations must contain between 1 and 9 page updates");
  }
  const mutations = rawMutations.map(validateMutation);
  if (new Set(mutations.map((mutation) => mutation.pageId)).size !== mutations.length) {
    throw new ApiError(400, "mutations cannot update the same page more than once");
  }
  return mutations;
}

function validateMutation(input = {}) {
  const target = resolveWritableWorldPageReference(input);
  const pageId = target.pageId;
  let after = input.after;
  if (after !== undefined) {
    try {
      after = normalizeNotionId(after);
    } catch (error) {
      if (!(error instanceof ApiError) || error.message !== "Invalid Notion page or block ID") throw error;
      // Turn logs are append-only. A malformed model-supplied anchor should
      // fall back to the safe end of the fixed page instead of losing a save.
      after = undefined;
    }
  }
  if (input.children !== undefined && (!Array.isArray(input.children) || input.children.length > 99)) {
    throw new ApiError(400, "children must be an array with at most 99 blocks");
  }
  if (input.blockUpdates !== undefined && (!Array.isArray(input.blockUpdates) || input.blockUpdates.length > 50)) {
    throw new ApiError(400, "blockUpdates must be an array with at most 50 entries");
  }
  if (!(input.children?.length || input.blockUpdates?.length)) {
    throw new ApiError(400, "At least one child append or block update is required");
  }
  return { ...input, pageId, pageKey: target.pageKey, after };
}

async function prepareBlockUpdates(notion, pageId, updates, pageBlocks = []) {
  const prepared = [];
  for (const input of updates) {
    if (!input?.type) throw new ApiError(400, "Every block update requires type");
    const desiredText = input.type === "table_row"
      ? (input.cells || []).map((cell) => Array.isArray(cell) ? cell.join("") : String(cell ?? "")).join(" | ")
      : String(input.text ?? "");
    const resolved = await resolveUpdateTarget(notion, pageId, input, pageBlocks, desiredText);
    const ownerPageId = resolved.pageId;
    if (ownerPageId !== pageId) {
      throw new ApiError(403, "A block update cannot cross fixed world-page boundaries", {
        blockId: resolved.block?.id || input.blockId || null,
        expectedPageId: pageId,
        actualPageId: ownerPageId,
      });
    }
    const current = resolved.block;
    const currentText = blockPlainText(current);
    if (input.expectedText !== undefined && currentText !== input.expectedText && currentText !== desiredText) {
      throw new ApiError(409, "A Notion block changed before this update could be applied", {
        blockId: normalizeNotionId(current.id),
        expectedText: input.expectedText,
        actualText: currentText,
      });
    }
    prepared.push({
      blockId: normalizeNotionId(current.id),
      input,
      alreadyApplied: currentText === desiredText,
    });
  }
  return prepared;
}

async function resolveUpdateTarget(notion, pageId, input, pageBlocks, desiredText) {
  if (input.blockId) {
    try {
      return await resolveBlockTarget(notion, input.blockId);
    } catch (error) {
      if (!hasSemanticBlockSelector(input, desiredText)) throw error;
    }
  }

  const selector = semanticBlockSelector(input, desiredText);
  if (!selector) {
    throw new ApiError(400, "Every block update requires blockId, matchText, or matchPrefix");
  }
  const candidates = flattenBlocks(pageBlocks).filter((block) => selector.matches(blockPlainText(block)));
  if (candidates.length !== 1) {
    throw new ApiError(409, candidates.length === 0
      ? "No block matched the semantic update target"
      : "The semantic update target matched more than one block", {
      pageId,
      selector: selector.description,
      matchCount: candidates.length,
    });
  }
  if (!candidates[0]?.id) {
    throw new ApiError(409, "The matched Notion block has no stable ID", { pageId });
  }
  return { pageId, block: candidates[0] };
}

function hasSemanticBlockSelector(input, desiredText) {
  return Boolean(semanticBlockSelector(input, desiredText));
}

function semanticBlockSelector(input, desiredText) {
  if (typeof input.matchText === "string" && input.matchText) {
    return {
      description: { matchText: input.matchText },
      matches: (text) => text === input.matchText,
    };
  }
  if (typeof input.matchPrefix === "string" && input.matchPrefix) {
    return {
      description: { matchPrefix: input.matchPrefix },
      matches: (text) => text.startsWith(input.matchPrefix),
    };
  }
  if (typeof input.expectedText === "string" && input.expectedText) {
    return {
      description: { expectedText: input.expectedText },
      matches: (text) => text === input.expectedText,
    };
  }

  const firstLine = String(desiredText || "").split(/\r?\n/, 1)[0].trimStart();
  const label = firstLine.match(/^([^：:\r\n]{1,80}[：:])/u)?.[1];
  if (!label) return null;
  return {
    description: { inferredPrefix: label },
    matches: (text) => text.startsWith(label),
  };
}

function flattenBlocks(blocks) {
  const output = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    output.push(block);
    if (Array.isArray(block?.children)) output.push(...flattenBlocks(block.children));
  }
  return output;
}

function hasSaveKey(blocks, saveKey) {
  const text = blocksPlainText(blocks);
  return text.includes("SAVE_KEY：" + saveKey) || text.includes("SAVE_KEY: " + saveKey);
}
