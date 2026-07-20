import { GatewayError } from "./http.js";

export async function engineRequest(env, path, { method = "POST", body } = {}) {
  if (!env.XUANCHE_ENGINE?.fetch) {
    throw new GatewayError(503, "Xuanche Engine service binding 尚未設定。");
  }
  if (!env.XUANCHE_API_KEY) {
    throw new GatewayError(503, "Gateway 尚未設定 XUANCHE_API_KEY。");
  }
  const request = new Request(`https://xuanche-engine.internal${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-api-key": env.XUANCHE_API_KEY,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await env.XUANCHE_ENGINE.fetch(request);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) {
    throw new GatewayError(
      response.status || 502,
      payload.error || "Xuanche Engine 未能完成請求。",
      payload.details,
    );
  }
  return payload.data ?? payload;
}

export function loadWorldSnapshot(env, { refresh = false } = {}) {
  return engineRequest(env, "/world/load", {
    body: {
      profile: "turn_core",
      refresh,
      persist: false,
      maxDepth: 0,
      maxNodes: 60,
    },
  });
}

export function commitWorldTurn(env, payload) {
  return engineRequest(env, "/world/turn/commit", { body: payload });
}

export function startWorldArchive(env, payload) {
  return engineRequest(env, "/world/archive-reset", { body: payload });
}

export function getWorldArchiveStatus(env, { expectedWorldId, operationKey }) {
  const query = new URLSearchParams({ expectedWorldId, operationKey });
  return engineRequest(env, `/world/archive-reset/status?${query}`, { method: "GET" });
}

export function initializeGameWorld(env, payload) {
  return engineRequest(env, "/world/initialize", { body: payload });
}
