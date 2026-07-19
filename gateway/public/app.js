const STORAGE = Object.freeze({
  settings: "xuanche:pwa:settings:v1",
  pending: "xuanche:pwa:pending:v1",
  state: "xuanche:pwa:state:v1",
  locked: "xuanche:pwa:locked:v1",
  historyPrefix: "xuanche:pwa:history:v1:",
});

const elements = {
  connectionDot: document.querySelector("#connection-dot"),
  connectionLabel: document.querySelector("#connection-label"),
  tickBadge: document.querySelector("#tick-badge"),
  mainline: document.querySelector("#mainline"),
  worldId: document.querySelector("#world-id"),
  revision: document.querySelector("#revision"),
  saveState: document.querySelector("#save-state"),
  style: document.querySelector("#style-select"),
  length: document.querySelector("#length-select"),
  story: document.querySelector("#story"),
  choices: document.querySelector("#choices"),
  turnStatus: document.querySelector("#turn-status"),
  actionForm: document.querySelector("#action-form"),
  actionInput: document.querySelector("#action-input"),
  sendButton: document.querySelector("#send-button"),
  alert: document.querySelector("#alert"),
  refreshButton: document.querySelector("#refresh-button"),
  logoutButton: document.querySelector("#logout-button"),
  installButton: document.querySelector("#install-button"),
  loginDialog: document.querySelector("#login-dialog"),
  loginForm: document.querySelector("#login-form"),
  passphrase: document.querySelector("#passphrase"),
  loginError: document.querySelector("#login-error"),
  narrativeTemplate: document.querySelector("#narrative-template"),
  playerTemplate: document.querySelector("#player-template"),
};

const game = {
  state: null,
  choices: [],
  busy: false,
  installPrompt: null,
  currentCard: null,
  checkpoint: readStorage(STORAGE.pending),
};

applyStoredSettings();
bindEvents();
registerServiceWorker();
updateConnection();
bootstrap();

async function bootstrap() {
  try {
    const session = await apiJson("/api/session");
    if (!session.authenticated) {
      openLogin(session.configuration);
      return;
    }
    writeStorage(STORAGE.locked, false);
    await loadWorld();
  } catch (error) {
    if (showOfflineSnapshot()) return;
    showAlert(error.message, true);
    openLogin();
  }
}

function bindEvents() {
  window.addEventListener("online", updateConnection);
  window.addEventListener("offline", updateConnection);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    game.installPrompt = event;
    elements.installButton.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    game.installPrompt = null;
    elements.installButton.hidden = true;
  });

  elements.actionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const action = elements.actionInput.value.trim();
    if (action) submitAction(action);
  });
  elements.actionInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      elements.actionForm.requestSubmit();
    }
  });
  elements.style.addEventListener("change", saveSettings);
  elements.length.addEventListener("change", saveSettings);
  elements.refreshButton.addEventListener("click", () => loadWorld({ refresh: true }));
  elements.installButton.addEventListener("click", installApp);
  elements.logoutButton.addEventListener("click", logout);
  elements.loginDialog.addEventListener("cancel", (event) => event.preventDefault());
  elements.loginForm.addEventListener("submit", login);
}

async function login(event) {
  event.preventDefault();
  elements.loginError.textContent = "";
  const button = elements.loginForm.querySelector("button");
  button.disabled = true;
  try {
    await apiJson("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: elements.passphrase.value }),
    });
    elements.passphrase.value = "";
    writeStorage(STORAGE.locked, false);
    elements.loginDialog.close();
    await loadWorld();
  } catch (error) {
    elements.loginError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  try {
    await apiJson("/api/session", { method: "DELETE" });
  } catch {
    // Lock the local surface even when the network disappears.
  }
  game.state = null;
  writeStorage(STORAGE.locked, true);
  setBusy(true, "已鎖定");
  openLogin();
}

function openLogin(configuration) {
  if (configuration && !configuration.passphrase) {
    elements.loginError.textContent = "部署端尚未設定私人登入。";
  }
  if (!elements.loginDialog.open) elements.loginDialog.showModal();
  setTimeout(() => elements.passphrase.focus(), 50);
}

