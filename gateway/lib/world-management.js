import { GatewayError } from "./http.js";

export const WORLD_OPERATION_MODES = Object.freeze([
  "new_game",
  "restart_game",
  "reset_world",
]);

export const WORLD_OPERATION_CONFIRMATIONS = Object.freeze({
  new_game: "建立新遊戲",
  restart_game: "重新開始",
  reset_world: "重置世界",
});

const WORLD_ID_PATTERN = /^W\d{8}-[0-9A-F]{8}$/;
const OPERATION_KEY_PATTERN = /^[A-Za-z0-9._-]{8,120}$/;
const SAVE_KEY_PATTERN = /^[A-Za-z0-9._-]{8,200}$/;

export function validateArchiveRequest(input = {}, { requireTypedConfirmation = false } = {}) {
  const mode = normalizeMode(input.mode);
  const expectedWorldId = boundedString(input.expectedWorldId, "expectedWorldId", 32, { required: true });
  const operationKey = boundedString(input.operationKey, "operationKey", 120, { required: true });
  if (!WORLD_ID_PATTERN.test(expectedWorldId)) {
    throw new GatewayError(400, "世界識別碼與目前 ACTIVE 世界不符。");
  }
  if (!OPERATION_KEY_PATTERN.test(operationKey)) {
    throw new GatewayError(400, "世界操作識別碼格式不正確。");
  }
  if (requireTypedConfirmation && input.typedConfirmation !== WORLD_OPERATION_CONFIRMATIONS[mode]) {
    throw new GatewayError(400, `請完整輸入「${WORLD_OPERATION_CONFIRMATIONS[mode]}」確認此操作。`);
  }
  return { mode, expectedWorldId, operationKey };
}

export function validateInitializationRequest(input = {}) {
  const mode = normalizeMode(input.mode, ["new_game", "restart_game"]);
  const saveKey = boundedString(input.saveKey, "saveKey", 200, { required: true });
  if (!SAVE_KEY_PATTERN.test(saveKey)) {
    throw new GatewayError(400, "新世界存檔鍵格式不正確。");
  }
  if (!plainObject(input.character)) throw new GatewayError(400, "缺少有效的角色設定。");
  if (input.opening !== undefined && !plainObject(input.opening)) {
    throw new GatewayError(400, "開局設定格式不正確。");
  }

  const character = compactObject({
    name: boundedString(input.character.name, "角色姓名", 40, { required: true }),
    gender: boundedString(input.character.gender, "性別", 20),
    age: boundedString(input.character.age, "年齡", 20),
    appearance: boundedString(input.character.appearance, "外貌", 240),
    personality: boundedList(input.character.personality, "性格", 8, 50),
    background: boundedString(input.character.background, "身世背景", 500),
    motivation: boundedString(input.character.motivation, "人生目標", 240),
    bottomLine: boundedString(input.character.bottomLine, "底線", 240),
    equipment: boundedString(input.character.equipment, "初始裝備", 240),
    cultivation: boundedString(input.character.cultivation, "初始修為", 120),
    body: boundedString(input.character.body, "初始身體", 160),
    constraints: boundedString(input.character.constraints, "初始限制", 160),
    relationships: boundedList(input.character.relationships, "初始關係", 10, 120),
  });
  const openingInput = input.opening || {};
  const opening = compactObject({
    location: boundedString(openingInput.location, "初始位置", 160),
    time: boundedString(openingInput.time, "初始時間", 80),
    premise: boundedString(openingInput.premise, "開局前提", 600),
    knownAbilities: boundedList(openingInput.knownAbilities, "已知能力", 12, 100),
    knownWorldFacts: boundedList(openingInput.knownWorldFacts, "已知世界資訊", 12, 140),
    promises: boundedList(openingInput.promises, "初始承諾", 10, 140),
    visibleClue: boundedString(openingInput.visibleClue, "初始線索", 300),
    choices: boundedList(openingInput.choices, "初始選項", 6, 160),
  });
  return { mode, saveKey, character, opening };
}

function normalizeMode(value, allowed = WORLD_OPERATION_MODES) {
  if (!allowed.includes(value)) throw new GatewayError(400, "不支援的世界操作。");
  return value;
}

function boundedString(value, label, maximum, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new GatewayError(400, `${label}不可空白。`);
    return "";
  }
  if (typeof value !== "string") throw new GatewayError(400, `${label}必須是文字。`);
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (required && !normalized) throw new GatewayError(400, `${label}不可空白。`);
  if (normalized.length > maximum) throw new GatewayError(400, `${label}不可超過 ${maximum} 字。`);
  return normalized;
}

function boundedList(value, label, maximumItems, maximumLength) {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value)) throw new GatewayError(400, `${label}必須是文字陣列。`);
  if (value.length > maximumItems) throw new GatewayError(400, `${label}最多 ${maximumItems} 項。`);
  return value.map((item, index) => boundedString(item, `${label}第 ${index + 1} 項`, maximumLength, { required: true }));
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && (!Array.isArray(item) || item.length > 0)));
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
