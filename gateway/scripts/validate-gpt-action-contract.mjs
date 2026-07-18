import { buildCompactGptActionSpec } from "../functions/[[path]].js";

const spec = buildCompactGptActionSpec("https://xuanche-engine-gateway.pages.dev");
const errors = [];
const expectedOperations = [
  "getEngineHealth",
  "getNotionTree",
  "getNotionPage",
  "initializeWorld",
  "archiveAndResetWorld",
  "getArchiveAndResetStatus",
  "loadWorldProfile",
  "updateWorldState",
  "listGitHubWorldTree",
  "getGitHubWorldFile",
].sort();

function fail(message) {
  errors.push(message);
}

function walkSchema(value, path = "root") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkSchema(item, `${path}[${index}]`));
    return;
  }
  if (value.type === "object") {
    if (!value.properties || typeof value.properties !== "object" || Array.isArray(value.properties)) {
      fail(`${path}: object schema must declare properties`);
    }
    for (const required of value.required ?? []) {
      if (!Object.hasOwn(value.properties ?? {}, required)) {
        fail(`${path}: required field ${required} is not declared in properties`);
      }
    }
  }
  for (const [key, child] of Object.entries(value)) walkSchema(child, `${path}.${key}`);
}

if (spec.openapi !== "3.1.0") fail("OpenAPI version must be 3.1.0");
if (!spec.components?.schemas || typeof spec.components.schemas !== "object" || Array.isArray(spec.components.schemas)) {
  fail("components.schemas must be an object");
}
if (!/^https:\/\//.test(spec.servers?.[0]?.url ?? "")) fail("server URL must use HTTPS");

const actualOperations = [];
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  for (const [method, operation] of Object.entries(item)) {
    if (!operation?.operationId) continue;
    actualOperations.push(operation.operationId);
    if ((operation.description ?? "").length > 300) fail(`${operation.operationId}: description exceeds 300 characters`);
    for (const parameter of operation.parameters ?? []) {
      if (!parameter.name || !parameter.in || !parameter.schema) fail(`${operation.operationId}: invalid parameter declaration`);
      walkSchema(parameter.schema, `${operation.operationId}.parameters.${parameter.name}`);
    }
    if (method === "post") {
      const schema = operation.requestBody?.content?.["application/json"]?.schema;
      if (!schema || schema.type !== "object") fail(`${operation.operationId}: POST body must be an object schema`);
      if (!schema || Object.keys(schema.properties ?? {}).length === 0) fail(`${operation.operationId}: POST body may not have an empty properties contract`);
      walkSchema(schema, `${operation.operationId}.requestBody`);
    }
    for (const response of Object.values(operation.responses ?? {})) {
      walkSchema(response?.content?.["application/json"]?.schema, `${operation.operationId}.response`);
    }
  }
}

if (JSON.stringify(actualOperations.sort()) !== JSON.stringify(expectedOperations)) {
  fail(`operation set mismatch: ${actualOperations.sort().join(", ")}`);
}

const archive = spec.paths?.["/world/archive-reset"]?.post?.requestBody?.content?.["application/json"]?.schema;
const requiredArchiveFields = ["confirmation", "expectedWorldId", "operationKey"];
for (const field of requiredArchiveFields) {
  if (!archive?.required?.includes(field) || !Object.hasOwn(archive?.properties ?? {}, field)) {
    fail(`archiveAndResetWorld: missing required field ${field}`);
  }
}
if (archive?.properties?.confirmation?.enum?.[0] !== "ARCHIVE_AND_RESET") {
  fail("archiveAndResetWorld: confirmation must require ARCHIVE_AND_RESET");
}

const archiveStatus = spec.paths?.["/world/archive-reset/status"]?.get;
for (const field of ["expectedWorldId", "operationKey"]) {
  if (!archiveStatus?.parameters?.some((parameter) => parameter.name === field && parameter.in === "query" && parameter.required === true)) {
    fail(`getArchiveAndResetStatus: missing required query parameter ${field}`);
  }
}

if (errors.length > 0) {
  console.error("GPT Action contract gate failed:\n" + errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log("GPT Action contract gate passed");
