import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompactGptActionSpec,
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

function openApiFixture(version = "0.5.16") {
  return {
    openapi: "3.1.0",
    info: { title: "Xuanche Engine API", version },
    servers: [{ url: "https://old.example" }],
    components: {
      schemas: {
        WorldLoadRequest: { type: "object", properties: {} },
        WorldInitializeRequest: { type: "object", properties: {} },
        WorldArchiveResetRequest: { type: "object", properties: {} },
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
      "/world/initialize": { post: { operationId: "initializeWorld" } },
      "/world/archive-reset": { post: { operationId: "archiveAndResetWorld" } },
      "/world/archive-reset/status": { get: { operationId: "getArchiveAndResetStatus" } },
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

function archiveStatusData(overrides = {}) {
  return {
    accepted: true,
    completed: false,
    safeToInitialize: false,
    archiveVerified: false,
    reset: false,
    worldState: "ARCHIVING",
    phase: "archiving",
    operationKey: "archive-reset-20260718-001",
    archiveId: "A-W20260717-432D5443-001",
    workflowId: "workflow-001",
    workflowStatus: "running",
    workflowAttempt: 1,
    continuationSequence: 0,
    progress: {
      archivedPageKeys: [],
      archivedPageCount: 0,
      resetPageKeys: [],
      resetPageCount: 0,
      totalPageCount: 10,
    },
    retryable: false,
    requiresOperatorAction: false,
    nextAction: "POLL_STATUS",
    nextPollAfterSeconds: 3,
    error: null,
    ...overrides,
  };
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
  assert.equal(result._gateway.version, "0.5.13");
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

  assert.equal(patched.info.version, "0.5.13");
  assert.equal(
    patched.externalDocs.url,
    "https://xuanche-engine-gateway.pages.dev/privacy",
  );
  assert.match(patched.info.description, /\/privacy/);
  assert.deepEqual(operationIds(patched), [
    "archiveAndResetWorld",
    "getArchiveAndResetStatus",
    "getEngineHealth",
    "getGitHubWorldFile",
    "getNotionPage",
    "getNotionTree",
    "initializeWorld",
    "listGitHubWorldTree",
    "loadWorldProfile",
    "updateWorldState",
  ]);
  assert.equal(patched.paths["/home"], undefined);
  assert.equal(patched.paths["/page/{id}"], undefined);
  assert.ok(patched.paths["/world/load"]);
  assert.ok(patched.paths["/world/initialize"]);
  assert.ok(patched.paths["/world/archive-reset"]);
  assert.ok(patched.paths["/world/archive-reset/status"]);
  assert.ok(patched.paths["/world/update"]);
  assert.equal(patched.paths["/future/batch"], undefined);
  assert.ok(patched.components.schemas.WorldLoadRequest);
  assert.ok(patched.components.schemas.WorldInitializeRequest);
  assert.ok(patched.components.schemas.WorldArchiveResetRequest);
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

test("publishes the minimal structured gameplay manifest for ChatGPT Actions", async () => {
  const spec = buildCompactGptActionSpec("https://xuanche-engine-gateway.pages.dev");
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.info.version, "0.5.13");
  assert.deepEqual(spec.servers, [{ url: "https://xuanche-engine-gateway.pages.dev" }]);
  assert.deepEqual(operationIds(spec), [
    "archiveAndResetWorld",
    "getArchiveAndResetStatus",
    "getNotionPage",
    "getNotionTree",
    "initializeWorld",
    "updateWorldState",
  ]);
  assert.equal(spec.paths["/health"], undefined);
  assert.equal(spec.paths["/world/load"], undefined);
  assert.equal(spec.paths["/github/tree"], undefined);
  assert.equal(spec.paths["/github/file"], undefined);
  assert.ok(spec.components.schemas.ArchiveResetEnvelope);
  assert.ok(spec.components.schemas.InitializeWorldEnvelope);
  assert.ok(spec.components.schemas.UpdateWorldEnvelope);
  assert.ok(spec.components.schemas.ReadEnvelope);
  assert.ok(spec.components.schemas.ErrorEnvelope);
  assert.deepEqual(spec.paths["/world/archive-reset"].post.security, [{ apiKey: [] }]);
  assert.equal(spec.paths["/world/archive-reset"].post.requestBody.required, true);
  const archiveSchema = spec.paths["/world/archive-reset"].post.requestBody.content["application/json"].schema;
  assert.deepEqual(archiveSchema.required, ["confirmation", "expectedWorldId", "operationKey"]);
  assert.deepEqual(Object.keys(archiveSchema.properties), ["confirmation", "expectedWorldId", "operationKey"]);
  assert.equal(archiveSchema.additionalProperties, false);
  assert.ok(spec.paths["/world/archive-reset"].post.responses["202"]);
  assert.equal(spec.paths["/world/archive-reset"].post.responses["200"], undefined);
  assert.match(spec.paths["/world/archive-reset"].post.description, /HTTP 202/);
  assert.match(spec.paths["/world/archive-reset/status"].get.description, /archiveId/);
  assert.ok(spec.paths["/page"].get.parameters.some((parameter) => parameter.name === "id" && parameter.required));
  assert.equal(spec.paths["/tree"].get.parameters.some((parameter) => parameter.name === "cursor"), false);

  const initializeSchema = spec.paths["/world/initialize"].post.requestBody.content["application/json"].schema;
  assert.equal(initializeSchema.required.includes("opening"), false);
  assert.deepEqual(initializeSchema.properties.character.required, ["name", "motto", "coreDesire", "weaknessFear"]);
  for (const field of ["motto", "importantBonds", "coreDesire", "weaknessFear", "startingStyle", "destinyTalents", "relationships"]) {
    assert.ok(Object.hasOwn(initializeSchema.properties.character.properties, field));
  }
  assert.deepEqual(initializeSchema.properties.opening.required, ["location", "time", "premise"]);
  assert.equal(initializeSchema.properties.saveKey.minLength, 1);
  assert.equal(initializeSchema.properties.saveKey.maxLength, 200);
  assert.ok(initializeSchema.properties.character.properties.age.oneOf);
  assert.ok(initializeSchema.properties.character.properties.personality.oneOf);

  const updateSchema = spec.paths["/world/update"].post.requestBody.content["application/json"].schema;
  assert.ok(updateSchema.required.includes("expectedRevision"));
  assert.deepEqual(updateSchema.properties.expectedWorldState.enum, ["ACTIVE"]);
  assert.deepEqual(updateSchema.anyOf, [{ required: ["children"] }, { required: ["blockUpdates"] }]);
  assert.equal(updateSchema.properties.children.items.type, "string");
  assert.equal(updateSchema.properties.children.items.maxLength, 1800);
  assert.equal(updateSchema.properties.saveKey.minLength, 1);
  assert.equal(updateSchema.properties.saveKey.maxLength, 200);
  assert.equal(updateSchema.properties.cachePatch, undefined);

  const response = await onRequest({
    request: new Request("https://xuanche-engine-gateway.pages.dev/gpt-action-openapi.json"),
    env: {},
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), spec);
});

test("archive Action schema exposes and forwards every destructive-operation field", async () => {
  const payload = {
    confirmation: "ARCHIVE_AND_RESET",
    expectedWorldId: "W20260717-432D5443",
    operationKey: "archive-reset-20260718-001",
  };
  let received;
  const response = await onRequest({
    request: new Request("https://xuanche-engine-gateway.pages.dev/world/archive-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "test" },
      body: JSON.stringify(payload),
    }),
    env: {
      XUANCHE_ENGINE: {
        async fetch(request) {
          if (new URL(request.url).pathname === "/health") {
            return Response.json({ ok: true, version: "0.5.16" });
          }
          received = {
            url: request.url,
            method: request.method,
            headers: Object.fromEntries(request.headers),
            body: await request.json(),
          };
          return Response.json({ ok: true, data: archiveStatusData(), requestId: "request-archive" }, { status: 202 });
        },
      },
    },
  });

  assert.equal(response.status, 202);
  assert.equal(new URL(received.url).pathname, "/world/archive-reset");
  assert.equal(received.method, "POST");
  assert.equal(received.headers["x-api-key"], "test");
  assert.deepEqual(received.body, payload);
  const responseBody = await response.json();
  assert.equal(responseBody.data.operationKey, payload.operationKey);
  assert.equal(responseBody.data.nextAction, "POLL_STATUS");
  assert.equal(responseBody.data.safeToInitialize, false);
});

test("archive status preserves the complete v0.5.16 workflow result", async () => {
  const completed = archiveStatusData({
    completed: true,
    safeToInitialize: true,
    archiveVerified: true,
    reset: true,
    worldState: "EMPTY",
    phase: "complete",
    workflowStatus: "complete",
    progress: {
      archivedPageKeys: ["02", "03"],
      archivedPageCount: 2,
      resetPageKeys: ["02", "03"],
      resetPageCount: 2,
      totalPageCount: 2,
    },
    nextAction: "INITIALIZE_WORLD",
    nextPollAfterSeconds: null,
  });
  let receivedPath = "";
  const response = await onRequest({
    request: new Request("https://xuanche-engine-gateway.pages.dev/world/archive-reset/status?expectedWorldId=W20260717-432D5443&operationKey=archive-reset-20260718-001", {
      headers: { "X-API-Key": "test" },
    }),
    env: {
      XUANCHE_ENGINE: {
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/health") return Response.json({ ok: true, version: "0.5.16" });
          receivedPath = path;
          return Response.json({ ok: true, data: completed, requestId: "request-status" });
        },
      },
    },
  });

  const responseBody = await response.json();
  assert.equal(response.status, 200);
  assert.equal(receivedPath, "/world/archive-reset/status");
  assert.deepEqual(responseBody.data, completed);
  assert.equal(responseBody.data.safeToInitialize, true);
  assert.equal(responseBody.data.nextAction, "INITIALIZE_WORLD");
});

test("the Pages handler serves the filtered 0.5.13 OpenAPI document", async () => {
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
  assert.equal(response.headers.get("X-Xuanche-Gateway-Version"), "0.5.13");
  assert.equal(document.info.version, "0.5.13");
  assert.equal(
    document.externalDocs.url,
    "https://xuanche-engine-gateway.pages.dev/privacy",
  );
  assert.deepEqual(operationIds(document), [
    "archiveAndResetWorld",
    "getArchiveAndResetStatus",
    "getEngineHealth",
    "getGitHubWorldFile",
    "getNotionPage",
    "getNotionTree",
    "initializeWorld",
    "listGitHubWorldTree",
    "loadWorldProfile",
    "updateWorldState",
  ]);
});

test("hides world state actions when the bound Worker is older than 0.5.6", () => {
  const patched = patchOpenApi(
    openApiFixture("0.5.3"),
    "https://xuanche-engine-gateway.pages.dev",
  );
  assert.equal(patched["x-xuanche-backend"].worldStateReady, false);
  assert.equal(patched.paths["/world/load"], undefined);
  assert.equal(patched.paths["/world/initialize"], undefined);
  assert.equal(patched.paths["/world/archive-reset"], undefined);
  assert.equal(patched.paths["/world/update"], undefined);
  assert.equal(patched.components.schemas.WorldLoadRequest, undefined);
  assert.equal(patched.components.schemas.WorldInitializeRequest, undefined);
  assert.equal(patched.components.schemas.WorldArchiveResetRequest, undefined);
  assert.equal(patched.components.schemas.WorldUpdateRequest, undefined);
});

test("keeps load/update but hides initialization on a 0.5.6 backend", () => {
  const patched = patchOpenApi(
    openApiFixture("0.5.6"),
    "https://xuanche-engine-gateway.pages.dev",
  );
  assert.equal(patched["x-xuanche-backend"].worldStateReady, true);
  assert.equal(patched["x-xuanche-backend"].initializationReady, false);
  assert.ok(patched.paths["/world/load"]);
  assert.ok(patched.paths["/world/update"]);
  assert.equal(patched.paths["/world/initialize"], undefined);
  assert.equal(patched.paths["/world/archive-reset"], undefined);
  assert.equal(patched.components.schemas.WorldInitializeRequest, undefined);
  assert.equal(patched.components.schemas.WorldArchiveResetRequest, undefined);
});

test("keeps initialization but hides archive actions on a pre-0.5.16 backend", () => {
  const patched = patchOpenApi(
    openApiFixture("0.5.15"),
    "https://xuanche-engine-gateway.pages.dev",
  );
  assert.equal(patched["x-xuanche-backend"].worldStateReady, true);
  assert.equal(patched["x-xuanche-backend"].initializationReady, true);
  assert.equal(patched["x-xuanche-backend"].archiveResetReady, false);
  assert.ok(patched.paths["/world/initialize"]);
  assert.equal(patched.paths["/world/archive-reset"], undefined);
  assert.equal(patched.paths["/world/archive-reset/status"], undefined);
  assert.equal(patched.components.schemas.WorldArchiveResetRequest, undefined);
});

test("rejects world writes while the bound Worker is older than 0.5.6", async () => {
  let updateCalls = 0;
  const response = await onRequest({
    request: new Request("https://xuanche-engine-gateway.pages.dev/world/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env: {
      XUANCHE_ENGINE: {
        async fetch(request) {
          if (new URL(request.url).pathname === "/health") {
            return Response.json({ ok: true, version: "0.5.3" });
          }
          updateCalls += 1;
          return Response.json({ ok: true });
        },
      },
    },
  });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.match(body.error, /0\.5\.6/);
  assert.equal(updateCalls, 0);
});

test("rejects initialization while the bound Worker is older than 0.5.7", async () => {
  let initializeCalls = 0;
  const response = await onRequest({
    request: new Request("https://xuanche-engine-gateway.pages.dev/world/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env: {
      XUANCHE_ENGINE: {
        async fetch(request) {
          if (new URL(request.url).pathname === "/health") {
            return Response.json({ ok: true, version: "0.5.6" });
          }
          initializeCalls += 1;
          return Response.json({ ok: true });
        },
      },
    },
  });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.match(body.error, /0\.5\.7/);
  assert.equal(initializeCalls, 0);
});

test("rejects archive start and status while the bound Worker is older than 0.5.16", async () => {
  const cases = [
    ["https://xuanche-engine-gateway.pages.dev/world/archive-reset", "POST"],
    ["https://xuanche-engine-gateway.pages.dev/world/archive-reset/status?expectedWorldId=W20260717-432D5443&operationKey=archive-reset-001", "GET"],
  ];

  for (const [url, method] of cases) {
    let operationCalls = 0;
    const response = await onRequest({
      request: new Request(url, method === "POST" ? {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      } : { method }),
      env: {
        XUANCHE_ENGINE: {
          async fetch(request) {
            if (new URL(request.url).pathname === "/health") {
              return Response.json({ ok: true, version: "0.5.15" });
            }
            operationCalls += 1;
            return Response.json({ ok: true });
          },
        },
      },
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.match(body.error, /0\.5\.16/);
    assert.equal(operationCalls, 0);
  }
});

test("serves a public Traditional Chinese privacy policy without an upstream binding", async () => {
  const response = await onRequest({
    request: new Request("https://xuanche-engine-gateway.pages.dev/privacy"),
    env: {},
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.equal(response.headers.get("X-Xuanche-Gateway-Version"), "0.5.13");
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
  assert.equal(response.headers.get("X-Xuanche-Gateway-Version"), "0.5.13");
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
  assert.equal(parsed._gateway.version, "0.5.13");
  assert.equal(parsed._gateway.returnedChars, body.length);
});
