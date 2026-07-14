import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WORLD_CONFIG, selectWorldPages } from "../src/loader.js";

test("continue profile selects only the core narrative modules", () => {
  const pages = selectWorldPages(DEFAULT_WORLD_CONFIG, "continue");
  assert.deepEqual(pages.map((page) => page.key), [
    "home", "route", "rules", "save", "timeline",
    "flow", "npc", "protagonist", "world", "hud",
  ]);
});

test("profiles accept deduplicated extra modules", () => {
  const pages = selectWorldPages(DEFAULT_WORLD_CONFIG, "continue", ["equipment", "economy", "hud"]);
  assert.equal(pages.filter((page) => page.key === "hud").length, 1);
  assert.deepEqual(pages.slice(-2).map((page) => page.key), ["equipment", "economy"]);
});

test("full profile includes the complete home plus 00-29 catalog", () => {
  const pages = selectWorldPages(DEFAULT_WORLD_CONFIG, "full");
  assert.equal(pages.length, 31);
});

test("unknown profiles fail with available choices", () => {
  assert.throws(() => selectWorldPages(DEFAULT_WORLD_CONFIG, "missing"), /Unknown world load profile/);
});
