import { WorkflowEntrypoint } from "cloudflare:workers";
import {
  ARCHIVE_RESET_STEPS,
  executeArchiveResetStepThroughBinding,
} from "./archive-reset-step.js";
import { MAX_ARCHIVE_BATCHES, MAX_CLEAR_BATCHES } from "./archive-reset-staged.js";
import { CacheStore } from "./cache.js";
import { ACTIVE_RESET_LOCK, getActiveReset } from "./reset-lock.js";
import { STATE_PAGE_KEYS } from "./world-state.js";

/**
 * Compatibility path for Workflow instances submitted before the alarm
 * controller was introduced. New archive jobs are driven directly by Durable
 * Object alarm events; an older instance can still finish its staged work.
 */
export class WorldArchiveResetWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const options = {
      retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
      timeout: "15 minutes",
    };
    const runStep = (operation, key) => executeArchiveResetStepThroughBinding(
      this.env.WORLD_ARCHIVE_STEP_EXECUTOR,
      event.payload,
      operation,
      key,
    );
    try {
      await step.do("prepare archive checkpoint", options, () =>
        runStep(ARCHIVE_RESET_STEPS.PREPARE));

      for (const key of STATE_PAGE_KEYS) {
        let archiveState = await step.do("begin archive " + key, options, () =>
          runStep(ARCHIVE_RESET_STEPS.BEGIN_PAGE, key));
        let batchIndex = archiveState.batchIndex || 0;
        while (!archiveState.done) {
          const currentBatch = batchIndex;
          archiveState = await step.do("capture archive " + key + " batch " + currentBatch, options, () =>
            runStep(ARCHIVE_RESET_STEPS.CAPTURE_PAGE_BATCH, key));
          batchIndex = archiveState.batchIndex;
          if (batchIndex > MAX_ARCHIVE_BATCHES) throw new Error("Archive batch safety limit exceeded for " + key);
        }
        await step.do("finalize archive " + key, options, () =>
          runStep(ARCHIVE_RESET_STEPS.FINALIZE_PAGE, key));
      }

      await step.do("verify complete archive", options, () =>
        runStep(ARCHIVE_RESET_STEPS.VERIFY_ARCHIVE));

      for (const key of STATE_PAGE_KEYS) {
        await step.do("mark resetting " + key, options, () =>
          runStep(ARCHIVE_RESET_STEPS.MARK_PAGE_RESETTING, key));
        let clearState = { done: false };
        let clearBatch = 0;
        while (!clearState.done) {
          const currentBatch = clearBatch;
          clearState = await step.do("clear world blocks " + key + " batch " + currentBatch, options, () =>
            runStep(ARCHIVE_RESET_STEPS.CLEAR_PAGE_BATCH, key));
          clearBatch += 1;
          if (clearBatch > MAX_CLEAR_BATCHES) throw new Error("Reset batch safety limit exceeded for " + key);
        }
        await step.do("mark empty " + key, options, () =>
          runStep(ARCHIVE_RESET_STEPS.MARK_PAGE_EMPTY, key));
      }

      let cacheState = { done: false };
      let cacheBatch = 0;
      while (!cacheState.done) {
        const currentBatch = cacheBatch;
        cacheState = await step.do("clear world cache batch " + currentBatch, options, () =>
          runStep(ARCHIVE_RESET_STEPS.CLEAR_CACHE_BATCH));
        cacheBatch += 1;
        if (cacheBatch > 100) throw new Error("Cache reset batch safety limit exceeded");
      }

      const result = await step.do("finalize reset", options, () =>
        runStep(ARCHIVE_RESET_STEPS.FINALIZE_RESET));

      return {
        archiveVerified: result.archived === true,
        reset: result.reset === true,
        worldState: result.worldState || "UNKNOWN",
        operationKey: event.payload.operationKey,
        result,
      };
    } catch (error) {
      await step.do("release an unstarted reset lock", async () => {
        const cache = new CacheStore(this.env);
        const lock = await getActiveReset(cache);
        // A failure before the first checkpoint has no durable archive work.
        // Later checkpoints are retained so the same operation can resume
        // without exposing or overwriting a partially reset world.
        if (lock?.phase === "queued" && lock.operationKey === event.payload.operationKey) {
          await cache.delete(ACTIVE_RESET_LOCK);
        }
      });
      throw error;
    }
  }
}
