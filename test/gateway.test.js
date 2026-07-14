import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../gateway/functions/[[path]].js";

test("Pages gateway forwards the original request through the service binding", async () => {
  let forwarded;
  const request = new Request("https://xuanche-engine-gateway.pages.dev/health?deep=0", {
    headers: { "X-API-Key": "test-key" },
  });
  const response = await onRequest({
    request,
    env: {
      XUANCHE_ENGINE: {
        async fetch(incoming) {
          forwarded = incoming;
          return Response.json({ ok: true, service: "xuanche-engine" });
        },
      },
    },
  });

  assert.equal(forwarded, request);
  assert.equal(forwarded.headers.get("x-api-key"), "test-key");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-xuanche-gateway"), "cloudflare-pages");
  assert.equal((await response.json()).ok, true);
});

test("Pages gateway fails safely when the service binding is missing", async () => {
  const response = await onRequest({
    request: new Request("https://xuanche-engine-gateway.pages.dev/health"),
    env: {},
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "XUANCHE_ENGINE service binding is not configured",
  });
});
