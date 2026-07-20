import { WorkflowEntrypoint } from "cloudflare:workers";
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
import { CacheStore } from "./cache.js";
import { ACTIVE_RESET_LOCK, getActiveReset } from "./reset-lock.js";
import { STATE_PAGE_KEYS } from "./world-state.js";

/**
 * Every Workflow step is intentionally page-scoped.  Workflows protect total
 * elapsed time, while page-scoping also keeps each Worker invocation under
 * Cloudflare's subrequest ceiling.
 */
export class WorldArchiveResetWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const options = {
      retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
      timeout: "15 minutes",
    };
    try {
      await step.do("prepare archive checkpoint", options, () =>
        prepareStagedArchiveReset(this.env, event.payload));

      for (const key of STATE_PAGE_KEYS) {
        let archiveState = await step.do("begin archive " + key, options, () =>
          beginStagedPageArchive(this.env, event.payload, key));
        let batchIndex = archiveState.batchIndex || 0;
        while (!archiveState.done) {
          const currentBatch = batchIndex;
          archiveState = await step.do("capture archive " + key + " batch " + currentBatch, options, () =>
            captureStagedPageBatch(this.env, event.payload, key));
          batchIndex = archiveState.batchIndex;
          if (batchIndex > 50) throw new Error("Archive batch safety limit exceeded for " + key);
        }
        await step.do("finalize archive " + key, options, () =>
          finalizeStagedPageArchive(this.env, event.payload, key));
      }

      await step.do("verify complete archive", options, () =>
        verifyStagedArchive(this.env, event.payload));

      for (const key of STATE_PAGE_KEYS) {
        await step.do("mark resetting " + key, options, () =>
          markStagedPageResetting(this.env, event.payload, key));
        let clearState = { done: false };
        let clearBatch = 0;
        while (!clearState.done) {
          const currentBatch = clearBatch;
          clearState = await step.do("clear world blocks " + key + " batch " + currentBatch, options, () =>
            clearStagedPageBatch(this.env, event.payload, key));
          clearBatch += 1;
          if (clearBatch > 200) throw new Error("Reset batch safety limit exceeded for " + key);
        }
        await step.do("mark empty " + key, options, () =>
          markStagedPageEmpty(this.env, event.payload, key));
      }

      let cacheState = { done: false };
      let cacheBatch = 0;
      while (!cacheState.done) {
        const currentBatch = cacheBatch;
        cacheState = await step.do("clear world cache batch " + currentBatch, options, () =>
          clearStagedWorldCacheBatch(this.env, event.payload));
        cacheBatch += 1;
        if (cacheBatch > 100) throw new Error("Cache reset batch safety limit exceeded");
      }

      const result = await step.do("finalize reset", options, () =>
        finalizeStagedArchiveReset(this.env, event.payload));

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