async function loadWorld({ refresh = false } = {}) {
  setBusy(true, refresh ? "核對世界中" : "載入世界中");
  hideAlert();
  try {
    const payload = await apiJson(`/api/game/state${refresh ? "?refresh=1" : ""}`);
    game.state = payload.state;
    const cached = readStorage(STORAGE.state);
    if (
      cached?.state?.worldId === game.state.worldId &&
      cached.state.simTick === game.state.simTick &&
      Array.isArray(cached.choices)
    ) game.choices = cached.choices;
    cacheCurrentState();
    renderWorldState();
    renderStoryFromStorage();
    reconcilePendingCheckpoint();
    if (!payload.ready.model) showAlert("介面與世界引擎已就緒；設定 OPENAI_API_KEY 後即可生成新回合。", false);
    setBusy(false, "等待你的行動");
    elements.saveState.textContent = "已同步";
  } catch (error) {
    elements.saveState.textContent = "讀取失敗";
    showAlert(error.message, true);
    if (error.status === 401) openLogin();
    setBusy(true, "世界未就緒");
  }
}

function renderWorldState() {
  if (!game.state) return;
  elements.tickBadge.textContent = `T${game.state.simTick}`;
  elements.worldId.textContent = game.state.worldId;
  elements.worldId.title = game.state.worldId;
  elements.revision.textContent = `R${game.state.revision}`;
  elements.mainline.textContent = game.state.mainline;
}

function renderStoryFromStorage() {
  elements.story.replaceChildren();
  const history = historyForCurrentWorld();
  for (const turn of history) {
    appendPlayerAction(turn.action, false);
    const card = appendNarrativeCard(turn.tick, turn.narrative, "已保存", false);
    card.classList.remove("generating");
  }
  const lastTick = history.at(-1)?.tick;
  if (!history.length || lastTick !== game.state.simTick) {
    const card = appendNarrativeCard(
      game.state.simTick,
      [game.state.mainline, game.state.situation].filter(Boolean).join("\n\n"),
      "世界錨點",
      false,
    );
    card.classList.remove("generating");
  }
  renderChoices(game.choices);
}

async function submitAction(action) {
  if (game.busy || !game.state) return;
  if (game.checkpoint) {
    showAlert("上一回合仍有待確認的存檔，請先補存後再行動。", false);
    return;
  }
  hideAlert();
  const baseState = { ...game.state };
  const actionKey = crypto.randomUUID();
  elements.actionInput.value = "";
  renderChoices([]);
  appendPlayerAction(action);
  const card = appendNarrativeCard(baseState.simTick + 1, "", "推演中", true);
  game.currentCard = card;
  setBusy(true, "世界推演中");
  elements.saveState.textContent = "尚未提交";
  card.scrollIntoView({ behavior: "smooth", block: "center" });

  try {
    const response = await fetch("/api/game/turn", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action,
        actionKey,
        expectedWorldId: baseState.worldId,
        expectedSimTick: baseState.simTick,
        expectedRevision: baseState.revision,
        style: elements.style.value,
        length: elements.length.value,
      }),
    });
    if (!response.ok || !response.body) throw await responseError(response);

    let committed = false;
    await readEventStream(response.body, async (event, data) => {
      if (event === "delta") {
        appendNarrativeDelta(card, data.text || "");
      } else if (event === "checkpoint") {
        game.checkpoint = data.checkpoint;
        writeStorage(STORAGE.pending, game.checkpoint);
        card.querySelector(".card-status").textContent = "敘事完成 · 存檔中";
      } else if (event === "committed") {
        committed = true;
        finalizeCommittedTurn(card, action, data);
      } else if (event === "save_error") {
        markTurnUnsaved(card, data.error || "敘事已生成，但存檔尚未完成。");
      } else if (event === "error") {
        markTurnFailed(card, data.error || "本回合生成失敗。");
      }
    });
    if (!committed && !game.checkpoint && !card.classList.contains("failed")) {
      markTurnFailed(card, "連線在回合完成前中斷；世界狀態未確認變更。");
    }
  } catch (error) {
    if (game.checkpoint) markTurnUnsaved(card, error.message);
    else markTurnFailed(card, error.message);
  } finally {
    game.currentCard = null;
    setBusy(false, "等待你的行動");
  }
}

