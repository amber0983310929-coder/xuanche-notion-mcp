const apiKeySecurity = [{ apiKey: [] }];

const depthParameter = {
  name: "depth",
  in: "query",
  description: "Recursive block depth. Use 0 for only direct children.",
  schema: { type: "integer", minimum: 0, maximum: 20 },
};

const maxNodesParameter = {
  name: "maxNodes",
  in: "query",
  description: "Maximum number of Notion blocks returned as a safety limit.",
  schema: { type: "integer", minimum: 1, maximum: 20_000, default: 5_000 },
};

const standardResponses = {
  200: {
    description: "Successful Xuanche Engine response",
    content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessEnvelope" } } },
  },
  400: { $ref: "#/components/responses/BadRequest" },
  401: { $ref: "#/components/responses/Unauthorized" },
  422: { $ref: "#/components/responses/UnprocessableEntity" },
  500: { $ref: "#/components/responses/ServerError" },
};

export function buildOpenApi(origin) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Xuanche Engine API",
      version: "0.5.0",
      description: "Secure Cloudflare Worker bridge for loading and updating the Xuanche Notion world with GitHub-backed long-term memory and KV snapshots.",
    },
    servers: [{ url: new URL(origin).origin }],
    components: {
      securitySchemes: {
        apiKey: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description: "Set this to the Cloudflare XUANCHE_API_KEY secret.",
        },
      },
      schemas: {
        SuccessEnvelope: {
          type: "object",
          required: ["ok"],
          properties: {
            ok: { type: "boolean", const: true },
            data: { description: "Endpoint-specific result" },
            requestId: { type: "string" },
          },
          additionalProperties: true,
        },
        ErrorEnvelope: {
          type: "object",
          required: ["ok", "error", "requestId"],
          properties: {
            ok: { type: "boolean", const: false },
            error: { type: "string" },
            requestId: { type: "string" },
            details: { description: "Optional upstream error details" },
          },
        },
        NotionId: {
          type: "string",
          description: "Notion page or block ID, with or without hyphens.",
          pattern: "^[0-9a-fA-F-]{32,36}$",
        },
        BlockInput: {
          description: "A string becomes a paragraph block; an object is passed as a Notion block.",
          oneOf: [{ type: "string" }, { type: "object", additionalProperties: true }],
        },
        WorldLoadRequest: {
          type: "object",
          properties: {
            profile: {
              type: "string",
              enum: ["base", "continue", "cultivation", "combat", "npc", "exploration", "full"],
              default: "continue",
            },
            refresh: { type: "boolean", default: true, description: "Read Notion instead of using an unexpired KV snapshot." },
            persist: { type: "boolean", default: false, description: "Commit the loaded snapshot to world/cache.json in GitHub." },
            maxDepth: { type: "integer", minimum: 0, maximum: 20 },
            maxNodes: { type: "integer", minimum: 1, maximum: 20_000 },
            pageKeys: { type: "array", items: { type: "string" }, uniqueItems: true },
          },
        },
        WorldUpdateRequest: {
          type: "object",
          required: ["pageId", "children"],
          properties: {
            pageId: { $ref: "#/components/schemas/NotionId" },
            children: { type: "array", minItems: 1, maxItems: 100, items: { $ref: "#/components/schemas/BlockInput" } },
            after: { $ref: "#/components/schemas/NotionId" },
            memoryEvent: {
              description: "String summary or structured append-only long-term-memory event.",
              oneOf: [{ type: "string" }, { type: "object", additionalProperties: true }],
            },
            cachePatch: { type: "object", additionalProperties: true },
            commitMessage: { type: "string", maxLength: 256 },
          },
        },
        CreatePageRequest: {
          type: "object",
          required: ["parentPageId"],
          properties: {
            parentPageId: { $ref: "#/components/schemas/NotionId" },
            title: { type: "string" },
            properties: { type: "object", additionalProperties: true },
            children: { type: "array", maxItems: 100, items: { $ref: "#/components/schemas/BlockInput" } },
            icon: { type: "object", additionalProperties: true },
            cover: { type: "object", additionalProperties: true },
          },
        },
        AppendBlocksRequest: {
          type: "object",
          required: ["children"],
          properties: {
            children: { type: "array", minItems: 1, maxItems: 100, items: { $ref: "#/components/schemas/BlockInput" } },
            after: { $ref: "#/components/schemas/NotionId" },
          },
        },
        UpdatePageRequest: {
          type: "object",
          description: "Notion page fields supported by the engine.",
          properties: {
            properties: { type: "object", additionalProperties: true },
            icon: { type: ["object", "null"], additionalProperties: true },
            cover: { type: ["object", "null"], additionalProperties: true },
            archived: { type: "boolean" },
            in_trash: { type: "boolean" },
          },
        },
      },
      responses: {
        BadRequest: errorResponse("Invalid request"),
        Unauthorized: errorResponse("Invalid or missing API key"),
        UnprocessableEntity: errorResponse("The requested Notion tree exceeded a safety limit"),
        ServerError: errorResponse("Worker or upstream service error"),
      },
    },
    paths: {
      "/health": {
        get: {
          operationId: "getEngineHealth",
          summary: "Check service and integration configuration",
          description: "The basic check is public. deep=1 also verifies Notion and GitHub and requires X-API-Key.",
          parameters: [{ name: "deep", in: "query", schema: { type: "integer", enum: [0, 1], default: 0 } }],
          responses: standardResponses,
        },
      },
      "/home": {
        get: {
          operationId: "getWorldHome",
          summary: "Read the configured Notion world home",
          security: apiKeySecurity,
          parameters: [{ ...depthParameter, schema: { ...depthParameter.schema, default: 0 } }, maxNodesParameter],
          responses: standardResponses,
        },
      },
      "/tree": {
        get: {
          operationId: "getNotionTree",
          summary: "Recursively read a Notion page tree",
          security: apiKeySecurity,
          parameters: [
            { name: "pageId", in: "query", description: "Defaults to the configured world home page.", schema: { $ref: "#/components/schemas/NotionId" } },
            { ...depthParameter, schema: { ...depthParameter.schema, default: 6 } },
            maxNodesParameter,
            { name: "concurrency", in: "query", schema: { type: "integer", minimum: 1, maximum: 8, default: 3 } },
          ],
          responses: standardResponses,
        },
      },
      "/page": {
        get: {
          operationId: "getNotionPage",
          summary: "Read one Notion page or block",
          security: apiKeySecurity,
          parameters: [
            { name: "id", in: "query", required: true, schema: { $ref: "#/components/schemas/NotionId" } },
            { ...depthParameter, schema: { ...depthParameter.schema, default: 0 } },
            maxNodesParameter,
          ],
          responses: standardResponses,
        },
      },
      "/page/{id}": {
        get: {
          operationId: "getNotionPageTreeById",
          summary: "Recursively read one Notion page by path ID",
          security: apiKeySecurity,
          parameters: [
            { name: "id", in: "path", required: true, schema: { $ref: "#/components/schemas/NotionId" } },
            { ...depthParameter, schema: { ...depthParameter.schema, default: 6 } },
            maxNodesParameter,
          ],
          responses: standardResponses,
        },
      },
      "/world/load": {
        post: {
          operationId: "loadWorldProfile",
          summary: "Load a configured world profile and optionally persist its snapshot",
          security: apiKeySecurity,
          requestBody: jsonBody("#/components/schemas/WorldLoadRequest"),
          responses: standardResponses,
        },
      },
      "/world/update": {
        post: {
          operationId: "updateWorldState",
          summary: "Append a Notion update and synchronize GitHub memory or cache",
          security: apiKeySecurity,
          requestBody: jsonBody("#/components/schemas/WorldUpdateRequest", true),
          responses: standardResponses,
        },
      },
      "/notion/pages": {
        post: {
          operationId: "createNotionPage",
          summary: "Create a child Notion page",
          security: apiKeySecurity,
          requestBody: jsonBody("#/components/schemas/CreatePageRequest", true),
          responses: { ...standardResponses, 201: standardResponses[200] },
        },
      },
      "/notion/blocks/{id}/children": {
        post: {
          operationId: "appendNotionBlocks",
          summary: "Append blocks to a Notion page or block",
          security: apiKeySecurity,
          parameters: [{ name: "id", in: "path", required: true, schema: { $ref: "#/components/schemas/NotionId" } }],
          requestBody: jsonBody("#/components/schemas/AppendBlocksRequest", true),
          responses: standardResponses,
        },
      },
      "/notion/pages/{id}": {
        patch: {
          operationId: "updateNotionPage",
          summary: "Update supported Notion page properties",
          security: apiKeySecurity,
          parameters: [{ name: "id", in: "path", required: true, schema: { $ref: "#/components/schemas/NotionId" } }],
          requestBody: jsonBody("#/components/schemas/UpdatePageRequest", true),
          responses: standardResponses,
        },
      },
      "/github/tree": {
        get: {
          operationId: "listGitHubWorldTree",
          summary: "List the configured GitHub repository tree",
          security: apiKeySecurity,
          parameters: [{ name: "ref", in: "query", schema: { type: "string", default: "main" } }],
          responses: standardResponses,
        },
      },
      "/github/file": {
        get: {
          operationId: "getGitHubWorldFile",
          summary: "Read one GitHub-backed world file as UTF-8 text",
          security: apiKeySecurity,
          parameters: [
            { name: "path", in: "query", required: true, schema: { type: "string", example: "world/config.json" } },
            { name: "ref", in: "query", schema: { type: "string", default: "main" } },
          ],
          responses: standardResponses,
        },
      },
    },
  };
}

function errorResponse(description) {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
  };
}

function jsonBody(schemaRef, required = false) {
  return {
    required,
    content: { "application/json": { schema: { $ref: schemaRef } } },
  };
}
