import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceArchiveControllerJob,
  archiveControllerCommand,
  archiveControllerStatus,
  createArchiveControllerJob,
  failArchiveControllerJob,
  restartArchiveControllerJob,
} from "../src/archive-reset-controller.js";
import { ARCHIVE_RESET_STEPS } from "../src/archive-reset-step.js";
import { MAX_CLEAR_BATCHES } from "../src/archive-reset-staged.js";
import { STATE_PAGE_KEYS } from "../src/world-state.js";

const input = {
  confirmation: "ARCHIVE_AND_RESET",
  expectedWorldId: "W20260719-9E6FAA5A",
  operationKey: "pwa-world-5b2d4113-aa0f-482c-9076-7f1611ea69b1",
};

test("alarm controller advances every archive and reset batch in safe order", () => {
  let job = createArchiveControllerJob(input, { now: "2026-07-20T10:00:00.000Z" });
  assert.equal(archiveControllerCommand(job).operation, ARCHIVE_RESET_STEPS.PREPARE);
  job = advanceArchiveControllerJob(job, { archiveId: "archive-1" });

  for (const key of STATE_PAGE_KEYS) {
    assert.deepEqual(archiveControllerCommand(job), {
      operation: ARCHIVE_RESET_STEPS.BEGIN_PAGE,
      key,
    });
    job = advanceArchiveControllerJob(job, { done: false, batchIndex: 0 });
    assert.equal(archiveControllerCommand(job).operation, ARCHIVE_RESET_STEPS.CAPTURE_PAGE_BATCH);
    job = advanceArchiveControllerJob(job, { done: false, batchIndex: 1 });
    assert.equal(archiveControllerCommand(job).operation, ARCHIVE_RESET_STEPS.CAPTURE_PAGE_BATCH);
    job = advanceArchiveControllerJob(job, { done: true, batchIndex: 2 });
    assert.equal(archiveControllerCommand(job).operation, ARCHIVE_RESET_STEPS.FINALIZE_PAGE);
    job = advanceArchiveControllerJob(job, { done: true });
  }

  assert.equal(archiveControllerCommand(job).operation, ARCHIVE_RESET_STEPS.VERIFY_ARCHIVE);
  job = advanceArchiveControllerJob(job, { phase: "archive_verified" });
  assert.equal(job.archiveVerified, true);

  for (const key of STATE_PAGE_KEYS) {
    assert.deepEqual(archiveControllerCommand(job), {
      operation: ARCHIVE_RESET_STEPS.MARK_PAGE_RESETTING,
      key,
    });
    job = advanceArchiveControllerJob(job, {});
    assert.equal(archiveControllerCommand(job).operation, ARCHIVE_RESET_STEPS.CLEAR_PAGE_BATCH);
    job = advanceArchiveControllerJob(job, { done: false });
    assert.equal(archiveControllerCommand(job).operation, ARCHIVE_RESET_STEPS.CLEAR_PAGE_BATCH);
    job = advanceArchiveControllerJob(job, { done: true });
    assert.equal(archiveControllerCommand(job).operation, ARCHIVE_RESET_STEPS.MARK_PAGE_EMPTY);
    job = advanceArchiveControllerJob(job, {});
  }

  assert.equal(archiveControllerCommand(job).operation, ARCHIVE_RESET_STEPS.CLEAR_CACHE_BATCH);
  job = advanceArchiveControllerJob(job, { done: false });
  job = advanceArchiveControllerJob(job, { done: true });
  assert.equal(archiveControllerCommand(job).operation, ARCHIVE_RESET_STEPS.FINALIZE_RESET);
  job = advanceArchiveControllerJob(job, {
    archived: true,
    reset: true,
    worldState: "EMPTY",
    archive: { archiveId: "archive-1" },
  });

  const status = archiveControllerStatus(job, "controller-1");
  assert.equal(status.workflowStatus, "complete");
  assert.equal(status.safeToInitialize, true);
  assert.equal(status.worldState, "EMPTY");
  assert.equal(status.progress.archivedPageCount, STATE_PAGE_KEYS.length);
  assert.equal(status.progress.resetPageCount, STATE_PAGE_KEYS.length);
  assert.equal(archiveControllerCommand(job), null);
});

test("alarm controller keeps transient failures waiting and restarts terminal failures", () => {
  const running = advanceArchiveControllerJob(createArchiveControllerJob(input), { archiveId: "archive-1" });
  const waiting = failArchiveControllerJob(running, Object.assign(new Error("rate limited"), { status: 429 }));
  assert.equal(waiting.status, "waiting");
  assert.equal(archiveControllerStatus(waiting).workflowStatus, "waiting");
  assert.equal(restartArchiveControllerJob(waiting, input), waiting);

  const terminal = failArchiveControllerJob(running, Object.assign(new Error("identity mismatch"), { status: 409 }));
  assert.equal(terminal.status, "errored");
  const restarted = restartArchiveControllerJob(terminal, input);
  assert.equal(restarted.status, "queued");
  assert.equal(restarted.machine.phase, "prepare");
  assert.equal(restarted.workflowAttempt, 1);
  assert.equal(restarted.continuationSequence, 1);
});

test("alarm controller stops automatic retries after six resumable failures", () => {
  let job = advanceArchiveControllerJob(createArchiveControllerJob(input), { archiveId: "archive-1" });
  const unavailable = Object.assign(new Error("Notion unavailable"), { status: 503 });

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    job = failArchiveControllerJob(job, unavailable);
    assert.equal(job.status, "waiting");
    assert.equal(job.consecutiveFailures, attempt);
  }

  job = failArchiveControllerJob(job, unavailable);
  assert.equal(job.status, "errored");
  assert.equal(archiveControllerStatus(job).nextAction, "RETRY_SAME_OPERATION");
});

test("alarm controller allows the marker-preserving maximum clear batch count", () => {
  let job = createArchiveControllerJob(input);
  job = {
    ...job,
    status: "running",
    archiveVerified: true,
    resetStarted: true,
    machine: { ...job.machine, phase: "clear_page", clearBatch: 0 },
  };

  for (let batch = 0; batch < MAX_CLEAR_BATCHES; batch += 1) {
    job = advanceArchiveControllerJob(job, { done: false });
  }
  assert.equal(job.machine.clearBatch, MAX_CLEAR_BATCHES);
  assert.throws(
    () => advanceArchiveControllerJob(job, { done: false }),
    /clear-page batch safety limit/,
  );
});