function finalizeCommittedTurn(card, action, data) {
  card.classList.remove("generating", "unsaved", "failed");
  card.querySelector(".card-status").textContent = `已保存 · T${data.simTick}`;
  const narrative = card.querySelector(".narrative-text");
  if (!narrative.textContent) narrative.textContent = data.narrative || "本回合已保存。";
  game.state = {
    ...game.state,
    worldId: data.worldId,
    simTick: data.simTick,
    revision: data.revision,
    mainline: data.mainline || game.state.mainline,
    situation: data.situation || game.state.situation,
  };
  game.choices = Array.isArray(data.choices) ? data.choices : [];
  renderWorldState();
  renderChoices(game.choices);
  elements.saveState.textContent = "已保存";
  game.checkpoint = null;
  localStorage.removeItem(STORAGE.pending);
  appendHistory({
    action,
    narrative: narrative.textContent,
    tick: data.simTick,
    actionKey: data.actionKey,
  });
  cacheCurrentState();
}

function markTurnUnsaved(card, message) {
  card.classList.remove("generating", "failed");
  card.classList.add("unsaved");
  card.querySelector(".card-status").textContent = "待補存";
  elements.saveState.textContent = "待補存";
  const actions = card.querySelector(".card-actions");
  actions.replaceChildren();
  const retry = document.createElement("button");
  retry.className = "inline-retry";
  retry.type = "button";
  retry.textContent = "重試存檔";
  retry.addEventListener("click", () => retryCheckpoint(card));
  actions.append(retry);
  showAlert(message, false);
}

function markTurnFailed(card, message) {
  card.classList.remove("generating", "unsaved");
  card.classList.add("failed");
  card.querySelector(".card-status").textContent = "未提交";
  if (!card.querySelector(".narrative-text").textContent) {
    card.querySelector(".narrative-text").textContent = "這次推演沒有改變世界。你可以稍後再次送出行動。";
  }
  elements.saveState.textContent = "未變更";
  showAlert(message, true);
}

async function retryCheckpoint(card = null) {
  const checkpoint = game.checkpoint || readStorage(STORAGE.pending);
  if (!checkpoint || game.busy) return;
  setBusy(true, "補存回合中");
  try {
    const payload = await apiJson("/api/game/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkpoint }),
    });
    if (!card) {
      appendPlayerAction(checkpoint.playerAction, false);
      card = appendNarrativeCard(payload.data.simTick, checkpoint.narrative, "已保存", false);
    }
    finalizeCommittedTurn(card, checkpoint.playerAction, {
      ...payload.data,
      narrative: checkpoint.narrative,
      mainline: checkpoint.mainline,
      situation: checkpoint.situation,
      choices: checkpoint.choices,
    });
    hideAlert();
  } catch (error) {
    showAlert(error.message, true);
  } finally {
    setBusy(false, "等待你的行動");
  }
}

function reconcilePendingCheckpoint() {
  const checkpoint = game.checkpoint;
  if (!checkpoint) return;
  if (
    checkpoint.expectedWorldId !== game.state.worldId ||
    game.state.lastActionKey === checkpoint.actionKey ||
    game.state.simTick > checkpoint.expectedSimTick
  ) {
    game.checkpoint = null;
    localStorage.removeItem(STORAGE.pending);
    return;
  }
  elements.alert.replaceChildren();
  elements.alert.hidden = false;
  elements.alert.classList.remove("error");
  const text = document.createElement("span");
  text.textContent = "偵測到一筆已生成但尚未確認的回合。";
  const retry = document.createElement("button");
  retry.className = "inline-retry";
  retry.type = "button";
  retry.textContent = "補存現在";
  retry.addEventListener("click", () => retryCheckpoint());
  elements.alert.append(text, document.createTextNode(" "), retry);
}

function appendPlayerAction(action, animate = true) {
  const node = elements.playerTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector("p").textContent = action;
  if (!animate) node.style.animation = "none";
  elements.story.append(node);
  return node;
}

function appendNarrativeCard(tick, narrative, status, generating) {
  const card = elements.narrativeTemplate.content.firstElementChild.cloneNode(true);
  card.querySelector(".turn-label").textContent = `回合 ${tick}`;
  card.querySelector(".card-status").textContent = status;
  card.querySelector(".narrative-text").textContent = narrative;
  card.classList.toggle("generating", generating);
  elements.story.append(card);
  return card;
}

