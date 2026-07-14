const gatewayHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-api-key",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

export async function onRequest(context) {
  const engine = context?.env?.XUANCHE_ENGINE;
  if (!engine || typeof engine.fetch !== "function") {
    return gatewayError(503, "XUANCHE_ENGINE service binding is not configured");
  }

  try {
    const upstream = await engine.fetch(context.request);
    const headers = new Headers(upstream.headers);
    headers.set("x-xuanche-gateway", "cloudflare-pages");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    console.error("xuanche_gateway_failed", {
      name: error?.name || "Error",
      message: error?.message || String(error),
    });
    return gatewayError(502, "Xuanche Engine service is temporarily unavailable");
  }
}

function gatewayError(status, error) {
  return new Response(JSON.stringify({ ok: false, error }, null, 2), {
    status,
    headers: gatewayHeaders,
  });
}
