import { WorkflowEntrypoint } from "cloudflare:workers";
import {
  archiveAndVerifyStagedPage,
  clearStagedPage,
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
        await step.do("archive and verify " + key, options, () =>
          archiveAndVerifyStagedPage(this.env, event.payload, key));
      }

      await step.do("verify complete archive", options, () =>
        verifyStagedArchive(this.env, event.payload));

      for (const key of STATE_PAGE_KEYS) {
        await step.do("mark resetting " + key, options, () =>
          markStagedPageResetting(this.env, event.payload, key));
        await step.do("clear world blocks " + key, options, () =>
          clearStagedPage(this.env, event.payload, key));
        await step.do("mark empty " + key, options, () =>
          markStagedPageEmpty(this.env, event.payload, key));
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
