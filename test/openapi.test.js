import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenApi } from "../src/openapi.js";

test("OpenAPI is bound to the deployed origin and exposes unique operation IDs", () => {
  const document = buildOpenApi("https://worker.example/openapi.json");
  assert.equal(document.openapi, "3.1.0");
  assert.equal(document.info.version, "0.5.3");
  assert.equal(document.servers[0].url, "https://worker.example");

  const operationIds = Object.values(document.paths)
    .flatMap((path) => Object.values(path))
    .map((operation) => operation.operationId);
  assert.equal(new Set(operationIds).size, operationIds.length);
  assert.equal(operationIds.every(Boolean), true);
});

test("every OpenAPI object schema declares properties for GPT Actions", () => {
  const document = buildOpenApi("https://worker.example/openapi.json");
  const missing = [];

  const visit = (value, path = "root") => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.type === "object" && !Object.hasOwn(value, "properties")) missing.push(path);
    Object.entries(value).forEach(([key, child]) => visit(child, `${path}.${key}`));
  };

  visit(document);
  assert.deepEqual(missing, []);
});

test("OpenAPI protects world reads and defines GPT Action request bodies", () => {
  const document = buildOpenApi("https://worker.example/openapi.json");
  assert.deepEqual(document.paths["/home"].get.security, [{ apiKey: [] }]);
  assert.deepEqual(document.paths["/tree"].get.security, [{ apiKey: [] }]);
  assert.equal(
    document.paths["/world/load"].post.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/WorldLoadRequest",
  );
  assert.equal(
    document.paths["/world/update"].post.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/WorldUpdateRequest",
  );
});
