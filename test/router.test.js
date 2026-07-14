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
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("mutation endpoints reject missing API keys", async () => {
  const route = createRouter();
  const response = await route(new Request("https://example.test/notion/pages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parentPageId: "11111111111111111111111111111111", title: "test" }),
  }), { NOTION_TOKEN: "test", XUANCHE_API_KEY: "required" });
  assert.equal(response.status, 401);
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
