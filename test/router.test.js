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
