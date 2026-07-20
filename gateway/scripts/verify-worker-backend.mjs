const [
  baseUrl = "https://plain-dew-5810xuanche-api.amber0983310929.workers.dev",
  expectedVersion = "0.5.19",
] = process.argv.slice(2);

const healthUrl = new URL("/health?deep=0", baseUrl);
const response = await fetch(healthUrl, {
  headers: { Accept: "application/json" },
});

if (!response.ok) {
  throw new Error(`Worker health preflight failed with HTTP ${response.status}`);
}

const health = await response.json();
if (health?.ok !== true || health?.service !== "xuanche-engine") {
  throw new Error("Worker health preflight did not return the Xuanche Engine");
}
if (health?.version !== expectedVersion) {
  throw new Error(`Worker version ${health?.version ?? "unknown"} does not match required ${expectedVersion}`);
}
if (health?.capabilities?.durableArchiveReset !== true) {
  throw new Error("Worker durable archive-and-reset capability is not enabled");
}
if (health?.capabilities?.combatRulesInTurnContext !== true) {
  throw new Error("Worker mandatory COMBAT rule loading is not enabled");
}
if (health?.capabilities?.dynamicProtagonistIdentity !== true ||
    health?.capabilities?.authoritativeProtagonistValidation !== true) {
  throw new Error("Worker authoritative protagonist identity protection is not enabled");
}

console.log(`Worker backend preflight passed (${health.version})`);
