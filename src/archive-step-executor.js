import { DurableObject } from "cloudflare:workers";
import { executeArchiveResetStep } from "./archive-reset-step.js";
import { NotionClient } from "./notion.js";
import { ApiError } from "./utils.js";

/**
 * Executes exactly one bounded Notion archive/reset batch per RPC invocation.
 * Workflow retries create a new invocation, so a transient Notion failure does
 * not consume the next batch's external-subrequest allowance.
 */
export class WorldArchiveStepExecutor extends DurableObject {
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
}
