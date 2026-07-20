import { DurableObject } from "cloudflare:workers";
import { commitTurn } from "./turn-commit.js";
import { ApiError, errorJson, json, readJson } from "./utils.js";

/** Serializes commits for one WORLD_ID across tabs and retries. */
export class WorldTurnCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.commitQueue = Promise.resolve();
  }

  async fetch(request) {
    const response = this.commitQueue.then(() => this.handleCommit(request));
    this.commitQueue = response.then(() => undefined, () => undefined);
    return response;
  }

  async handleCommit(request) {
    const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
    try {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/commit") {
        throw new ApiError(404, "Coordinator route not found");
      }
      const input = await readJson(request);
      const data = await commitTurn(this.env, input);
      return json({ ok: true, data, requestId });
    } catch (error) {
      return errorJson(error, requestId);
    }
  }
}
