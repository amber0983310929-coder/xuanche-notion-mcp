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

  const notion = new NotionClient({ NOTION_TOKEN: "test" }, mockFetch);
  const tree = await notion.getPageTree(PAGE, { maxDepth: 4, maxNodes: 10 });
  assert.equal(tree.meta.nodeCount, 3);
  assert.equal(tree.children.length, 2);
  assert.equal(tree.children[0].children.length, 1);
  assert.ok(calls.some((url) => url.includes("start_cursor=next")));
});

test("Notion client invokes fetch with the Cloudflare global receiver", async () => {
  let receiver;
  const receiverAwareFetch = function () {
    receiver = this;
    return response({ results: [], has_more: false });
  };
  const notion = new NotionClient({ NOTION_TOKEN: "test" }, receiverAwareFetch);
  await notion.listBlockChildren(PAGE);
  assert.equal(receiver, globalThis);
});

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
