import test from "node:test";
import assert from "node:assert/strict";
import { NotionClient } from "../src/notion.js";

const PAGE = "11111111-1111-1111-1111-111111111111";
const CHILD = "22222222-2222-2222-2222-222222222222";

test("recursive Notion reader follows pagination and nested children", async () => {
  const calls = [];
  const mockFetch = async (url) => {
    calls.push(url);
    if (url.endsWith(`/pages/${PAGE}`)) return response({ id: PAGE, object: "page" });
    if (url.includes(`/blocks/${PAGE}/children`) && !url.includes("start_cursor")) {
      return response({
        results: [{ id: CHILD, type: "toggle", has_children: true }],
        has_more: true,
        next_cursor: "next",
      });
    }
    if (url.includes(`/blocks/${PAGE}/children`) && url.includes("start_cursor=next")) {
      return response({ results: [{ id: "33333333-3333-3333-3333-333333333333", type: "paragraph", has_children: false }], has_more: false });
    }
    if (url.includes(`/blocks/${CHILD}/children`)) {
      return response({ results: [{ id: "44444444-4444-4444-4444-444444444444", type: "paragraph", has_children: false }], has_more: false });
    }
    return response({ message: "not found" }, 404);
  };

  const notion = new NotionClient({
    NOTION_TOKEN: "test",
    NOTION_MIN_REQUEST_INTERVAL_MS: "0",
  }, mockFetch);
  const tree = await notion.getPageTree(PAGE, { maxDepth: 4, maxNodes: 10 });
  assert.equal(tree.meta.nodeCount, 3);
  assert.equal(tree.children.length, 2);
  assert.equal(tree.children[0].children.length, 1);
  assert.ok(calls.some((url) => url.includes("start_cursor=next")));
});

test("bounded shallow trees return the first 60 blocks with explicit node-limit metadata", async () => {
  const blocks = Array.from({ length: 61 }, (_, index) => ({
    id: (index + 1).toString(16).padStart(32, "0"),
    type: "paragraph",
    has_children: false,
  }));
  const requestedPageSizes = [];
  const mockFetch = async (url) => {
    if (url.endsWith(`/pages/${PAGE}`)) return response({ id: PAGE, object: "page" });
    if (url.includes(`/blocks/${PAGE}/children`)) {
      const parsed = new URL(url);
      const start = Number(parsed.searchParams.get("start_cursor") || 0);
      const pageSize = Number(parsed.searchParams.get("page_size"));
      requestedPageSizes.push(pageSize);
      const end = Math.min(start + pageSize, blocks.length);
      return response({
        results: blocks.slice(start, end),
        has_more: end < blocks.length,
        next_cursor: end < blocks.length ? String(end) : null,
      });
    }
    return response({ message: "not found" }, 404);
  };
  const notion = new NotionClient({
    NOTION_TOKEN: "test",
    NOTION_MIN_REQUEST_INTERVAL_MS: "0",
  }, mockFetch);

  const tree = await notion.getPageTree(PAGE, {
    maxDepth: 0,
    maxNodes: 60,
    truncateAtMaxNodes: true,
  });

  assert.deepEqual(
    tree.children.map((block) => block.id),
    blocks.slice(0, 60).map((block) => block.id),
  );
  assert.equal(tree.meta.nodeCount, 60);
  assert.equal(tree.meta.nodeLimitReached, true);
  assert.equal(tree.meta.truncated, true);
  assert.equal(tree.meta.nextCursor, "60");
  assert.deepEqual(requestedPageSizes, [60]);
});

test("strict block-child reads still reject more than 60 blocks with HTTP 422 semantics", async () => {
  const blocks = Array.from({ length: 61 }, (_, index) => ({
    id: (index + 1).toString(16).padStart(32, "0"),
    type: "paragraph",
    has_children: false,
  }));
  const mockFetch = async (url) => {
    if (url.includes(`/blocks/${PAGE}/children`)) {
      return response({ results: blocks, has_more: false, next_cursor: null });
    }
    return response({ message: "not found" }, 404);
  };
  const notion = new NotionClient({
    NOTION_TOKEN: "test",
    NOTION_MIN_REQUEST_INTERVAL_MS: "0",
  }, mockFetch);

  await assert.rejects(
    notion.listAllBlockChildren(PAGE, { maxNodes: 60 }),
    (error) => {
      assert.equal(error.status, 422);
      assert.match(error.message, /exceeds the 60 node safety limit/);
      return true;
    },
  );
});

test("Notion client invokes fetch with the Cloudflare global receiver", async () => {
  let receiver;
  const receiverAwareFetch = function () {
    receiver = this;
    return response({ results: [], has_more: false });
  };
  const notion = new NotionClient({
    NOTION_TOKEN: "test",
    NOTION_MIN_REQUEST_INTERVAL_MS: "0",
  }, receiverAwareFetch);
  await notion.listBlockChildren(PAGE);
  assert.equal(receiver, globalThis);
});

test("Notion client spaces concurrent requests to stay below the configured rate", async () => {
  const starts = [];
  const mockFetch = async () => {
    starts.push(Date.now());
    return response({ results: [], has_more: false });
  };
  const notion = new NotionClient({
    NOTION_TOKEN: "test",
    NOTION_MIN_REQUEST_INTERVAL_MS: "20",
  }, mockFetch);

  await Promise.all([
    notion.listBlockChildren(PAGE),
    notion.listBlockChildren(CHILD),
  ]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 15);
});

test("Notion client can leave transient retries to an outer Workflow invocation", async () => {
  let calls = 0;
  const notion = new NotionClient({
    NOTION_TOKEN: "test",
    NOTION_MIN_REQUEST_INTERVAL_MS: "0",
  }, async () => {
    calls += 1;
    return response({ message: "try again" }, 503);
  }, { maxRequestAttempts: 1 });

  await assert.rejects(notion.listBlockChildren(PAGE), (error) => error.status === 503);
  assert.equal(calls, 1);
});

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
