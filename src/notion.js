import { ApiError, mapLimit, normalizeNotionId, retryDelay, sleep } from "./utils.js";

export class NotionClient {
  constructor(env = {}, fetchImpl = fetch) {
    this.token = env.NOTION_TOKEN;
    this.version = env.NOTION_VERSION || "2022-06-28";
    this.baseUrl = env.NOTION_API_BASE_URL || "https://api.notion.com/v1";
    // Workerd runtime functions can require their original global receiver.
    // Always invoke fetch with globalThis instead of treating it as a client method.
    this.fetch = (...args) => Reflect.apply(fetchImpl, globalThis, args);
  }

  get configured() {
    return Boolean(this.token);
  }

  async request(path, { method = "GET", body, headers = {} } = {}) {
    if (!this.token) throw new ApiError(503, "NOTION_TOKEN is not configured");
    let response;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "notion-version": this.version,
          "content-type": "application/json",
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) break;
      await sleep(retryDelay(response, attempt));
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError(response.status, payload.message || "Notion API request failed", {
        code: payload.code,
      });
    }
    return payload;
  }

  getPage(pageId) {
    return this.request(`/pages/${normalizeNotionId(pageId)}`);
  }

  getBlock(blockId) {
    return this.request(`/blocks/${normalizeNotionId(blockId)}`);
  }

  async listBlockChildren(blockId, { startCursor, pageSize = 100 } = {}) {
    const params = new URLSearchParams({ page_size: String(Math.min(100, pageSize)) });
    if (startCursor) params.set("start_cursor", startCursor);
    return this.request(`/blocks/${normalizeNotionId(blockId)}/children?${params}`);
  }

  async listAllBlockChildren(blockId, { maxNodes = 5_000 } = {}) {
    const results = [];
    let cursor;
    do {
      const page = await this.listBlockChildren(blockId, { startCursor: cursor });
      results.push(...page.results);
      if (results.length > maxNodes) {
        throw new ApiError(422, `Notion tree exceeds the ${maxNodes} node safety limit`);
      }
      cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor);
    return results;
  }

  async getPageTree(pageId, options = {}) {
    const maxDepth = Math.min(20, Math.max(0, Number(options.maxDepth ?? 6)));
    const maxNodes = Math.min(20_000, Math.max(1, Number(options.maxNodes ?? 5_000)));
    const concurrency = Math.min(8, Math.max(1, Number(options.concurrency ?? 3)));
    const rootId = normalizeNotionId(pageId);
    const page = options.includePage === false ? undefined : await this.getPage(rootId);
    let nodeCount = 0;
    const visited = new Set();

    const walk = async (blockId, depth) => {
      const id = normalizeNotionId(blockId);
      if (visited.has(id)) return [];
      visited.add(id);
      const children = await this.listAllBlockChildren(id, { maxNodes: maxNodes - nodeCount });
      nodeCount += children.length;
      if (nodeCount > maxNodes) throw new ApiError(422, `Notion tree exceeds the ${maxNodes} node safety limit`);
      if (depth >= maxDepth) {
        return children.map((block) => ({ ...block, _truncated: Boolean(block.has_children) }));
      }
      return mapLimit(children, concurrency, async (block) => {
        if (!block.has_children) return block;
        const nested = await walk(block.id, depth + 1);
        return { ...block, children: nested };
      });
    };

    const children = await walk(rootId, 0);
    return { page, children, meta: { rootId, nodeCount, maxDepth, truncated: hasTruncated(children) } };
  }

  createChildPage(parentPageId, input) {
    const body = {
      parent: { page_id: normalizeNotionId(parentPageId) },
      properties: input.properties || {
        title: { title: [{ type: "text", text: { content: input.title || "Untitled" } }] },
      },
    };
    if (input.children?.length) body.children = normalizeBlocks(input.children);
    if (input.icon) body.icon = input.icon;
    if (input.cover) body.cover = input.cover;
    return this.request("/pages", { method: "POST", body });
  }

  appendBlocks(blockId, children, after) {
    if (!Array.isArray(children) || children.length === 0) {
      throw new ApiError(400, "children must be a non-empty array");
    }
    if (children.length > 100) throw new ApiError(400, "Notion accepts at most 100 blocks per append request");
    const body = { children: normalizeBlocks(children) };
    if (after) body.after = normalizeNotionId(after);
    return this.request(`/blocks/${normalizeNotionId(blockId)}/children`, { method: "PATCH", body });
  }

  updatePage(pageId, patch) {
    const allowed = ["properties", "icon", "cover", "archived", "in_trash"];
    const body = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key)));
    if (Object.keys(body).length === 0) throw new ApiError(400, "No supported Notion page fields were provided");
    return this.request(`/pages/${normalizeNotionId(pageId)}`, { method: "PATCH", body });
  }
}

export function normalizeBlocks(children) {
  return children.map((block) => {
    if (typeof block !== "string") return block;
    return {
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: block } }] },
    };
  });
}

function hasTruncated(blocks) {
  return blocks.some((block) => block._truncated || (Array.isArray(block.children) && hasTruncated(block.children)));
}
