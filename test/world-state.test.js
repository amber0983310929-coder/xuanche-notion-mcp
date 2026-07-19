import assert from "node:assert/strict";
import test from "node:test";

import { parseWorldMarkers } from "../src/world-state.js";

function paragraph(text, id = crypto.randomUUID()) {
  return { id, type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } };
}

const playerState = {
  name: "楚凌霄",
  cultivation: "凡人",
  body: "左踝重傷",
  equipment: "採藥短刀",
  location: "禁山岩坪",
  constraints: "行動不便",
  abilities: "辨識草藥；尚無神通",
};

test("canonical save block wins over stale duplicate marker mirrors", () => {
  const markers = parseWorldMarkers([
    paragraph([
      "SAVE_SCHEMA_VERSION：SAVE_V3.2｜WORLD_STATE：ACTIVE｜WORLD_ID：W-current",
      "SIM_TICK：16｜狀態修訂：17｜SAVE_KEY：turn-current",
      `PLAYER_STATE_V1：${JSON.stringify(playerState)}`,
    ].join("\n")),
    paragraph("SIM_TICK：13"),
    paragraph("狀態修訂：14"),
    paragraph("SAVE_KEY：turn-stale"),
  ]);

  assert.equal(markers.worldId, "W-current");
  assert.equal(markers.simTick, 16);
  assert.equal(markers.revision, 17);
  assert.equal(markers.saveKey, "turn-current");
  assert.deepEqual(markers.playerState, playerState);
  assert.equal(markers.canonicalMarkerCount, 1);
});

test("duplicate canonical markers fail closed", () => {
  assert.throws(() => parseWorldMarkers([
    paragraph("SAVE_SCHEMA_VERSION：SAVE_V3.2｜WORLD_STATE：ACTIVE｜WORLD_ID：W-one"),
    paragraph("SAVE_SCHEMA_VERSION：SAVE_V3.2｜WORLD_STATE：ACTIVE｜WORLD_ID：W-two"),
  ]), /more than one canonical save marker/);
});

test("legacy one-marker-per-block pages remain readable", () => {
  const markers = parseWorldMarkers([
    paragraph("WORLD_STATE：EMPTY"),
    paragraph("WORLD_ID：PENDING"),
    paragraph("SIM_TICK：0"),
    paragraph("狀態修訂：0"),
  ]);
  assert.equal(markers.worldState, "EMPTY");
  assert.equal(markers.worldId, "PENDING");
  assert.equal(markers.simTick, 0);
  assert.equal(markers.revision, 0);
  assert.equal(markers.canonicalMarkerCount, 0);
  assert.equal(markers.playerState, null);
});

test("malformed or duplicate canonical player state records fail closed", () => {
  assert.throws(() => parseWorldMarkers([
    paragraph("SAVE_SCHEMA_VERSION：SAVE_V3.3｜WORLD_STATE：ACTIVE｜WORLD_ID：W-one\nPLAYER_STATE_V1：{broken}"),
  ]), /not valid JSON/);
  assert.throws(() => parseWorldMarkers([
    paragraph([
      "SAVE_SCHEMA_VERSION：SAVE_V3.3｜WORLD_STATE：ACTIVE｜WORLD_ID：W-one",
      `PLAYER_STATE_V1：${JSON.stringify(playerState)}`,
      `PLAYER_STATE_V1：${JSON.stringify(playerState)}`,
    ].join("\n")),
  ]), /duplicate PLAYER_STATE_V1/);
});
