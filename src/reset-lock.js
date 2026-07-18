import { ApiError } from "./utils.js";

export const ACTIVE_RESET_LOCK = "world-reset:active";

export async function getActiveReset(cache) {
  if (!cache || typeof cache.get !== "function") return null;
  const lock = await cache.get(ACTIVE_RESET_LOCK);
  return lock?.phase ? lock : null;
}

export async function assertWorldMutationUnlocked(cache) {
  const lock = await getActiveReset(cache);
  if (!lock) return;
  throw new ApiError(423, "World archive-and-reset is in progress; world writes are temporarily locked", {
    archiveId: lock.archiveId || null,
    expectedWorldId: lock.expectedWorldId || null,
    phase: lock.phase,
  });
}

