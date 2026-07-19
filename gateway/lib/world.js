import { GatewayError } from "./http.js";

const CONTEXT_LIMITS = Object.freeze({
  save: 4_000,
  character: 5_000,
  timeline: 3_000,
  events: 3_000,
  director: 3_000,
  hud: 2_500,
});

export function summarizeWorldSnapshot(snapshot) {
  const world = snapshot?.meta?.world;
  if (!world || world.worldState !== "ACTIVE" || !world.worldId) {
    throw new GatewayError(409, "目前沒有可遊玩的 ACTIVE 世界。", { world });
  }
  const pages = new Map((snapshot.pages || []).map((page) => [page.key, page]));
  const saveBlocks = pages.get("save")?.children || [];
  const saveTexts = flattenBlockTexts(saveBlocks);
  const mainline = findPrefix(saveTexts, ["當前主線：", "當前主線:"]) || "尚未建立當前主線。";
  const location = findPrefix(saveTexts, ["當前位置與局勢｜", "當前位置與局勢：", "初始位置："]) || "位置未明";
  return {
    worldState: world.worldState,
    worldId: world.worldId,
    simTick: world.simTick,
    revision: world.revision,
    saveKey: world.saveKey || null,
    lastActionKey: world.lastActionKey || null,
    mainline: stripLabel(mainline),
    situation: stripLabel(location),
    loadedAt: snapshot.loadedAt,
    cache: snapshot.meta?.cache || "unknown",
  };
}

export function buildModelWorldContext(snapshot) {
  const state = summarizeWorldSnapshot(snapshot);
  const sections = [];
  for (const page of snapshot.pages || []) {
    const limit = CONTEXT_LIMITS[page.key];
    if (!limit) continue;
    let text;
    if (page.key === "save") {
      const lines = flattenBlockTexts(page.children || []);
      const selected = lines.filter((line) =>
        line.startsWith("SAVE_SCHEMA_VERSION：") ||
        line.startsWith("當前主線：") ||
        line.startsWith("主角：") ||
        line.startsWith("初始位置：") ||
        line.startsWith("初始時間："));
      text = selected.join("\n");
    } else {
      text = flattenBlockTexts(page.children || []).join("\n");
    }
    text = removeVoidedRecords(text).slice(0, limit);
    if (text) sections.push(`【${page.title || page.key}】\n${text}`);
  }
  return {
    state,
    text: sections.join("\n\n").slice(0, 18_000),
  };
}

export function flattenBlockTexts(blocks) {
  const output = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const text = blockText(block).trim();
    if (text) output.push(text);
    if (Array.isArray(block?.children)) output.push(...flattenBlockTexts(block.children));
  }
  return output;
}

export function blockText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (typeof block.text === "string") return block.text;
  const payload = block[block.type] || block;
  if (Array.isArray(payload?.cells)) return payload.cells.map(richText).join(" | ");
  return richText(payload?.rich_text || payload?.title || payload?.caption);
}

function richText(value) {
  if (!Array.isArray(value)) return "";
  return value.map((item) => item?.plain_text ?? item?.text?.content ?? "").join("");
}

function findPrefix(lines, prefixes) {
  return lines.find((line) => prefixes.some((prefix) => line.startsWith(prefix))) || null;
}

function stripLabel(value) {
  return String(value).replace(/^[^：:｜]{1,30}[：:｜]\s*/u, "").trim();
}

function removeVoidedRecords(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => !/^(VOID|VOID_SAVE_KEY|RECONCILIATION)[｜：:]/.test(line.trim()))
    .join("\n");
}
