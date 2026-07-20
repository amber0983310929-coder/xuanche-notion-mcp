export class GatewayError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.details = details;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

export function errorResponse(error) {
  const status = error instanceof GatewayError ? error.status : 500;
  const body = {
    ok: false,
    error: error instanceof GatewayError ? error.message : "伺服器暫時無法完成請求。",
  };
  if (error instanceof GatewayError && error.details !== undefined) body.details = error.details;
  if (!(error instanceof GatewayError)) {
    console.error("xuanche_pwa_request_failed", {
      name: error?.name || "Error",
      message: error?.message || String(error),
    });
  }
  return json(body, status);
}

export async function readJson(request, maxBytes = 64_000) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new GatewayError(413, "請求內容過大。");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new GatewayError(413, "請求內容過大。");
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayError(400, "請求必須是有效的 JSON。");
  }
}

export function requireSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new GatewayError(403, "拒絕跨來源操作。");
  }
}

export function requireMethod(request, allowed) {
  if (!allowed.includes(request.method)) {
    throw new GatewayError(405, "不支援此請求方法。", { allowed });
  }
}
