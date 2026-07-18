const origin = process.argv[2];
if (!origin || !/^https:\/\//.test(origin)) {
  console.error("Usage: node gateway/scripts/verify-deployed-gpt-action.mjs https://your-gateway.pages.dev");
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
const fields = ["confirmation", "expectedWorldId", "operationKey"];
const missing = fields.filter((field) => !archive?.required?.includes(field) || !Object.hasOwn(archive?.properties ?? {}, field));

if (spec.servers?.[0]?.url !== base) throw new Error("Action spec server does not match the deployed origin");
if (!spec.components?.schemas || typeof spec.components.schemas !== "object") throw new Error("Action spec has no components.schemas object");
if (missing.length > 0) throw new Error(`Archive Action fields missing after deployment: ${missing.join(", ")}`);
if (archive.properties.confirmation.enum?.[0] !== "ARCHIVE_AND_RESET") throw new Error("Archive Action confirmation contract is incorrect");
if (!archiveStatus) throw new Error("Archive reset status Action is missing after deployment");
const statusParameters = archiveStatus.parameters ?? [];
for (const field of ["expectedWorldId", "operationKey"]) {
  if (!statusParameters.some((parameter) => parameter.name === field && parameter.in === "query" && parameter.required === true)) {
    throw new Error(`Archive status Action parameter missing after deployment: ${field}`);
  }
}
if (health?.ok !== true || health?.service !== "xuanche-engine") throw new Error("Health payload is not the Xuanche Engine");
if (health?.capabilities?.durableArchiveReset !== true) throw new Error("Durable archive Workflow binding is not enabled");

console.log("Deployed GPT Action verification passed");
