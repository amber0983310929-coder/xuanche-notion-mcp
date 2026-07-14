import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "../src/github.js";

test("GitHub JSON writes preserve an existing file sha", async () => {
  const requests = [];
  const encoded = Buffer.from('{"version":1}\n', "utf8").toString("base64");
  const mockFetch = async (url, init) => {
    requests.push({ url, init });
    if (init.method === "GET") {
      return response({ type: "file", path: "world/cache.json", sha: "old-sha", content: encoded });
    }
    return response({ content: { sha: "new-sha" }, commit: { sha: "commit-sha" } });
  };
  const github = new GitHubClient({
    GITHUB_TOKEN: "test",
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
  }, mockFetch);

  const result = await github.putJson("world/cache.json", { version: 2 }, { message: "update cache" });
  const body = JSON.parse(requests[1].init.body);
  assert.equal(body.sha, "old-sha");
  assert.equal(body.message, "update cache");
  assert.equal(result.commit.sha, "commit-sha");
});

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
