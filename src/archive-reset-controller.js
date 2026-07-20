import { ARCHIVE_RESET_STEPS } from "./archive-reset-step.js";
import { MAX_ARCHIVE_BATCHES, MAX_CLEAR_BATCHES } from "./archive-reset-staged.js";
import { validateArchiveResetInput } from "./archive-reset.js";
import { ApiError, nowIso } from "./utils.js";
import { STATE_PAGE_KEYS } from "./world-state.js";

export const ARCHIVE_CONTROLLER_SCHEMA = "XC_ARCHIVE_ALARM_CONTROLLER_V1";
export const ARCHIVE_CONTROLLER_JOB_KEY = "archive-reset-controller:v1";

const MAX_CACHE_BATCHES = 100;
const MAX_CONSECUTIVE_FAILURES = 6;

export function createArchiveControllerJob(input, options = {}) {
  validateArchiveResetInput(input);
  const timestamp = options.now || nowIso();
  return {
    schema: ARCHIVE_CONTROLLER_SCHEMA,
    input,
    status: "queued",
    machine: {
      phase: "prepare",
      keyIndex: 0,
      archiveBatch: 0,
      clearBatch: 0,
      cacheBatch: 0,
    },
    archiveId: null,
    archiveVerified: false,
    resetStarted: false,
    progress: {
      archivedPageKeys: [],
      resetPageKeys: [],
    },
    result: null,
    error: null,
    consecutiveFailures: 0,
    workflowAttempt: Number(options.workflowAttempt || 0),
    continuationSequence: Number(options.continuationSequence || 0),
    createdAt: options.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

export function restartArchiveControllerJob(job, input, options = {}) {
  validateStoredIdentity(job, input);
  if (["queued", "running", "waiting", "complete"].includes(job.status)) return job;
  return createArchiveControllerJob(input, {
    now: options.now,
    createdAt: job.createdAt,
    workflowAttempt: Number(job.workflowAttempt || 0) + 1,
    continuationSequence: Number(job.continuationSequence || 0) + 1,
  });
}

export function archiveControllerCommand(job) {
  if (!job || ["complete", "errored"].includes(job.status)) return null;
  const key = STATE_PAGE_KEYS[job.machine.keyIndex];
  switch (job.machine.phase) {
    case "prepare": return { operation: ARCHIVE_RESET_STEPS.PREPARE };
    case "archive_begin": return { operation: ARCHIVE_RESET_STEPS.BEGIN_PAGE, key };
    case "archive_capture": return { operation: ARCHIVE_RESET_STEPS.CAPTURE_PAGE_BATCH, key };
    case "archive_finalize": return { operation: ARCHIVE_RESET_STEPS.FINALIZE_PAGE, key };
    case "verify_archive": return { operation: ARCHIVE_RESET_STEPS.VERIFY_ARCHIVE };
    case "mark_resetting": return { operation: ARCHIVE_RESET_STEPS.MARK_PAGE_RESETTING, key };
    case "clear_page": return { operation: ARCHIVE_RESET_STEPS.CLEAR_PAGE_BATCH, key };
    case "mark_empty": return { operation: ARCHIVE_RESET_STEPS.MARK_PAGE_EMPTY, key };
    case "clear_cache": return { operation: ARCHIVE_RESET_STEPS.CLEAR_CACHE_BATCH };
    case "finalize_reset": return { operation: ARCHIVE_RESET_STEPS.FINALIZE_RESET };
    default: throw new ApiError(500, "Archive controller has an unknown phase", { phase: job.machine.phase });
  }
}

export function advanceArchiveControllerJob(job, result, options = {}) {
  const next = cloneJob(job, options.now);
  const phase = next.machine.phase;
  next.status = "running";
  next.error = null;
  next.consecutiveFailures = 0;

  switch (phase) {
    case "prepare":
      next.archiveId = result?.archiveId || next.archiveId;
      next.machine.phase = "archive_begin";
      break;
    case "archive_begin":
      next.machine.phase = result?.done ? "archive_finalize" : "archive_capture";
      next.machine.archiveBatch = Number(result?.batchIndex || 0);
      break;
    case "archive_capture":
      next.machine.archiveBatch = Number(result?.batchIndex || next.machine.archiveBatch + 1);
      if (next.machine.archiveBatch > MAX_ARCHIVE_BATCHES) {
        throw new ApiError(422, "Archive controller exceeded its page batch safety limit", {
          key: STATE_PAGE_KEYS[next.machine.keyIndex],
        });
      }
      if (result?.done) next.machine.phase = "archive_finalize";
      break;
    case "archive_finalize":
      addProgressKey(next.progress.archivedPageKeys, STATE_PAGE_KEYS[next.machine.keyIndex]);
      if (next.machine.keyIndex + 1 < STATE_PAGE_KEYS.length) {
        next.machine.keyIndex += 1;
        next.machine.archiveBatch = 0;
        next.machine.phase = "archive_begin";
      } else {
        next.machine.phase = "verify_archive";
      }
      break;
    case "verify_archive":
      next.archiveVerified = true;
      next.machine.keyIndex = 0;
      next.machine.clearBatch = 0;
      next.machine.phase = "mark_resetting";
      break;
    case "mark_resetting":
      next.resetStarted = true;
      next.machine.phase = "clear_page";
      break;
    case "clear_page":
      next.machine.clearBatch += 1;
      if (next.machine.clearBatch > MAX_CLEAR_BATCHES) {
        throw new ApiError(422, "Archive controller exceeded its clear-page batch safety limit", {
          key: STATE_PAGE_KEYS[next.machine.keyIndex],
        });
      }
      if (result?.done) next.machine.phase = "mark_empty";
      break;
    case "mark_empty":
      addProgressKey(next.progress.resetPageKeys, STATE_PAGE_KEYS[next.machine.keyIndex]);
      if (next.machine.keyIndex + 1 < STATE_PAGE_KEYS.length) {
        next.machine.keyIndex += 1;
        next.machine.clearBatch = 0;
        next.machine.phase = "mark_resetting";
      } else {
        next.machine.phase = "clear_cache";
      }
      break;
    case "clear_cache":
      next.machine.cacheBatch += 1;
      if (next.machine.cacheBatch > MAX_CACHE_BATCHES) {
        throw new ApiError(422, "Archive controller exceeded its cache batch safety limit");
      }
      if (result?.done) next.machine.phase = "finalize_reset";
      break;
    case "finalize_reset":
      next.status = "complete";
      next.machine.phase = "complete";
      next.archiveVerified = result?.archived === true;
      next.result = result;
      break;
    default:
      throw new ApiError(500, "Archive controller cannot advance an unknown phase", { phase });
  }
  return next;
}

export function failArchiveControllerJob(job, error, options = {}) {
  const next = cloneJob(job, options.now);
  const status = Number(error?.status || 500);
  const retryable = options.retryable ?? (status === 429 || status >= 500);
  next.consecutiveFailures = Number(job.consecutiveFailures || 0) + 1;
  next.error = error?.message || String(error);
  next.status = retryable && next.consecutiveFailures <= MAX_CONSECUTIVE_FAILURES
    ? "waiting"
    : "errored";
  return next;
}

export function archiveControllerRetryDelay(job) {
  return Math.min(60_000, 2_000 * (2 ** Math.max(0, Number(job.consecutiveFailures || 1) - 1)));
}

export function archiveControllerStatus(job, workflowId = null) {
  if (!job) return { found: false };
  const completed = job.status === "complete" && job.result?.reset === true;
  const workflowStatus = ["queued", "running", "waiting", "complete", "errored"].includes(job.status)
    ? job.status
    : "unknown";
  return {
    found: true,
    accepted: true,
    completed,
    safeToInitialize: completed,
    archiveVerified: job.archiveVerified === true,
    reset: completed,
    worldState: completed ? "EMPTY" : job.resetStarted ? "RESETTING" : "ARCHIVING",
    phase: publicPhase(job),
    operationKey: job.input.operationKey,
    archiveId: job.archiveId || job.result?.archive?.archiveId || null,
    workflowId,
    workflowStatus,
    workflowAttempt: Number(job.workflowAttempt || 0),
    continuationSequence: Number(job.continuationSequence || 0),
    progress: {
      archivedPageKeys: [...job.progress.archivedPageKeys],
      archivedPageCount: job.progress.archivedPageKeys.length,
      resetPageKeys: [...job.progress.resetPageKeys],
      resetPageCount: job.progress.resetPageKeys.length,
      totalPageCount: STATE_PAGE_KEYS.length,
    },
    retryable: workflowStatus === "errored",
    requiresOperatorAction: workflowStatus === "errored",
    nextAction: completed
      ? "INITIALIZE_WORLD"
      : workflowStatus === "errored" ? "RETRY_SAME_OPERATION" : "POLL_STATUS",
    nextPollAfterSeconds: completed || workflowStatus === "errored" ? null : 2,
    error: workflowStatus === "errored" ? job.error : null,
    result: completed ? job.result : undefined,
  };
}

function validateStoredIdentity(job, input) {
  validateArchiveResetInput(input);
  if (!job || job.schema !== ARCHIVE_CONTROLLER_SCHEMA) {
    throw new ApiError(409, "Archive controller checkpoint has an unexpected schema");
  }
  if (
    job.input.expectedWorldId !== input.expectedWorldId ||
    job.input.operationKey !== input.operationKey
  ) {
    throw new ApiError(409, "Archive controller checkpoint belongs to a different operation");
  }
}

function cloneJob(job, now) {
  return {
    ...job,
    machine: { ...job.machine },
    progress: {
      archivedPageKeys: [...job.progress.archivedPageKeys],
      resetPageKeys: [...job.progress.resetPageKeys],
    },
    updatedAt: now || nowIso(),
  };
}

function addProgressKey(keys, key) {
  if (!keys.includes(key)) keys.push(key);
}

function publicPhase(job) {
  if (job.status === "complete") return "complete";
  if (job.machine.phase === "prepare" && job.status === "queued") return "queued";
  if (["mark_resetting", "clear_page", "mark_empty", "clear_cache", "finalize_reset"].includes(job.machine.phase)) {
    return job.archiveVerified ? (job.resetStarted ? "resetting" : "archive_verified") : "archiving";
  }
  return "archiving";
}
