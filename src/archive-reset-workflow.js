import { WorkflowEntrypoint } from "cloudflare:workers";
import { archiveAndResetWorld } from "./archive-reset.js";
import { CacheStore } from "./cache.js";
import { ACTIVE_RESET_LOCK, getActiveReset } from "./reset-lock.js";

/**
 * A destructive world reset can take longer than a ChatGPT Action request:
 * it must copy and hash every fixed Notion page before clearing anything.
 * Workflows give that work durable execution, retries and inspectable output.
 */
export class WorldArchiveResetWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    let result;
    try {
      result = await step.do(
        "archive, verify, and reset world",
        {
          retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
          timeout: "15 minutes",
        },
        async () => archiveAndResetWorld(this.env, event.payload),
      );
    } catch (error) {
      await step.do("release an unstarted reset lock", async () => {
        const cache = new CacheStore(this.env);
        const lock = await getActiveReset(cache);
        // A failure before archive verification must leave the playable world
        // untouched and unlocked. Once archive verification has happened the
        // lock changes phase and is deliberately retained for safe recovery.
        if (lock?.phase === "queued" && lock.operationKey === event.payload.operationKey) {
          await cache.delete(ACTIVE_RESET_LOCK);
        }
      });
      throw error;
    }

    return {
      archiveVerified: result.archived === true,
      reset: result.reset === true,
      worldState: result.worldState || "UNKNOWN",
      operationKey: event.payload.operationKey,
      result,
    };
  }
}
