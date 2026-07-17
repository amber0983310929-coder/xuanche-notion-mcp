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

function openApiFixture() {
  return {
    openapi: "3.1.0",
    info: { title: "Xuanche Engine API", version: "0.5.4" },
    servers: [{ url: "https://old.example" }],
    components: {
      schemas: {
        WorldLoadRequest: { type: "object", properties: {} },
        WorldUpdateRequest: { type: "object", properties: {} },
      },
    },
    paths: {
      "/health": { get: { operationId: "getEngineHealth" } },
      "/home": { get: { operationId: "getWorldHome" } },
      "/tree": {
        get: {
          operationId: "getNotionTree",
          parameters: [
            { name: "depth", in: "query", schema: { type: "integer", default: 6, maximum: 20 } },
            { name: "maxNodes", in: "query", schema: { type: "integer", default: 5000, maximum: 20000 } },
          ],
        },
      },
      "/page": {
        get: {
          operationId: "getNotionPage",
          parameters: [
            { name: "id", in: "query", required: true, schema: { type: "string" } },
            { name: "depth", in: "query", schema: { type: "integer", default: 6, maximum: 20 } },
            { name: "maxNodes", in: "query", schema: { type: "integer", default: 5000, maximum: 20000 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
        },
      },
      "/page/{id}": { get: { operationId: "getNotionPageTreeById" } },
      "/world/load": { post: { operationId: "loadWorldProfile" } },
      "/world/update": { post: { operationId: "updateWorldState" } },
      "/notion/pages": { post: { operationId: "createNotionPage" } },
      "/notion/blocks/{id}/children": { post: { operationId: "appendNotionBlocks" } },
      "/notion/pages/{id}": { patch: { operationId: "updateNotionPage" } },
      "/github/tree": { get: { operationId: "listGitHubWorldTree" } },
      "/github/file": { get: { operationId: "getGitHubWorldFile" } },
      "/future/batch": { post: { operationId: "futureUnknownBatchOperation" } },
    },
  };
}

function operationIds(document) {
  return Object.values(document.paths)
    .flatMap((path) => Object.values(path))
    .map((operation) => operation?.operationId)
    .filter(Boolean)
    .sort();
}

test("compacts raw Notion blocks and removes noisy metadata", () => {
  const payload = { ok: true, data: { blocks: [paragraph("1", "玄澈修真世界")] } };
  const result = compactActionResponse(payload, { maxChars: 20_000, limit: 30 });

  assert.equal(result.data.blocks[0].text, "玄澈修真世界");
  assert.equal(result.data.result_count, 1);
  assert.equal(result.data.has_content, true);
  assert.equal(result.data.content_text, "玄澈修真世界");
  assert.equal(result.data.content_text_complete, true);
  assert.equal(result.data.blocks[0].created_time, undefined);
  assert.equal(result.data.blocks[0].parent, undefined);
  assert.equal(result._gateway.compact, true);
  assert.equal(result._gateway.version, "0.5.6");
  assert.equal(result._gateway.returnedChars, JSON.stringify(result).length);
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

test("reports truncation when a single oversized Notion string is shortened", () => {
  const result = compactActionResponse(
    { ok: true, data: { results: [{ id: "1", text: "玄".repeat(13_000) }] } },
    { maxChars: 20_000, limit: 10, pageBatch: true },
  );

  assert.equal(result._gateway.truncatedStrings, 1);
  assert.equal(result._gateway.truncated, true);
  assert.equal(result.data.truncated, true);
  assert.ok(result.data.items[0].text.length < 13_000);
});

test("clamps upstream tree requests and strips gateway-only parameters", () => {
  const request = new Request(
    "https://xuanche-engine-gateway.pages.dev/tree?depth=6&maxNodes=2000&offset=20&limit=30&maxChars=72000",
    { headers: { "X-API-Key": "test" } },
  );
  const upstream = buildUpstreamRequest(request);
  const url = new URL(upstream.url);

  assert.equal(url.searchParams.get("maxNodes"), "250");
  assert.equal(url.searchParams.get("offset"), null);
  assert.equal(url.searchParams.get("limit"), null);
  assert.equal(url.searchParams.get("depth"), "0");
  assert.equal(upstream.headers.get("X-API-Key"), "test");
});

test("clamps page batches while preserving the native Notion cursor", () => {
  const request = new Request(
    "https://xuanche-engine-gateway.pages.dev/page?id=module-14&depth=6&maxNodes=5000&cursor=next-batch&maxChars=72000",
    { headers: { "X-API-Key": "test" } },
  );
  const upstream = buildUpstreamRequest(request);
  const url = new URL(upstream.url);

  assert.equal(url.searchParams.get("maxNodes"), "20");
  assert.equal(url.searchParams.get("cursor"), "next-batch");
  assert.equal(url.searchParams.get("depth"), "0");
  assert.equal(url.searchParams.get("maxChars"), null);
});

test("publishes only the safety-scoped GPT Action operations with bounded page reads", () => {
  const patched = patchOpenApi(openApiFixture(), "https://xuanche-engine-gateway.pages.dev");
  const parameters = patched.paths["/tree"].get.parameters;

  assert.equal(patched.info.version, "0.5.6");
  assert.equal(
    patched.externalDocs.url,
    "https://xuanche-engine-gateway.pages.dev/privacy",
  );
  assert.match(patched.info.description, /\/privacy/);
  assert.deepEqual(operationIds(patched), [
    "getEngineHealth",
    "getGitHubWorldFile",
    "getNotionPage",
    "getNotionTree",
    "listGitHubWorldTree",
    "loadWorldProfile",
    "updateWorldState",
  ]);
  assert.equal(patched.paths["/home"], undefined);
  assert.equal(patched.paths["/page/{id}"], undefined);
  assert.ok(patched.paths["/world/load"]);
  assert.ok(patched.paths["/world/update"]);
  assert.equal(patched.paths["/future/batch"], undefined);
  assert.ok(patched.components.schemas.WorldLoadRequest);
  assert.ok(patched.components.schemas.WorldUpdateRequest);

  assert.equal(parameters.find((item) => item.name === "depth").schema.default, 0);
  assert.equal(parameters.find((item) => item.name === "depth").schema.maximum, 0);
  assert.equal(parameters.find((item) => item.name === "maxNodes").schema.default, 60);
  assert.equal(parameters.find((item) => item.name === "maxNodes").schema.maximum, 250);
  assert.ok(parameters.some((item) => item.name === "offset"));
  assert.ok(parameters.some((item) => item.name === "limit"));
  assert.ok(parameters.some((item) => item.name === "maxChars"));

  const pageParameters = patched.paths["/page"].get.parameters;
  assert.equal(pageParameters.find((item) => item.name === "depth").schema.maximum, 0);
  assert.equal(pageParameters.find((item) => item.name === "maxNodes").schema.default, 10);
  assert.equal(pageParameters.find((item) => item.name === "maxNodes").schema.maximum, 20);
  assert.match(pageParameters.find((item) => item.name === "maxNodes").description, /defaults to 10/);
  assert.match(pageParameters.find((item) => item.name === "maxNodes").description, /clamps every request to 20/);
  assert.ok(pageParameters.some((item) => item.name === "maxChars"));
  assert.match(patched.paths["/page"].get.description, /00–31/);
  assert.match(patched.paths["/page"].get.description, /30-x/);
  assert.match(patched.paths["/page"].get.description, /31 experience card/);

  assert.equal(
    patched.paths["/page"].get.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/PageBatchResponse",
  );
  const pageDataSchema = patched.components.schemas.PageBatchResponse.properties.data;
  assert.deepEqual(pageDataSchema.required, ["items", "has_more", "cursor", "truncated"]);
  assert.equal(pageDataSchema.properties.items.type, "array");
  assert.equal(pageDataSchema.properties.has_more.type, "boolean");
  assert.equal(pageDataSchema.properties.cursor.nullable, true);
  assert.equal(pageDataSchema.properties.truncated.type, "boolean");
  assert.equal(
    patched.components.schemas.PageBatchResponse.properties._gateway.properties.truncated.type,
    "boolean",
  );
});

test("the Pages handler serves the filtered 0.5.6 OpenAPI document", async () => {
  const response = await onRequest({
    request: new Request("https://xuanche-engine-gateway.pages.dev/openapi.json"),
    env: {
      XUANCHE_ENGINE: {
        async fetch() {
          return Response.json(openApiFixture());
        },
      },
    },
  });
  const document = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Xuanche-Gateway-Version"), "0.5.6");
  assert.equal(document.info.version, "0.5.6");
  assert.equal(
    document.externalDocs.url,
    "https://xuanche-engine-gateway.pages.dev/privacy",
  );
  assert.deepEqual(operationIds(document), [
    "getEngineHealth",
    "getGitHubWorldFile",
    "getNotionPage",
    "getNotionTree",
    "listGitHubWorldTree",
    "loadWorldProfile",
    "updateWorldState",
  ]);
});

test("serves a public Traditional Chinese privacy policy without an upstream binding", async () => {
  const response = await onRequest({
    request: new Request("https://xuanche-engine-gateway.pages.dev/privacy"),
    env: {},
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.equal(response.headers.get("X-Xuanche-Gateway-Version"), "0.5.6");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(body, /lang="zh-Hant"/);
  assert.match(body, /X-API-Key/);
  assert.match(body, /Notion/);
  assert.match(body, /GitHub/);
  assert.match(body, /Cloudflare/);
  assert.match(body, /不出售個人資料/);
  assert.match(body, /保存與刪除/);
  assert.match(body, /github\.com\/amber0983310929-coder/);
  assert.doesNotMatch(body, /app\.example\.com/);
});

test("full Pages handler compacts a large module response before returning it to GPT", async () => {
  const blocks = Array.from(
    { length: 100 },
    (_, index) => paragraph(String(index), `規則段落 ${index} ${"內容".repeat(500)}`),
  );
  let upstreamUrl = "";
  const response = await onRequest({
    request: new Request(
      "https://xuanche-engine-gateway.pages.dev/page?id=module-14&depth=0&maxNodes=5000",
      { headers: { "X-API-Key": "test" } },
    ),
    env: {
      XUANCHE_ENGINE: {
        async fetch(request) {
          upstreamUrl = request.url;
          return new Response(JSON.stringify({
            ok: true,
            data: {
              object: "list",
              results: blocks,
              next_cursor: "batch-2",
              has_more: true,
              type: "block",
              block: {},
            },
            requestId: "request-1",
          }), {
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    },
  });
  const body = await response.text();
  const parsed = JSON.parse(body);

  assert.equal(new URL(upstreamUrl).searchParams.get("maxNodes"), "20");
  assert.equal(response.headers.get("X-Xuanche-Compacted"), "true");
  assert.equal(response.headers.get("X-Xuanche-Page-Batch-Sizing"), "true");
  assert.equal(response.headers.get("X-Xuanche-Page-Batch-Limit"), "20");
  assert.equal(response.headers.get("X-Xuanche-Readable-Page-Payload"), "true");
  assert.equal(response.headers.get("X-Xuanche-Gateway-Version"), "0.5.6");
  assert.ok(body.length < 72_000);
  assert.equal(parsed.data.items.length, 20);
  assert.equal(parsed.data.items[0].id, "0");
  assert.equal(parsed.data.result_count, 20);
  assert.equal(parsed.data.has_content, true);
  assert.match(parsed.data.content_text, /規則段落 0/);
  assert.equal(parsed.data.has_more, true);
  assert.equal(parsed.data.cursor, "batch-2");
  assert.equal(parsed.data.truncated, false);
  assert.equal(parsed.data.results, undefined);
  assert.equal(parsed._gateway.version, "0.5.6");
  assert.equal(parsed._gateway.returnedChars, body.length);
});