function appendNarrativeDelta(card, text) {
  if (!text) return;
  card.querySelector(".narrative-text").append(document.createTextNode(text));
}

function renderChoices(choices) {
  elements.choices.replaceChildren();
  for (const [index, choice] of (choices || []).entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice-button";
    button.disabled = game.busy;
    const label = document.createElement("strong");
    label.textContent = `${index + 1}. ${choice.label}`;
    const intent = document.createElement("small");
    intent.textContent = choice.intent;
    button.append(label, intent);
    button.addEventListener("click", () => submitAction(choice.label));
    elements.choices.append(button);
  }
}

function setBusy(value, status) {
  game.busy = value;
  elements.sendButton.disabled = value || !game.state;
  elements.actionInput.disabled = value || !game.state;
  elements.refreshButton.disabled = value;
  elements.style.disabled = value;
  elements.length.disabled = value;
  elements.turnStatus.textContent = status;
  for (const button of elements.choices.querySelectorAll("button")) button.disabled = value;
}

async function readEventStream(stream, handler) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replaceAll("\r\n", "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const packet = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = packet.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
      const raw = packet.split("\n").filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      if (!raw) continue;
      await handler(event, JSON.parse(raw));
    }
    if (done) break;
  }
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

async function responseError(response) {
  const payload = await response.json().catch(() => ({}));
  const error = new Error(payload.error || `請求失敗（${response.status}）`);
  error.status = response.status;
  error.details = payload.details;
  return error;
}

function showAlert(message, error) {
  elements.alert.replaceChildren(document.createTextNode(message));
  elements.alert.hidden = false;
  elements.alert.classList.toggle("error", Boolean(error));
}

function hideAlert() {
  elements.alert.hidden = true;
  elements.alert.classList.remove("error");
  elements.alert.replaceChildren();
}

function historyForCurrentWorld() {
  if (!game.state) return [];
  return readStorage(`${STORAGE.historyPrefix}${game.state.worldId}`) || [];
}

function appendHistory(turn) {
  if (!game.state) return;
  const key = `${STORAGE.historyPrefix}${game.state.worldId}`;
  const history = readStorage(key) || [];
  if (history.some((item) => item.actionKey === turn.actionKey)) return;
  writeStorage(key, [...history, turn].slice(-24));
}

function applyStoredSettings() {
  const settings = readStorage(STORAGE.settings) || {};
  if ([...elements.style.options].some((option) => option.value === settings.style)) elements.style.value = settings.style;
  if ([...elements.length.options].some((option) => option.value === settings.length)) elements.length.value = settings.length;
}

function saveSettings() {
  writeStorage(STORAGE.settings, { style: elements.style.value, length: elements.length.value });
}

function readStorage(key) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The authoritative save is server-side; local history is optional.
  }
}

function updateConnection() {
  const online = navigator.onLine;
  elements.connectionDot.classList.toggle("online", online);
  elements.connectionDot.classList.toggle("offline", !online);
  elements.connectionLabel.textContent = online ? "已連線" : "離線模式";
}

function showOfflineSnapshot() {
  if (navigator.onLine || readStorage(STORAGE.locked) === true) return false;
  const cached = readStorage(STORAGE.state);
  if (!cached?.state?.worldId) return false;
  game.state = cached.state;
  game.choices = Array.isArray(cached.choices) ? cached.choices : [];
  renderWorldState();
  renderStoryFromStorage();
  setBusy(true, "離線閱讀");
  elements.saveState.textContent = "離線快照";
  showAlert("目前離線；你仍可閱讀最近內容，重新連線後才能推進世界。", false);
  return true;
}

function cacheCurrentState() {
  if (!game.state) return;
  writeStorage(STORAGE.state, { state: game.state, choices: game.choices, cachedAt: Date.now() });
}

async function installApp() {
  if (!game.installPrompt) return;
  await game.installPrompt.prompt();
  await game.installPrompt.userChoice;
  game.installPrompt = null;
  elements.installButton.hidden = true;
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => undefined));
  }
}
