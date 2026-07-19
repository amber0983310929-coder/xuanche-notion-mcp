const origin = process.argv[2];
const expectedGatewayVersion = process.argv[3] || "0.5.13";
const expectedWorkerVersion = process.argv[4] || "0.5.16";
if (!origin || !/^https:\/\//.test(origin)) {
  console.error("Usage: node gateway/scripts/verify-deployed-gpt-action.mjs https://your-gateway.pages.dev [gatewayVersion] [workerVersion]");
  process.exit(1);
}

const base = origin.replace(/\/$/, "");
const [specResponse, healthResponse] = await Promise.all([
  fetch(`${base}/gpt-action-openapi.json?verify=${Date.now()}`),
  fetch(`${base}/health?deep=0`),
]);

if (!specResponse.ok) throw new Error(`Action spec returned HTTP ${specResponse.status}`);
if (!healthResponse.ok) throw new Error(`Health endpoint returned HTTP ${healthResponse.status}`);

const [spec, health] = await Promise.all([specResponse.json(), healthResponse.json()]);
const archive = spec.paths?.["/world/archive-reset"]?.post?.requestBody?.content?.["application/json"]?.schema;
const archiveStatus = spec.paths?.["/world/archive-reset/status"]?.get;
const operationIds = Object.values(spec.paths ?? {})
  .flatMap((path) => Object.values(path))
  .map((operation) => operation?.operationId)
  .filter(Boolean)
  .sort();
const expectedOperations = [
  "archiveAndResetWorld",
  "getArchiveAndResetStatus",
  "getNotionPage",
  "getNotionTree",
  "initializeWorld",
  "updateWorldState",
].sort();
const fields = ["confirmation", "expectedWorldId", "operationKey"];
const missing = fields.filter((field) => !archive?.required?.includes(field) || !Object.hasOwn(archive?.properties ?? {}, field));

if (spec.servers?.[0]?.url !== base) throw new Error("Action spec server does not match the deployed origin");
if (spec.info?.version !== expectedGatewayVersion) throw new Error(`Gateway spec version ${spec.info?.version} does not match ${expectedGatewayVersion}`);
if (specResponse.headers.get("X-Xuanche-Gateway-Version") !== expectedGatewayVersion) throw new Error("Gateway response header version is stale");
if (!spec.components?.schemas || typeof spec.components.schemas !== "object") throw new Error("Action spec has no components.schemas object");
if (JSON.stringify(operationIds) !== JSON.stringify(expectedOperations)) throw new Error(`Unexpected gameplay operation set: ${operationIds.join(", ")}`);
if (missing.length > 0) throw new Error(`Archive Action fields missing after deployment: ${missing.join(", ")}`);
if (archive.properties.confirmation.enum?.[0] !== "ARCHIVE_AND_RESET") throw new Error("Archive Action confirmation contract is incorrect");
const archiveOperation = spec.paths?.["/world/archive-reset"]?.post;
if (!archiveOperation?.responses?.["202"] || archiveOperation?.responses?.["200"]) throw new Error("Archive Action must declare 202 and not 200");
if (!archiveStatus) throw new Error("Archive reset status Action is missing after deployment");
const statusParameters = archiveStatus.parameters ?? [];
for (const field of ["expectedWorldId", "operationKey"]) {
  if (!statusParameters.some((parameter) => parameter.name === field && parameter.in === "query" && parameter.required === true)) {
    throw new Error(`Archive status Action parameter missing after deployment: ${field}`);
  }
}
const archiveData = spec.components.schemas.ArchiveResetEnvelope?.properties?.data;
for (const field of ["operationKey", "archiveId", "workflowId", "archiveVerified", "reset", "worldState", "safeToInitialize", "nextAction"]) {
  if (!archiveData?.required?.includes(field) || !Object.hasOwn(archiveData?.properties ?? {}, field)) {
    throw new Error(`Archive status response field missing after deployment: ${field}`);
  }
}
const initialize = spec.paths?.["/world/initialize"]?.post?.requestBody?.content?.["application/json"]?.schema;
const character = initialize?.properties?.character;
for (const field of ["name", "motto", "coreDesire", "weaknessFear"]) {
  if (!character?.required?.includes(field)) throw new Error(`Core character initialization field is not required after deployment: ${field}`);
}
for (const field of ["motto", "importantBonds", "coreDesire", "weaknessFear", "startingStyle", "destinyTalents", "relationships"]) {
  if (!Object.hasOwn(character?.properties ?? {}, field)) throw new Error(`Character initialization field missing after deployment: ${field}`);
}
if (initialize?.required?.includes("opening")) throw new Error("Opening is unexpectedly mandatory after deployment");
if (initialize?.properties?.saveKey?.minLength !== 1 || initialize?.properties?.saveKey?.maxLength !== 200) throw new Error("Initialize saveKey compatibility bounds are wrong");
const update = spec.paths?.["/world/update"]?.post?.requestBody?.content?.["application/json"]?.schema;
if (!update?.required?.includes("expectedRevision")) throw new Error("Update expectedRevision is not required");
if (JSON.stringify(update?.properties?.expectedWorldState?.enum) !== JSON.stringify(["ACTIVE"])) throw new Error("Update contract is not ACTIVE-only");
if (update?.properties?.children?.items?.maxLength !== 1800) throw new Error("Update text limit is not Notion-safe");
if (update?.properties?.saveKey?.minLength !== 1 || update?.properties?.saveKey?.maxLength !== 200) throw new Error("Update saveKey compatibility bounds are wrong");
if (health?.ok !== true || health?.service !== "xuanche-engine") throw new Error("Health payload is not the Xuanche Engine");
if (health?.version !== expectedWorkerVersion) throw new Error(`Worker version ${health?.version} does not match ${expectedWorkerVersion}`);
if (health?.capabilities?.durableArchiveReset !== true) throw new Error("Durable archive Workflow binding is not enabled");

console.log("Deployed GPT Action verification passed");
