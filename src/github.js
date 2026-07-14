import { ApiError, base64ToUtf8, retryDelay, sleep, utf8ToBase64 } from "./utils.js";

export class GitHubClient {
  constructor(env = {}, fetchImpl = fetch) {
    this.token = env.GITHUB_TOKEN;
    this.owner = env.GITHUB_OWNER;
    this.repo = env.GITHUB_REPO;
    this.branch = env.GITHUB_BRANCH || "main";
    this.baseUrl = env.GITHUB_API_BASE_URL || "https://api.github.com";
    this.fetch = fetchImpl;
    this.committer = {
      name: env.GITHUB_COMMITTER_NAME || "Xuanche Engine",
      email: env.GITHUB_COMMITTER_EMAIL || "xuanche-engine@users.noreply.github.com",
    };
  }

  get configured() {
    return Boolean(this.token && this.owner && this.repo);
  }

  assertConfigured() {
    if (!this.configured) throw new ApiError(503, "GitHub storage is not fully configured");
  }

  async request(path, { method = "GET", body, allowNotFound = false } = {}) {
    this.assertConfigured();
    let response;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "xuanche-engine-worker",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const retryable = [429, 500, 502, 503, 504].includes(response.status)
        || (response.status === 403 && response.headers.has("x-ratelimit-reset"));
      if (!retryable || attempt === 3) break;
      await sleep(githubRetryDelay(response, attempt));
    }
    if (allowNotFound && response.status === 404) return undefined;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError(response.status, payload.message || "GitHub API request failed", {
        documentationUrl: payload.documentation_url,
      });
    }
    return payload;
  }

  repoPath(path) {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${path}`;
  }

  getRepository() {
    return this.request(this.repoPath(""));
  }

  async getFile(path, { ref = this.branch, allowNotFound = false } = {}) {
    const safePath = sanitizeRepositoryPath(path);
    const params = new URLSearchParams({ ref });
    const payload = await this.request(this.repoPath(`/contents/${encodeRepositoryPath(safePath)}?${params}`), { allowNotFound });
    if (!payload) return undefined;
    if (Array.isArray(payload) || payload.type !== "file") throw new ApiError(400, "Requested GitHub path is not a file");
    return { ...payload, text: base64ToUtf8(payload.content || "") };
  }

  async getJson(path, options = {}) {
    const file = await this.getFile(path, options);
    if (!file) return undefined;
    try {
      return { ...file, data: JSON.parse(file.text) };
    } catch {
      throw new ApiError(422, `GitHub file ${path} does not contain valid JSON`);
    }
  }

  async putFile(path, content, { message, sha, branch = this.branch } = {}) {
    const safePath = sanitizeRepositoryPath(path);
    let currentSha = sha;
    if (!currentSha) {
      currentSha = (await this.getFile(safePath, { ref: branch, allowNotFound: true }))?.sha;
    }
    const body = {
      message: message || `Update ${safePath}`,
      content: utf8ToBase64(content),
      branch,
      committer: this.committer,
    };
    if (currentSha) body.sha = currentSha;
    return this.request(this.repoPath(`/contents/${encodeRepositoryPath(safePath)}`), { method: "PUT", body });
  }

  putJson(path, data, options = {}) {
    return this.putFile(path, `${JSON.stringify(data, null, 2)}\n`, options);
  }

  listTree({ ref = this.branch, recursive = true } = {}) {
    const suffix = recursive ? "?recursive=1" : "";
    return this.request(this.repoPath(`/git/trees/${encodeURIComponent(ref)}${suffix}`));
  }
}

function githubRetryDelay(response, attempt) {
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(30_000, Math.max(250, reset * 1_000 - Date.now()));
  }
  return retryDelay(response, attempt);
}

function sanitizeRepositoryPath(path) {
  if (typeof path !== "string" || !path.trim()) throw new ApiError(400, "A GitHub repository path is required");
  const normalized = path.replace(/^\/+/, "");
  if (normalized.includes("..") || normalized.includes("\\")) throw new ApiError(400, "Invalid GitHub repository path");
  return normalized;
}

function encodeRepositoryPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}
