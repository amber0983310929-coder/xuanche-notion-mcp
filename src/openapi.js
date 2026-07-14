export function buildOpenApi(origin) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Xuanche Engine API",
      version: "0.4.0",
      description: "Cloudflare Worker bridge for recursive Notion world loading and GitHub-backed memory.",
    },
    servers: [{ url: new URL(origin).origin }],
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
        bearer: { type: "http", scheme: "bearer" },
      },
    },
    paths: {
      "/health": { get: { summary: "Service and integration status" } },
      "/home": { get: { summary: "Read the configured Notion home page" } },
      "/tree": { get: { summary: "Recursively read a Notion page tree" } },
      "/world/load": {
        post: { summary: "Load configured world pages and optionally persist a snapshot", security: [{ apiKey: [] }, { bearer: [] }] },
      },
      "/notion/pages": {
        post: { summary: "Create a child Notion page", security: [{ apiKey: [] }, { bearer: [] }] },
      },
      "/notion/blocks/{id}/children": {
        post: { summary: "Append Notion blocks", security: [{ apiKey: [] }, { bearer: [] }] },
      },
      "/notion/pages/{id}": {
        patch: { summary: "Update Notion page properties", security: [{ apiKey: [] }, { bearer: [] }] },
      },
      "/world/update": {
        post: { summary: "Append a Notion update and sync GitHub memory/cache", security: [{ apiKey: [] }, { bearer: [] }] },
      },
      "/github/tree": { get: { summary: "List the configured GitHub repository tree", security: [{ apiKey: [] }, { bearer: [] }] } },
      "/github/file": { get: { summary: "Read a GitHub-backed world file", security: [{ apiKey: [] }, { bearer: [] }] } },
    },
  };
}
