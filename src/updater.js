import { CacheStore } from "./cache.js";
import { GitHubClient } from "./github.js";
import { NotionClient } from "./notion.js";
import { ApiError, mergeDeep, nowIso } from "./utils.js";

export async function updateWorld(env, input, dependencies = {}) {
  const notion = dependencies.notion || new NotionClient(env);
  const github = dependencies.github || new GitHubClient(env);
  const cache = dependencies.cache || new CacheStore(env);
  if (!input.pageId) throw new ApiError(400, "pageId is required");
  if (!Array.isArray(input.children) || input.children.length === 0) {
    throw new ApiError(400, "children must be a non-empty array");
  }

  if ((input.memoryEvent !== undefined || input.cachePatch !== undefined) && !github.configured) {
    throw new ApiError(503, "GitHub storage must be configured for memory or cache updates");
  }

  const notionResult = await notion.appendBlocks(input.pageId, input.children, input.after);
  const timestamp = nowIso();
  const output = { notion: notionResult, timestamp };

  if (input.memoryEvent !== undefined) {
    const existing = (await github.getJson("world/memory.json", { allowNotFound: true }))?.data || {
      version: 1,
      events: [],
    };
    const event = typeof input.memoryEvent === "string"
      ? { timestamp, summary: input.memoryEvent }
      : { timestamp, ...input.memoryEvent };
    existing.events = [...(existing.events || []), event].slice(-1_000);
    existing.updatedAt = timestamp;
    const saved = await github.putJson("world/memory.json", existing, {
      message: input.commitMessage || `chore(world): record event ${timestamp}`,
    });
    output.memoryCommit = saved.commit?.sha;
  }

  if (input.cachePatch !== undefined) {
    const existing = (await github.getJson("world/cache.json", { allowNotFound: true }))?.data || {};
    const next = mergeDeep(existing, input.cachePatch);
    next.updatedAt = timestamp;
    const saved = await github.putJson("world/cache.json", next, {
      message: input.commitMessage || `chore(world): update cache ${timestamp}`,
    });
    output.cacheCommit = saved.commit?.sha;
  }

  await cache.delete("world:6:5000");
  return output;
}
