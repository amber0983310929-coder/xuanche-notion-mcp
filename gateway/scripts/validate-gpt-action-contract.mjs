import { buildCompactGptActionSpec } from "../functions/[[path]].js";

const spec = buildCompactGptActionSpec("https://xuanche-engine-gateway.pages.dev");
const errors = [];
const expectedOperations = [
  "getNotionTree",
  "getNotionPage",
  "initializeWorld",
  "loadWorldProfile",
  "archiveAndResetWorld",
  "getArchiveAndResetStatus",
  "updateWorldState",
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
walkSchema(spec.components?.schemas, "components.schemas");
if (!/^https:\/\//.test(spec.servers?.[0]?.url ?? "")) fail("server URL must use HTTPS");

const actualOperations = [];
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  for (const [method, operation] of Object.entries(item)) {
    if (!operation?.operationId) continue;
    actualOperations.push(operation.operationId);
    if (!(operation.summary ?? "").trim() || operation.summary === operation.operationId) {
      fail(`${operation.operationId}: summary must explain the action instead of repeating operationId`);
    }
    if (!(operation.description ?? "").trim()) fail(`${operation.operationId}: description is required`);
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
const archiveOperation = spec.paths?.["/world/archive-reset"]?.post;
if (!archiveOperation?.responses?.["202"] || archiveOperation?.responses?.["200"]) {
  fail("archiveAndResetWorld: accepted success must be declared as 202 and not 200");
}
for (const code of ["400", "401", "409", "423", "503", "500"]) {
  if (!archiveOperation?.responses?.[code]) fail(`archiveAndResetWorld: missing ${code} response`);
}

const archiveStatus = spec.paths?.["/world/archive-reset/status"]?.get;
for (const field of ["expectedWorldId", "operationKey"]) {
  if (!archiveStatus?.parameters?.some((parameter) => parameter.name === field && parameter.in === "query" && parameter.required === true)) {
    fail(`getArchiveAndResetStatus: missing required query parameter ${field}`);
  }
}
for (const code of ["200", "400", "401", "404", "503", "500"]) {
  if (!archiveStatus?.responses?.[code]) fail(`getArchiveAndResetStatus: missing ${code} response`);
}

const archiveData = spec.components?.schemas?.ArchiveResetEnvelope?.properties?.data;
for (const field of [
  "operationKey", "archiveId", "workflowId", "archiveVerified", "reset",
  "worldState", "safeToInitialize", "nextAction", "nextPollAfterSeconds",
]) {
  if (!archiveData?.required?.includes(field) || !Object.hasOwn(archiveData?.properties ?? {}, field)) {
    fail(`ArchiveResetEnvelope: missing required status field ${field}`);
  }
}
if (!archiveData?.properties?.nextAction?.enum?.includes("INITIALIZE_WORLD")) {
  fail("ArchiveResetEnvelope: nextAction must expose INITIALIZE_WORLD");
}

const initialize = spec.paths?.["/world/initialize"]?.post?.requestBody?.content?.["application/json"]?.schema;
const character = initialize?.properties?.character;
for (const field of ["name", "motto", "coreDesire", "weaknessFear"]) {
  if (!character?.required?.includes(field)) fail(`initializeWorld: missing core required character field ${field}`);
}
for (const field of ["motto", "importantBonds", "coreDesire", "weaknessFear", "startingStyle", "destinyTalents", "relationships"]) {
  if (!Object.hasOwn(character?.properties ?? {}, field)) {
    fail(`initializeWorld: missing declared character field ${field}`);
  }
}
if (initialize?.required?.includes("opening")) fail("initializeWorld: opening must remain optional for compatible initialization retries");
const opening = initialize?.properties?.opening;
for (const field of ["location", "time", "premise"]) {
  if (!opening?.required?.includes(field)) fail(`initializeWorld: opening must require ${field} when supplied`);
}
for (const schema of [initialize?.properties?.saveKey]) {
  if (schema?.minLength !== 1 || schema?.maxLength !== 200) fail("initializeWorld: saveKey must preserve the Worker 1-200 character contract");
}

const update = spec.paths?.["/world/update"]?.post?.requestBody?.content?.["application/json"]?.schema;
if (!update?.required?.includes("expectedRevision")) fail("updateWorldState: expectedRevision must be required");
if (JSON.stringify(update?.properties?.expectedWorldState?.enum) !== JSON.stringify(["ACTIVE"])) {
  fail("updateWorldState: GPT contract must restrict expectedWorldState to ACTIVE");
}
if (!Array.isArray(update?.anyOf) || update.anyOf.length !== 2) {
  fail("updateWorldState: request must require children or blockUpdates");
}
if (update?.properties?.children?.items?.type !== "string") {
  fail("updateWorldState: append children must be plain strings that the Worker normalizes into Notion paragraphs");
}
if (update?.properties?.children?.items?.maxLength !== 1800) {
  fail("updateWorldState: append text must stay within the safe Notion rich-text limit");
}
if (update?.properties?.saveKey?.minLength !== 1 || update?.properties?.saveKey?.maxLength !== 200) {
  fail("updateWorldState: saveKey must preserve the Worker 1-200 character contract");
}
for (const hidden of ["memoryEvent", "cachePatch", "commitMessage"]) {
  if (Object.hasOwn(update?.properties ?? {}, hidden)) fail(`updateWorldState: internal field ${hidden} must stay hidden`);
}
if (update?.properties?.mutations?.maxItems !== 9) {
  fail("updateWorldState: FAST_TURN_V1 batch must allow at most 9 fixed-page mutations");
}

const load = spec.paths?.["/world/load"]?.post?.requestBody?.content?.["application/json"]?.schema;
if (!load?.required?.includes("profile")) fail("loadWorldProfile: profile must be required");
if (load?.properties?.refresh?.default !== false) fail("loadWorldProfile: normal reads must default refresh to false");
if (!load?.properties?.profile?.enum?.includes("turn_core")) fail("loadWorldProfile: turn_core must be exposed");

const treeParameters = spec.paths?.["/tree"]?.get?.parameters ?? [];
if (treeParameters.some((parameter) => parameter.name === "cursor")) {
  fail("getNotionTree: cursor must not be advertised because the route does not consume it");
}
for (const forbidden of ["/health", "/github/tree", "/github/file"]) {
  if (spec.paths?.[forbidden]) fail(`gameplay manifest must not expose ${forbidden}`);
}

if (errors.length > 0) {
  console.error("GPT Action contract gate failed:\n" + errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log("GPT Action contract gate passed");
