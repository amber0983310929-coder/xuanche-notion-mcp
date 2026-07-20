import { DurableObject } from "cloudflare:workers";
import {
  ARCHIVE_CONTROLLER_JOB_KEY,
  advanceArchiveControllerJob,
  archiveControllerCommand,
  archiveControllerRetryDelay,
  archiveControllerStatus,
  createArchiveControllerJob,
  failArchiveControllerJob,
  restartArchiveControllerJob,
} from "./archive-reset-controller.js";
import { executeArchiveResetStep } from "./archive-reset-step.js";
import { CacheStore } from "./cache.js";
import { NotionClient } from "./notion.js";
import { ACTIVE_RESET_LOCK, getActiveReset } from "./reset-lock.js";
import { ApiError } from "./utils.js";

/**
 * Executes exactly one bounded Notion archive/reset batch per RPC invocation.
 * Every alarm event is a new invocation, so a transient Notion failure does
 * not consume the next batch's external-subrequest allowance.
 */
export class WorldArchiveStepExecutor extends DurableObject {
  async startController({ input, workflowId, restart = true } = {}) {
    const existing = await this.ctx.storage.get(ARCHIVE_CONTROLLER_JOB_KEY);
    const job = existing
      ? restart ? restartArchiveControllerJob(existing, input) : existing
      : createArchiveControllerJob(input);
    await this.ctx.storage.put(ARCHIVE_CONTROLLER_JOB_KEY, job);
    if (!["complete", "errored"].includes(job.status)) {
      await this.ctx.storage.setAlarm(Date.now() + 1);
    }
    return archiveControllerStatus(job, workflowId);
  }

  async getControllerStatus({ workflowId } = {}) {
    const job = await this.ctx.storage.get(ARCHIVE_CONTROLLER_JOB_KEY);
    return archiveControllerStatus(job, workflowId);
  }

  async alarm() {
    let job = await this.ctx.storage.get(ARCHIVE_CONTROLLER_JOB_KEY);
    if (!job || ["complete", "errored"].includes(job.status)) return;
    job = { ...job, status: "running", updatedAt: new Date().toISOString() };
    await this.ctx.storage.put(ARCHIVE_CONTROLLER_JOB_KEY, job);
    const command = archiveControllerCommand(job);
    if (!command) return;

    try {
      const notion = new NotionClient(this.env, fetch, { maxRequestAttempts: 1 });
      const result = await executeArchiveResetStep(this.env, {
        ...command,
        input: job.input,
      }, { notion });
      job = advanceArchiveControllerJob(job, result);
      await this.ctx.storage.put(ARCHIVE_CONTROLLER_JOB_KEY, job);
      if (job.status !== "complete") await this.ctx.storage.setAlarm(Date.now() + 1);
    } catch (error) {
      job = failArchiveControllerJob(job, error);
      if (job.status === "waiting") {
        await this.ctx.storage.put(ARCHIVE_CONTROLLER_JOB_KEY, job);
        await this.ctx.storage.setAlarm(Date.now() + archiveControllerRetryDelay(job));
      } else {
        // Release a queue-only lock before persisting the terminal state. If
        // KV is temporarily unavailable, let the alarm fail so Cloudflare's
        // at-least-once delivery retries this cleanup instead of stranding it.
        await this.releaseQueuedLock(job.input);
        await this.ctx.storage.put(ARCHIVE_CONTROLLER_JOB_KEY, job);
      }
    }
  }

  async runStep(request) {
    try {
      const notion = new NotionClient(this.env, fetch, { maxRequestAttempts: 1 });
      const data = await executeArchiveResetStep(this.env, request, { notion });
      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        status: error instanceof ApiError ? error.status : 500,
        error: error?.message || "Archive step failed",
        details: error instanceof ApiError ? error.details : undefined,
      };
    }
  }

  async releaseQueuedLock(input) {
    const cache = new CacheStore(this.env);
    const lock = await getActiveReset(cache);
    if (lock?.phase === "queued" && lock.operationKey === input.operationKey) {
      await cache.delete(ACTIVE_RESET_LOCK);
    }
  }
}
