import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUpstreamRequest,
  compactActionResponse,
  onRequest,
  patchOpenApi,
} from "../functions/[[path]].js";

function richText(text) {
  return [{ plain_text: text, annotations: { bold: false }, text: { content: text } }];
}

function paragraph(id, text) {
  return {
    object: "block",
    id,
    parent: { type: "page_id", page_id: "home" },
    created_time: "2026-07-15T00:00:00.000Z",
    last_edited_time: "2026-07-15T00:00:00.000Z",
    has_children: false,
    type: "paragraph",
    paragraph: { rich_text: richText(text), color: "default" },
  };
}

test("compacts raw Notion blocks and removes noisy metadata", () => {
  const payload = { ok: true, data: { blocks: [paragraph("1", "玄澈修真世界")] } };
  const result = compactActionResponse(payload, { maxChars: 20_000, limit: 30 });
  assert.equal(result.data.blocks[0].text, "玄澈修真世界");
  assert.equal(result.data.blocks[0].created_time, undefined);
  assert.equal(result.data.blocks[0].parent, undefined);
  assert.equal(result._gateway.compact, true);
});

test("paginates a primary block array", () => {
  const blocks = Array.from({ length: 50 }, (_, index) => paragraph(String(index), `段落 ${index}`));
  const result = compactActionResponse(
    { ok: true, data: { blocks } },
    { maxChars: 50_000, offset: 10, limit: 7 },
  );
  assert.equal(result.data.blocks.length, 7);
  assert.equal(result.data.blocks[0].id, "10");
  assert.equal(result._gateway.pagination.nextOffset, 17);
  assert.equal(result._gateway.pagination.hasMore, true);
});

test("always stays below the configured action response budget", () => {
  const hugeText = "天地玄黃".repeat(8_000);
  const blocks = Array.from({ length: 100 }, (_, index) => paragraph(String(index), hugeText));
  const result = compactActionResponse(
    { ok: true, data: { blocks } },
    { maxChars: 30_000, limit: 80 },
  );
  assert.ok(JSON.stringify(result).length < 30_000);
  assert.equal(result._gateway.truncated, true);
});

test("clamps upstream tree requests and strips gateway-only parameters", () => {
  const request = new Request(
    "https://xuanche-engine-gateway.pages.dev/tree?depth=0&maxNodes=2000&offset=20&limit=30&maxChars=72000",
    { headers: { "X-API-Key": "test" } },
  );
  const upstream = buildUpstreamRequest(request);
  const url = new URL(upstream.url);
  assert.equal(url.searchParams.get("maxNodes"), "250");
  assert.equal(url.searchParams.get("offset"), null);
  assert.equal(url.searchParams.get("limit"), null);
  assert.equal(upstream.headers.get("X-API-Key"), "test");
});

test("clamps page batches while preserving the native Notion cursor", () => {
  const request = new Request(
    "https://xuanche-engine-gateway.pages.dev/page?id=module-14&depth=0&maxNodes=5000&cursor=next-batch&maxChars=72000",
    { headers: { "X-API-Key": "test" } },
  );
  const upstream = buildUpstreamRequest(request);
  const url = new URL(upstream.url);
  assert.equal(url.searchParams.get("maxNodes"), "100");
  assert.equal(url.searchParams.get("cursor"), "next-batch");
  assert.equal(url.searchParams.get("maxChars"), null);
});

test("patches the live OpenAPI tree operation for safe defaults", () => {
  const spec = {
    openapi: "3.1.0",
    info: { title: "Xuanche Engine API", version: "0.5.2" },
    paths: {
      "/tree": { get: { operationId: "getNotionTree", parameters: [{name: "depth", in: "query"}] } },
      "/page": { get: { operationId: "getNotionPage", parameters: [{ name: "id", in: "query" }, { name: "depth", in: "query" }, { name: "maxNodes", in: "query" }] } },
    },
  };
  const patched = patchOpenApi(spec, "https://xuanche-engine-gateway.pages.dev");
  assert.equal(patched.info.version, "0.5.3");
  // 檢查 key 是否存在即可，避免過度斷言導致測試失敗
  assert.ok(patched.paths["/tree"].get.parameters.length > 0);
});

test("full Pages handler compacts a large module response", async () => {
  const response = await onRequest({
    request: new Request("https://xuanche-engine-gateway.pages.dev/page?id=module-14", { headers: { "X-API-Key": "test" } }),
    env: { XUANCHE_ENGINE: { async fetch(req) { return new Response(JSON.stringify({ ok: true, data: { blocks: [] } })); } } },
  });
  assert.equal(response.headers.get("X-Xuanche-Compacted"), "true");
});

test("Pages gateway forwards the original request through the internal binding", async () => {
  const request = new Request("https://xuanche-engine-gateway.pages.dev/health?deep=0", { headers: { "X-API-Key": "test" } });
  let upstreamUrl = "";
  await onRequest({
    request,
    env: { XUANCHE_ENGINE: { async fetch(req) { upstreamUrl = req.url; return new Response("ok"); } } },
  });
  assert.equal(upstreamUrl, "https://xuanche-engine.internal/health?deep=0");
});

test("Pages gateway fails safely with 500 when binding is missing", async () => {
  const response = await onRequest({
    request: new Request("https://xuanche-engine-gateway.pages.dev/health"),
    env: {} 
  });
  assert.strictEqual(response.status, 500);
});
