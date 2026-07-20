import {
  beginStagedPageArchive,
  captureStagedPageBatch,
  clearStagedPageBatch,
  clearStagedWorldCacheBatch,
  finalizeStagedPageArchive,
  finalizeStagedArchiveReset,
  markStagedPageEmpty,
  markStagedPageResetting,
  prepareStagedArchiveReset,
  verifyStagedArchive,
} from "./archive-reset-staged.js";
import { validateArchiveResetInput } from "./archive-reset.js";
import { ApiError } from "./utils.js";
import { STATE_PAGE_KEYS } from "./world-state.js";

export const ARCHIVE_RESET_STEPS = Object.freeze({
  PREPARE: "prepare",
  BEGIN_PAGE: "begin-page",
  CAPTURE_PAGE_BATCH: "capture-page-batch",
  FINALIZE_PAGE: "finalize-page",
  VERIFY_ARCHIVE: "verify-archive",
  MARK_PAGE_RESETTING: "mark-page-resetting",
  CLEAR_PAGE_BATCH: "clear-page-batch",
  MARK_PAGE_EMPTY: "mark-page-empty",
  CLEAR_CACHE_BATCH: "clear-cache-batch",
  FINALIZE_RESET: "finalize-reset",
});

const DEFAULT_HANDLERS = Object.freeze({
  [ARCHIVE_RESET_STEPS.PREPARE]: { handler: prepareStagedArchiveReset },
  [ARCHIVE_RESET_STEPS.BEGIN_PAGE]: { handler: beginStagedPageArchive, pageScoped: true },
  [ARCHIVE_RESET_STEPS.CAPTURE_PAGE_BATCH]: { handler: captureStagedPageBatch, pageScoped: true },
  [ARCHIVE_RESET_STEPS.FINALIZE_PAGE]: { handler: finalizeStagedPageArchive, pageScoped: true },
  [ARCHIVE_RESET_STEPS.VERIFY_ARCHIVE]: { handler: verifyStagedArchive },
  [ARCHIVE_RESET_STEPS.MARK_PAGE_RESETTING]: { handler: markStagedPageResetting, pageScoped: true },
  [ARCHIVE_RESET_STEPS.CLEAR_PAGE_BATCH]: { handler: clearStagedPageBatch, pageScoped: true },
  [ARCHIVE_RESET_STEPS.MARK_PAGE_EMPTY]: { handler: markStagedPageEmpty, pageScoped: true },
  [ARCHIVE_RESET_STEPS.CLEAR_CACHE_BATCH]: { handler: clearStagedWorldCacheBatch },
  [ARCHIVE_RESET_STEPS.FINALIZE_RESET]: { handler: finalizeStagedArchiveReset },
});

/**
 * Dispatches one bounded archive/reset operation. In production this function
 * runs inside a Durable Object invocation, giving every Notion batch its own
 * external-subrequest budget instead of charging all batches to one Workflow.
 */
export async function executeArchiveResetStep(
  env,
  request = {},
  dependencies = {},
  handlers = DEFAULT_HANDLERS,
) {
  const { operation, input, key } = request;
  validateArchiveResetInput(input);
  const descriptor = handlers[operation];
  if (!descriptor || typeof descriptor.handler !== "function") {
    throw new ApiError(400, "Unknown archive-and-reset step", { operation: operation || null });
  }
  if (descriptor.pageScoped && !STATE_PAGE_KEYS.includes(key)) {
    throw new ApiError(400, "Archive-and-reset page step requires a fixed world page key", {
      operation,
      key: key || null,
    });
  }
  return descriptor.pageScoped
    ? descriptor.handler(env, input, key, dependencies)
    : descriptor.handler(env, input, dependencies);
}

export async function executeArchiveResetStepThroughBinding(namespace, input, operation, key) {
  if (!namespace) {
    throw new ApiError(503, "Durable archive step executor binding is not configured");
  }
  const objectName = input.expectedWorldId + ":" + input.operationKey;
  const stub = typeof namespace.getByName === "function"
    ? namespace.getByName(objectName)
    : namespace.get(namespace.idFromName(objectName));
  if (!stub || typeof stub.runStep !== "function") {
    throw new ApiError(503, "Durable archive step executor does not support RPC");
  }
  const response = await stub.runStep({ operation, input, key });
  if (!response || response.ok !== true) {
    throw new ApiError(
      Number(response?.status) || 500,
      response?.error || "Durable archive step failed",
      response?.details,
    );
  }
  return response.data;
}
