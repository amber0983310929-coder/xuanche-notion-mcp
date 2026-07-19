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
  if (!world || !world.worldState || !world.worldId) {
    throw new GatewayError(409, "目前沒有可讀取的世界狀態。", { world });
  }
  if (world.worldState === "EMPTY" && world.worldId === "PENDING") {
    return {
      worldState: "EMPTY",
      empty: true,
      worldId: "PENDING",
      simTick: 0,
      revision: 0,
      saveKey: null,
      lastActionKey: null,
      mainline: "尚未建立世界",
      situation: "等待建立新遊戲",
      profile: null,
      playerState: null,
      loadedAt: snapshot.loadedAt,
      cache: snapshot.meta?.cache || "unknown",
    };
  }
  if (world.worldState !== "ACTIVE") {
    throw new GatewayError(409, "目前沒有可遊玩的 ACTIVE 世界。", { world });
  }
  const pages = new Map((snapshot.pages || []).map((page) => [page.key, page]));
  const saveBlocks = pages.get("save")?.children || [];
  const saveTexts = flattenBlockTexts(saveBlocks);
  const characterTexts = flattenBlockTexts(pages.get("character")?.children || []);
  const mainline = findPrefix(saveTexts, ["當前主線：", "當前主線:"]) || "尚未建立當前主線。";
  const location = findLastPrefix(saveTexts, ["當前位置與局勢｜", "當前位置與局勢："])
    || findPrefix(saveTexts, ["初始位置：", "初始位置:"])
    || "位置未明";
  const profile = summarizeCharacter(characterTexts, world.playerState);
  const playerState = world.playerState
    ? { ...world.playerState, calibrated: true }
    : legacyPlayerState(profile, characterTexts, stripLabel(location));
  return {
    worldState: world.worldState,
    empty: false,
    worldId: world.worldId,
    simTick: world.simTick,
    revision: world.revision,
    saveKey: world.saveKey || null,
    lastActionKey: world.lastActionKey || null,
    mainline: stripLabel(mainline),
    situation: stripLabel(location),
    profile,
    playerState,
    loadedAt: snapshot.loadedAt,
    cache: snapshot.meta?.cache || "unknown",
  };
}

export function buildModelWorldContext(snapshot) {
  const state = summarizeWorldSnapshot(snapshot);
  if (state.empty) throw new GatewayError(409, "世界尚未建立，請先使用「新的遊戲」。");
  const sections = [];
  for (const page of snapshot.pages || []) {
    const limit = CONTEXT_LIMITS[page.key];
    if (!limit) continue;
    let text;
    if (page.key === "save") {
      const lines = flattenBlockTexts(page.children || []);
      const selected = lines.filter((line) =>
        line.startsWith("SAVE_SCHEMA_VERSION：") ||
        line.startsWith("SAVE_SCHEMA_VERSION:") ||
        line.startsWith("當前主線：") ||
        line.startsWith("當前主線:") ||
        line.startsWith("主角：") ||
        line.startsWith("初始位置：") ||
        line.startsWith("初始時間："));
      text = [...new Set([...selected, ...latestTurnContext(lines)])].join("\n");
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

function findLastPrefix(lines, prefixes) {
  return [...lines].reverse().find((line) => prefixes.some((prefix) => line.startsWith(prefix))) || null;
}

function summarizeCharacter(lines, playerState) {
  const name = stripLabel(findPrefix(lines, ["姓名：", "姓名:", "主角：", "主角:", "name：", "name:"]) || playerState?.name || "楚凌霄");
  const age = stripLabel(findPrefix(lines, ["年齡：", "年齡:", "age：", "age:"]) || "16歲");
  const appearance = stripLabel(findPrefix(lines, ["外貌：", "外貌:", "形貌：", "形貌:", "appearance：", "appearance:"]) || "");
  const background = stripLabel(findPrefix(lines, ["人物簡介：", "人物簡介:", "身世背景：", "身世背景:", "背景：", "背景:", "background：", "background:"]) || "");
  const motto = stripLabel(findPrefix(lines, ["座右銘：", "座右銘:", "信念：", "信念:", "motivation：", "motivation:"]) || "山路再險，也要看清下一步。 ");
  return {
    name: clampText(name || "楚凌霄", 40),
    age: clampText(age || "年齡未知", 24),
    intro: clampText([appearance, background].filter(Boolean).join("；") || "山村採藥少年，善辨草木與山勢，尚未踏入修行。", 180),
    motto: clampText(motto, 100),
    portrait: name.includes("楚凌霄") ? "/images/chulingxiao-v1.webp" : null,
  };
}

function legacyPlayerState(profile, characterLines, location) {
  const abilities = stripLabel(findLastPrefix(characterLines, [
    "玩家已知能力：", "玩家已知能力:", "已知能力：", "已知能力:", "能力：", "能力:", "abilities：", "abilities:",
  ]) || "待下一回合校準");
  return {
    name: profile.name,
    cultivation: characterField(characterLines, ["修為：", "修為:", "cultivation：", "cultivation:"]) || "待下一回合校準",
    body: characterField(characterLines, ["身體狀況：", "身體狀況:", "body：", "body:"]) || "待下一回合校準",
    equipment: characterField(characterLines, ["武器裝備：", "武器裝備:", "初始裝備：", "初始裝備:", "equipment：", "equipment:"]) || "待下一回合校準",
    location: clampText(location || "位置未明", 180),
    constraints: characterField(characterLines, ["行動限制：", "行動限制:", "constraints：", "constraints:"]) || "待下一回合校準",
    abilities: clampText(abilities, 180),
    calibrated: false,
  };
}

function characterField(lines, prefixes) {
  const value = findLastPrefix(lines, prefixes);
  return value ? clampText(stripLabel(value), 180) : "";
}

function latestTurnContext(lines) {
  let index = -1;
  for (let cursor = lines.length - 1; cursor >= 0; cursor -= 1) {
    if (/^回合\s+\d+[｜:：]/u.test(lines[cursor])) {
      index = cursor;
      break;
    }
  }
  return index < 0 ? [] : lines.slice(index);
}

function clampText(value, maximum) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
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
