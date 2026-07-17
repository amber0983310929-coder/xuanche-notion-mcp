const apiKeySecurity = [{ apiKey: [] }];

const freeformObject = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

const depthParameter = {
  name: "depth",
  in: "query",
  description: "Recursive block depth. Use 0 for only direct children.",
  schema: { type: "integer", minimum: 0, maximum: 1 },
};

const maxNodesParameter = {
  name: "maxNodes",
  in: "query",
  description: "Maximum number of Notion blocks returned as a safety limit.",
  schema: { type: "integer", minimum: 1, maximum: 20_000, default: 5_000 },
};

const cursorParameter = {
  name: "cursor",
  in: "query",
  description: "Pagination cursor for requesting the next batch of nodes.",
  schema: { type: "string" },
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
      version: "0.5.6",
      description: "Fail-closed Cloudflare Worker bridge for SAVE_V3.2 world loads, TURN_PRELOAD_V1 profiles, and idempotent allowlisted Notion updates.",
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
            ok: { type: "boolean", enum: [true] },
            data: { ...freeformObject, description: "Endpoint-specific result" },
            requestId: { type: "string" },
          },
          additionalProperties: true,
        },
        ErrorEnvelope: {
          type: "object",
          required: ["ok", "error", "requestId"],
          properties: {
            ok: { type: "boolean", enum: [false] },
            error: { type: "string" },
            requestId: { type: "string" },
            details: { ...freeformObject, description: "Optional upstream error details" },
          },
        },
        NotionId: {
          type: "string",
          description: "Notion page or block ID, with or without hyphens.",
          pattern: "^[0-9a-fA-F-]{32,36}$",
        },
        BlockInput: {
          description: "A string becomes a paragraph block; an object is passed as a Notion block.",
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                object: { type: "string", example: "block" },
                type: { type: "string", example: "paragraph" },
              },
              additionalProperties: true,
            },
          ],
        },
        WorldLoadRequest: {
          type: "object",
          properties: {
            profile: {
              type: "string",
              enum: [
                "base",
                "state_check",
                "continue",
                "new_game",
                "character_creation",
                "character_finalize",
                "cultivation",
                "combat",
                "npc",
                "exploration",
                "save",
                "turn_core",
                "turn_combat",
                "turn_dialogue",
                "turn_exploration",
                "turn_cultivation",
                "turn_trade",
                "turn_travel",
                "full",
              ],
              default: "continue",
            },
            refresh: { type: "boolean", default: true, description: "Read Notion instead of using an unexpired KV snapshot." },
            persist: { type: "boolean", default: false, description: "Commit the loaded snapshot to world/cache.json in GitHub." },
            maxDepth: { type: "integer", minimum: 0, maximum: 1 },
            maxNodes: { type: "integer", minimum: 1, maximum: 20_000 },
            pageKeys: { type: "array", items: { type: "string" }, uniqueItems: true },
          },
        },
        WorldUpdateRequest: {
          type: "object",
          required: ["pageId", "saveKey", "expectedWorldId", "expectedWorldState"],
          properties: {
            pageId: { $ref: "#/components/schemas/NotionId" },
            saveKey: { type: "string", minLength: 1, maxLength: 200, description: "Unique idempotency key written to the target world page." },
            expectedWorldId: { type: "string", minLength: 1 },
            expectedWorldState: { type: "string", enum: ["EMPTY", "ACTIVE", "WORLD_CONFLICT"] },
            expectedRevision: { type: "integer", minimum: 0 },
            children: { type: "array", minItems: 1, maxItems: 99, items: { $ref: "#/components/schemas/BlockInput" } },
            blockUpdates: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: { $ref: "#/components/schemas/BlockUpdate" },
            },
            after: { $ref: "#/components/schemas/NotionId" },
            memoryEvent: {
              description: "String summary or structured append-only long-term-memory event.",
              oneOf: [
                { type: "string" },
                {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                    summary: { type: "string" },
                    version: { type: "string" },
                    encoding: { type: "string" },
                    supersedesCommit: { type: "string" },
                  },
                  additionalProperties: true,
                },
              ],
            },
            cachePatch: { ...freeformObject },
            commitMessage: { type: "string", maxLength: 256 },
          },
          anyOf: [
            { required: ["children"] },
            { required: ["blockUpdates"] },
          ],
        },
        BlockUpdate: {
          type: "object",
          required: ["blockId", "type"],
          properties: {
            blockId: { $ref: "#/components/schemas/NotionId" },
            type: {
              type: "string",
              enum: ["paragraph", "callout", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "quote", "toggle", "to_do", "table_row"],
            },
            text: { type: "string" },
            cells: { type: "array", minItems: 1, items: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } },
            checked: { type: "boolean" },
            expectedText: { type: "string", description: "Optional optimistic-concurrency check." },
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
          parameters: [{ ...depthParameter, schema: { ...depthParameter.schema, default: 0 } }, maxNodesParameter, cursorParameter],
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
            { ...depthParameter, schema: { ...depthParameter.schema, default: 0 } },
            maxNodesParameter,
            cursorParameter,
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
            cursorParameter,
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
            { ...depthParameter, schema: { ...depthParameter.schema, default: 0 } },
            maxNodesParameter,
            cursorParameter,
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
          summary: "Apply an idempotent, allowlisted SAVE_V3.2 world update",
          security: apiKeySecurity,
          requestBody: jsonBody("#/components/schemas/WorldUpdateRequest", true),
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
