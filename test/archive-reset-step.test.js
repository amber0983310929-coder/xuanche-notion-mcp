import test from "node:test";
import assert from "node:assert/strict";

import {
  ARCHIVE_RESET_STEPS,
  executeArchiveResetStep,
  executeArchiveResetStepThroughBinding,
} from "../src/archive-reset-step.js";

const input = {
  confirmation: "ARCHIVE_AND_RESET",
  expectedWorldId: "W20260719-9E6FAA5A",
  operationKey: "pwa-world-5b2d4113-aa0f-482c-9076-7f1611ea69b1",
};

test("archive step dispatcher validates and forwards a page-scoped batch", async () => {
  let received;
  const handlers = {
    [ARCHIVE_RESET_STEPS.CLEAR_PAGE_BATCH]: {
      pageScoped: true,
      async handler(env, request, key, dependencies) {
        received = { env, request, key, dependencies };
        return { done: false, archived: 40 };
      },
    },
  };
  const dependencies = { marker: true };
  const result = await executeArchiveResetStep(
    { test: true },
    { operation: ARCHIVE_RESET_STEPS.CLEAR_PAGE_BATCH, input, key: "save" },
    dependencies,
    handlers,
  );

  assert.deepEqual(result, { done: false, archived: 40 });
  assert.equal(received.key, "save");
  assert.equal(received.request, input);
  assert.equal(received.dependencies, dependencies);
});

test("archive step dispatcher rejects unknown operations and page keys", async () => {
  await assert.rejects(
    executeArchiveResetStep({}, { operation: "unknown", input }),
    /Unknown archive-and-reset step/,
  );
  await assert.rejects(
    executeArchiveResetStep({}, {
      operation: ARCHIVE_RESET_STEPS.CLEAR_PAGE_BATCH,
      input,
      key: "home",
    }),
    /requires a fixed world page key/,
  );
});

test("Workflow binding client uses one deterministic Durable Object RPC", async () => {
  let objectName;
  let request;
  const namespace = {
    getByName(name) {
      objectName = name;
      return {
        async runStep(value) {
          request = value;
          return { ok: true, data: { done: true } };
        },
      };
    },
  };

  const result = await executeArchiveResetStepThroughBinding(
    namespace,
    input,
    ARCHIVE_RESET_STEPS.BEGIN_PAGE,
    "character",
  );
  assert.deepEqual(result, { done: true });
  assert.equal(objectName, input.expectedWorldId + ":" + input.operationKey);
  assert.deepEqual(request, {
    operation: ARCHIVE_RESET_STEPS.BEGIN_PAGE,
    input,
    key: "character",
  });
});

test("Workflow binding client rehydrates executor errors for step retries", async () => {
  const namespace = {
    getByName() {
      return {
        async runStep() {
          return { ok: false, status: 429, error: "rate limited", details: { code: "rate_limited" } };
        },
      };
    },
  };

  await assert.rejects(
    executeArchiveResetStepThroughBinding(namespace, input, ARCHIVE_RESET_STEPS.PREPARE),
    (error) => error.status === 429 && error.details.code === "rate_limited",
  );
});
