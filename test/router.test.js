import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/router.js";

test("health reports integrations without exposing secrets", async () => {
  const route = createRouter();
  const response = await route(new Request("https://example.test/health"), {
    NOTION_TOKEN: "secret",
    GITHUB_TOKEN: "secret",
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.integrations.notion, "configured");
  assert.equal(body.integrations.github, "configured");
  assert.equal(body.capabilities.shallowPageBatchSizing, true);
  assert.equal(body.capabilities.atomicWorldInitialization, true);
  assert.equal(body.capabilities.stableWorldPageKeys, true);
  assert.equal(body.capabilities.semanticBlockTargets, true);
  assert.equal(body.capabilities.idempotentRevisionReplay, true);
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("mutation endpoints reject missing API keys", async () => {
  const route = createRouter();
  const response = await route(new Request("https://example.test/world/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }), { NOTION_TOKEN: "test", XUANCHE_API_KEY: "required" });
  assert.equal(response.status, 401);

  const initializeResponse = await route(new Request("https://example.test/world/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }), { NOTION_TOKEN: "test", XUANCHE_API_KEY: "required" });
  assert.equal(initializeResponse.status, 401);
});

test("archive reset is queued into a durable workflow and exposes an inspectable status", async () => {
  const records = new Map();
  let submitted;
  const workflow = {
    async createBatch(batch) { submitted = batch; return [{ id: batch[0].id }]; },
    async get(id) {
      return {
        id,
        async status() { return { status: "queued" }; },
      };
    },
  };
  const cache = {
    kv: {},
    async get(key) { return records.get(key); },
    async put(key, value) { records.set(key, value); return value; },
    async delete(key) { records.delete(key); },
    async deletePrefix() { return 0; },
  };
  const notion = {
    configured: true,
    async getPageTree() {
      return {
        children: [
          { type: "paragraph", paragraph: { rich_text: [{ plain_text: "WORLD_STATE：ACTIVE" }] } },
          { type: "paragraph", paragraph: { rich_text: [{ plain_text: "WORLD_ID：W20260717-432D5443" }] } },
        ],
      };
    },
  };
  const route = createRouter({ cache, notion });
  const body = {
    confirmation: "ARCHIVE_AND_RESET",
    expectedWorldId: "W20260717-432D5443",
    operationKey: "archive-reset-20260718-001",
  };
  const response = await route(new Request("https://example.test/world/archive-reset", {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": "required" },
    body: JSON.stringify(body),
  }), { XUANCHE_API_KEY: "required", WORLD_RESET_WORKFLOW: workflow });
  const payload = await response.json();

  assert.equal(response.status, 202);
  assert.equal(payload.data.workflowStatus, "queued");
  assert.equal(payload.data.worldState, "ARCHIVING");
  assert.equal(payload.data.reset, false);
  assert.deepEqual(submitted[0].params, body);

  const status = await route(new Request(
    "https://example.test/world/archive-reset/status?expectedWorldId=W20260717-432D5443&operationKey=archive-reset-20260718-001",
    { headers: { "X-API-Key": "required" } },
  ), { XUANCHE_API_KEY: "required", WORLD_RESET_WORKFLOW: workflow });
  const statusPayload = await status.json();
  assert.equal(status.status, 200);
  assert.equal(statusPayload.data.workflowStatus, "queued");
});

test("archive reset refuses to run synchronously without its durable workflow", async () => {
  const route = createRouter();
  const response = await route(new Request("https://example.test/world/archive-reset", {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": "required" },
    body: JSON.stringify({
      confirmation: "ARCHIVE_AND_RESET",
      expectedWorldId: "W20260717-432D5443",
      operationKey: "archive-reset-20260718-001",
    }),
  }), { XUANCHE_API_KEY: "required" });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.match(body.error, /Durable archive workflow binding/);
});

test("raw Notion mutation routes are disabled by default", async () => {
  const route = createRouter();
  const response = await route(new Request("https://example.test/notion/pages", {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": "required" },
    body: JSON.stringify({ parentPageId: "11111111111111111111111111111111", title: "test" }),
  }), { NOTION_TOKEN: "test", XUANCHE_API_KEY: "required" });
  assert.equal(response.status, 404);
});

test("home retains the existing shallow block-children behavior and HOME_PAGE_ID alias", async () => {
  const notion = {
    configured: true,
    listBlockChildren: async (id) => ({ object: "list", id, results: [] }),
  };
  const route = createRouter({ notion });
  const response = await route(new Request("https://example.test/home"), {
    HOME_PAGE_ID: "11111111111111111111111111111111",
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.object, "list");
});

test("protected read endpoints reject a missing API key", async () => {
  const notion = {
    configured: true,
    listBlockChildren: async () => ({ object: "list", results: [] }),
  };
  const route = createRouter({ notion });
  const response = await route(new Request("https://example.test/home"), {
    HOME_PAGE_ID: "11111111111111111111111111111111",
    PROTECT_READS: "true",
    XUANCHE_API_KEY: "required",
  });
  assert.equal(response.status, 401);
});

test("protected read endpoints accept X-API-Key", async () => {
  const notion = {
    configured: true,
    listBlockChildren: async (id) => ({ object: "list", id, results: [] }),
  };
  const route = createRouter({ notion });
  const response = await route(new Request("https://example.test/home", {
    headers: { "X-API-Key": "required" },
  }), {
    HOME_PAGE_ID: "11111111111111111111111111111111",
    PROTECT_READS: "true",
    XUANCHE_API_KEY: "required",
  });
  assert.equal(response.status, 200);
});

test("legacy /page?id route remains available", async () => {
  const notion = {
    configured: true,
    listBlockChildren: async (id) => ({ object: "list", id, results: [] }),
  };
  const route = createRouter({ notion });
  const response = await route(new Request("https://example.test/page?id=11111111111111111111111111111111"), {});
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.object, "list");
});

test("shallow page reads honor maxNodes as the Notion page size", async () => {
  let received;
  const notion = {
    configured: true,
    listBlockChildren: async (id, options) => {
      received = { id, options };
      return { object: "list", results: [] };
    },
  };
  const route = createRouter({ notion });
  const response = await route(new Request(
    "https://example.test/page?id=11111111111111111111111111111111&depth=0&maxNodes=10&cursor=next-page",
  ), {});

  assert.equal(response.status, 200);
  assert.equal(received.id, "11111111111111111111111111111111");
  assert.deepEqual(received.options, { startCursor: "next-page", pageSize: 10 });
});

test("shallow page reads clamp maxNodes to Notion's 100-block limit", async () => {
  let pageSize;
  const notion = {
    configured: true,
    listBlockChildren: async (_id, options) => {
      pageSize = options.pageSize;
      return { object: "list", results: [] };
    },
  };
  const route = createRouter({ notion });
  const response = await route(new Request(
    "https://example.test/page/11111111111111111111111111111111?depth=0&maxNodes=5000",
  ), {});

  assert.equal(response.status, 200);
  assert.equal(pageSize, 100);
});
