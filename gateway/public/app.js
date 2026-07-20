const STORAGE = Object.freeze({
  settings: "xuanche:pwa:settings:v1",
  draft: "xuanche:pwa:draft:v1",
  pending: "xuanche:pwa:pending:v1",
  state: "xuanche:pwa:state:v1",
  locked: "xuanche:pwa:locked:v1",
  worldOperation: "xuanche:pwa:world-operation:v1",
  historyPrefix: "xuanche:pwa:history:v1:",
});
const LEGACY_DEFAULT_PROTAGONIST = "楚凌霄";

const elements = {
  connectionDot: document.querySelector("#connection-dot"),
  connectionLabel: document.querySelector("#connection-label"),
  tickBadge: document.querySelector("#tick-badge"),
  handbookButton: document.querySelector("#handbook-button"),
  handbookOpeners: document.querySelectorAll("[data-open-handbook]"),
  characterQuickRail: document.querySelector("#character-quick-rail"),
  quickProfileName: document.querySelector("#quick-profile-name"),
  quickProfileAge: document.querySelector("#quick-profile-age"),
  quickPlayerSync: document.querySelector("#quick-player-sync"),
  quickStateCultivation: document.querySelector("#quick-state-cultivation"),
  quickStateBody: document.querySelector("#quick-state-body"),
  quickStateLocation: document.querySelector("#quick-state-location"),
  quickStateConstraints: document.querySelector("#quick-state-constraints"),
  quickStateEquipment: document.querySelector("#quick-state-equipment"),
  quickStateAbilities: document.querySelector("#quick-state-abilities"),
  quickMainline: document.querySelector("#quick-mainline"),
  quickTick: document.querySelector("#quick-tick"),
  quickRevision: document.querySelector("#quick-revision"),
  playerPanel: document.querySelector("#player-panel"),
  mainline: document.querySelector("#mainline"),
  worldId: document.querySelector("#world-id"),
  revision: document.querySelector("#revision"),
  saveState: document.querySelector("#save-state"),
  protagonistPortrait: document.querySelector("#protagonist-portrait"),
  portraitPlaceholder: document.querySelector("#portrait-placeholder"),
  profileName: document.querySelector("#profile-name"),
  profileAge: document.querySelector("#profile-age"),
  profileIntro: document.querySelector("#profile-intro"),
  profileMotto: document.querySelector("#profile-motto"),
  playerStateSync: document.querySelector("#player-state-sync"),
  stateCultivation: document.querySelector("#state-cultivation"),
  stateBody: document.querySelector("#state-body"),
  stateEquipment: document.querySelector("#state-equipment"),
  stateLocation: document.querySelector("#state-location"),
  stateConstraints: document.querySelector("#state-constraints"),
  stateAbilities: document.querySelector("#state-abilities"),
  style: document.querySelector("#style-select"),
  length: document.querySelector("#length-select"),
  story: document.querySelector("#story"),
  playPanel: document.querySelector(".play-panel"),
  decisionArea: document.querySelector("#decision-area"),
  choices: document.querySelector("#choices"),
  turnStatus: document.querySelector("#turn-status"),
  actionForm: document.querySelector("#action-form"),
  actionInput: document.querySelector("#action-input"),
  sendButton: document.querySelector("#send-button"),
  alert: document.querySelector("#alert"),
  refreshButton: document.querySelector("#refresh-button"),
  logoutButton: document.querySelector("#logout-button"),
  installButton: document.querySelector("#install-button"),
  continueGameButton: document.querySelector("#continue-game-button"),
  newGameButton: document.querySelector("#new-game-button"),
  restartGameButton: document.querySelector("#restart-game-button"),
  resetWorldButton: document.querySelector("#reset-world-button"),
  worldControlStatus: document.querySelector("#world-control-status"),
  operationDialog: document.querySelector("#world-operation-dialog"),
  operationForm: document.querySelector("#world-operation-form"),
  operationTitle: document.querySelector("#operation-title"),
  operationDescription: document.querySelector("#operation-description"),
  operationWorldId: document.querySelector("#operation-world-id"),
  operationConfirmationField: document.querySelector("#operation-confirmation-field"),
  operationConfirmationLabel: document.querySelector("#operation-confirmation-label"),
  operationConfirmation: document.querySelector("#operation-confirmation"),
  operationProgress: document.querySelector("#operation-progress"),
  operationCancelButton: document.querySelector("#operation-cancel-button"),
  operationConfirmButton: document.querySelector("#operation-confirm-button"),
  characterDialog: document.querySelector("#character-dialog"),
  characterForm: document.querySelector("#character-form"),
  characterError: document.querySelector("#character-error"),
  characterCancelButton: document.querySelector("#character-cancel-button"),
  characterSubmitButton: document.querySelector("#character-submit-button"),
  characterPresets: document.querySelectorAll("[data-character-target]"),
  handbookDialog: document.querySelector("#handbook-dialog"),
  handbookCloseButton: document.querySelector("#handbook-close-button"),
  handbookTabs: document.querySelector(".handbook-tabs"),
  handbookPanels: document.querySelectorAll("[id^='handbook-panel-']"),
  handbookEquipment: document.querySelector("#handbook-equipment"),
  handbookAbilities: document.querySelector("#handbook-abilities"),
  handbookPeople: document.querySelector("#handbook-people"),
  handbookClues: document.querySelector("#handbook-clues"),
  handbookJourney: document.querySelector("#handbook-journey"),
  mobileNav: document.querySelector("#mobile-nav"),
  loginDialog: document.querySelector("#login-dialog"),
  loginForm: document.querySelector("#login-form"),
  passphrase: document.querySelector("#passphrase"),
  loginError: document.querySelector("#login-error"),
  narrativeTemplate: document.querySelector("#narrative-template"),
  playerTemplate: document.querySelector("#player-template"),
  turnChangeTemplate: document.querySelector("#turn-change-template"),
};

const game = {
  state: null,
  choices: [],
  busy: true,
  installPrompt: null,
  currentCard: null,
  checkpoint: readStorage(STORAGE.pending),
  worldOperation: readStorage(STORAGE.worldOperation),
  operationCandidate: null,
  activeHandbookTab: "inventory",
  handbookDirty: true,
  draftTimer: null,
  initialNavigationComplete: false,
};

const PLAYER_STATE_PRESENTATION = Object.freeze([
  ["cultivation", "修為"],
  ["body", "身體"],
  ["equipment", "裝備"],
  ["location", "位置"],
  ["constraints", "限制"],
  ["abilities", "能力"],
]);

applyStoredSettings();
restoreActionDraft();
if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
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
    hydrateCachedState();
    await loadWorld();
    await resumeWorldOperation();
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
  elements.actionInput.addEventListener("input", () => {
    resizeActionInput();
    scheduleActionDraftSave();
  });
  window.addEventListener("resize", resizeActionInput);
  elements.style.addEventListener("change", saveSettings);
  elements.length.addEventListener("change", saveSettings);
  elements.refreshButton.addEventListener("click", () => loadWorld({ refresh: true }));
  elements.continueGameButton.addEventListener("click", continueGame);
  elements.newGameButton.addEventListener("click", () => requestWorldOperation("new_game"));
  elements.restartGameButton.addEventListener("click", () => requestWorldOperation("restart_game"));
  elements.resetWorldButton.addEventListener("click", () => requestWorldOperation("reset_world"));
  elements.handbookButton.addEventListener("click", () => openHandbook());
  for (const button of elements.handbookOpeners) {
    button.addEventListener("click", () => openHandbook(button.dataset.openHandbook));
  }
  elements.handbookCloseButton.addEventListener("click", closeHandbook);
  elements.handbookDialog.addEventListener("cancel", closeHandbook);
  elements.handbookDialog.addEventListener("click", (event) => {
    if (event.target === elements.handbookDialog) closeHandbook();
  });
  elements.handbookTabs.addEventListener("click", selectHandbookTabFromEvent);
  elements.handbookTabs.addEventListener("keydown", navigateHandbookTabs);
  elements.mobileNav.addEventListener("click", navigateMobileSurface);
  elements.installButton.addEventListener("click", installApp);
  elements.logoutButton.addEventListener("click", logout);
  elements.loginDialog.addEventListener("cancel", (event) => event.preventDefault());
  elements.loginForm.addEventListener("submit", login);
  elements.operationDialog.addEventListener("cancel", cancelWorldOperationDialog);
  elements.operationForm.addEventListener("submit", confirmWorldOperation);
  elements.operationConfirmation.addEventListener("input", updateOperationConfirmation);
  elements.operationCancelButton.addEventListener("click", cancelWorldOperationDialog);
  elements.characterDialog.addEventListener("cancel", cancelCharacterCreation);
  elements.characterForm.addEventListener("submit", submitCharacterCreation);
  elements.characterCancelButton.addEventListener("click", cancelCharacterCreation);
  for (const preset of elements.characterPresets) preset.addEventListener("change", applyCharacterPreset);
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
    closeAppDialog(elements.loginDialog);
    hydrateCachedState();
    await loadWorld();
    await resumeWorldOperation();
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
  game.initialNavigationComplete = false;
  writeStorage(STORAGE.locked, true);
  setBusy(true, "已鎖定");
  openLogin();
}

async function continueGame() {
  if (game.busy || !isPlayableWorld()) return;
  await loadWorld({ refresh: true });
  if (game.busy || !game.state) return;
  document.querySelector("#decision-area")?.scrollIntoView({ behavior: "auto", block: "end" });
  requestAnimationFrame(() => elements.actionInput.focus({ preventScroll: true }));
}

function openHandbook(tab = game.activeHandbookTab) {
  if (game.handbookDirty) renderHandbook();
  selectHandbookTab(tab, { focus: false });
  openAppDialog(elements.handbookDialog);
}

function closeHandbook(event) {
  event?.preventDefault();
  closeAppDialog(elements.handbookDialog);
}

function openAppDialog(dialog) {
  if (!dialog || dialog.open) return;
  dialog.classList.remove("dialog-fallback");
  try {
    if (typeof dialog.showModal !== "function") throw new TypeError("此裝置不支援原生確認視窗");
    dialog.showModal();
  } catch {
    dialog.setAttribute("open", "");
    dialog.classList.add("dialog-fallback");
  }
  requestAnimationFrame(() => {
    dialog.scrollTop = 0;
    const form = dialog.querySelector("form");
    if (form) form.scrollTop = 0;
  });
}

function closeAppDialog(dialog) {
  if (!dialog?.open) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
  dialog.classList.remove("dialog-fallback");
}

function selectHandbookTabFromEvent(event) {
  const tab = event.target.closest("[data-handbook-tab]");
  if (tab) selectHandbookTab(tab.dataset.handbookTab);
}

function navigateHandbookTabs(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...elements.handbookTabs.querySelectorAll("[data-handbook-tab]")];
  const current = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
  let next = current;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.length - 1;
  else if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
  else next = (current - 1 + tabs.length) % tabs.length;
  event.preventDefault();
  selectHandbookTab(tabs[next].dataset.handbookTab);
}

function selectHandbookTab(name, { focus = true } = {}) {
  const selected = elements.handbookTabs.querySelector(`[data-handbook-tab="${name}"]`)
    || elements.handbookTabs.querySelector("[data-handbook-tab]");
  if (!selected) return;
  game.activeHandbookTab = selected.dataset.handbookTab;
  for (const tab of elements.handbookTabs.querySelectorAll("[data-handbook-tab]")) {
    const active = tab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of elements.handbookPanels) {
    panel.hidden = panel.id !== `handbook-panel-${game.activeHandbookTab}`;
  }
  if (focus) selected.focus();
}

function navigateMobileSurface(event) {
  const button = event.target.closest("[data-mobile-target]");
  if (!button) return;
  const target = button.dataset.mobileTarget;
  if (target === "handbook") {
    openHandbook();
    return;
  }
  const destination = target === "story"
    ? currentTurnTarget()
    : target === "player"
      ? elements.playerPanel
      : document.querySelector("#decision-area");
  destination?.scrollIntoView({ behavior: "auto", block: "start" });
  if (target === "action") requestAnimationFrame(() => elements.actionInput.focus({ preventScroll: true }));
}

function openLogin(configuration) {
  if (configuration && !configuration.passphrase) {
    elements.loginError.textContent = "部署端尚未設定私人登入。";
  }
  openAppDialog(elements.loginDialog);
  setTimeout(() => elements.passphrase.focus(), 50);
}

const WORLD_OPERATION_COPY = Object.freeze({
  new_game: {
    title: "封存目前世界並建立新遊戲",
    description: "目前世界會先完整封存並驗證，之後才清空固定頁面並開啟角色建立。舊進度不會成為新世界事實。",
    phrase: "建立新遊戲",
    confirm: "封存後建立角色",
  },
  restart_game: {
    title: "保留主角設定並重新遊戲",
    description: "目前世界會先完整封存；接著保留主角姓名、形象與核心性格，清除事件進度，從序章重新開始。",
    phrase: "重新開始",
    confirm: "封存後重開序章",
  },
  reset_world: {
    title: "封存並重置世界",
    description: "目前世界會先完整封存並驗證，之後清空為 EMPTY／PENDING。系統不會自動建立新角色或新劇情。",
    phrase: "重置世界",
    confirm: "封存並清空",
  },
});

function requestWorldOperation(mode) {
  clearWorldControlMessage();
  if (game.busy) {
    const activity = elements.turnStatus.textContent || "處理目前工作";
    reportWorldControlIssue(`目前正在「${activity}」；完成後即可管理世界。`);
    return;
  }
  if (game.checkpoint) {
    const message = "仍有一筆待補存回合；請先完成或核對該回合，再管理世界。";
    reportWorldControlIssue(message);
    showAlert(message, false);
    return;
  }
  if (game.worldOperation) {
    void resumeWorldOperation().catch((error) => reportWorldControlIssue(error.message, true));
    return;
  }
  try {
    if (mode === "new_game" && !isPlayableWorld()) {
      const operation = createWorldOperation(mode, { phase: "character_creation" });
      if (!persistWorldOperation(operation)) {
        const message = "瀏覽器無法保存世界操作檢查點；為避免無法續跑，這次沒有建立世界。";
        reportWorldControlIssue(message, true);
        showAlert(message, true);
        return;
      }
      clearActionDraft();
      openCharacterCreation(operation);
      return;
    }
    if (!isPlayableWorld()) {
      const message = "目前是空白世界；請使用「新的遊戲」建立角色。";
      reportWorldControlIssue(message);
      showAlert(message, false);
      return;
    }
    const operation = createWorldOperation(mode, {
      phase: "confirm",
      expectedWorldId: game.state.worldId,
      restartDraft: mode === "restart_game" ? buildRestartDraft() : undefined,
    });
    game.operationCandidate = operation;
    openWorldOperationDialog(operation);
  } catch (error) {
    const message = `確認視窗無法開啟：${error.message || "請關閉其他視窗後再試。"}`;
    reportWorldControlIssue(message, true);
    showAlert(message, true);
  }
}

function createWorldOperation(mode, overrides = {}) {
  return {
    version: 1,
    mode,
    operationKey: `pwa-world-${createUuid()}`,
    saveKey: `pwa-${mode}-${Date.now()}-${createUuid()}`,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function openWorldOperationDialog(operation, { retry = false } = {}) {
  const copy = WORLD_OPERATION_COPY[operation.mode];
  if (!copy) return;
  game.operationCandidate = operation;
  setOperationConfirmationVisible(true);
  elements.operationTitle.textContent = copy.title;
  elements.operationDescription.textContent = copy.description;
  elements.operationWorldId.textContent = operation.expectedWorldId || "EMPTY／PENDING";
  elements.operationConfirmationLabel.textContent = copy.phrase;
  elements.operationConfirmation.value = "";
  elements.operationConfirmation.disabled = false;
  elements.operationConfirmButton.hidden = false;
  elements.operationConfirmButton.textContent = retry ? "以同一識別碼重試" : copy.confirm;
  elements.operationConfirmButton.disabled = true;
  elements.operationCancelButton.hidden = false;
  elements.operationCancelButton.disabled = Boolean(game.worldOperation);
  elements.operationProgress.hidden = !retry;
  elements.operationProgress.classList.toggle("error", retry);
  elements.operationProgress.textContent = retry
    ? "上次請求尚未完成。重新確認後會使用同一操作識別碼續跑，不會建立第二份封存。"
    : "";
  openAppDialog(elements.operationDialog);
  clearWorldControlMessage();
  setTimeout(() => elements.operationConfirmation.focus(), 50);
}

function setOperationConfirmationVisible(visible) {
  if (elements.operationConfirmationField) elements.operationConfirmationField.hidden = !visible;
  elements.operationConfirmation.hidden = !visible;
}

function updateOperationConfirmation() {
  const operation = game.operationCandidate || game.worldOperation;
  const phrase = WORLD_OPERATION_COPY[operation?.mode]?.phrase;
  elements.operationConfirmButton.disabled = !phrase || elements.operationConfirmation.value.trim() !== phrase;
}

async function confirmWorldOperation(event) {
  event.preventDefault();
  const operation = game.operationCandidate || game.worldOperation;
  if (!operation || game.busy) return;
  if (operation.phase === "initialize") {
    await initializeWorldFromOperation(operation);
    return;
  }
  const phrase = WORLD_OPERATION_COPY[operation.mode]?.phrase;
  if (!phrase || elements.operationConfirmation.value.trim() !== phrase) return;
  const previousPhase = operation.phase;
  operation.phase = "archive";
  operation.started = true;
  if (!persistWorldOperation(operation)) {
    operation.phase = previousPhase;
    operation.started = false;
    setOperationProgress("瀏覽器無法保存可恢復檢查點；為保護目前世界，封存請求沒有送出。", true);
    return;
  }
  await startAndMonitorArchive(operation);
}

function cancelWorldOperationDialog(event) {
  event?.preventDefault?.();
  if (game.busy || game.worldOperation) return;
  game.operationCandidate = null;
  closeAppDialog(elements.operationDialog);
}

async function startAndMonitorArchive(operation) {
  setBusy(true, "封存世界中");
  setOperationProgress("正在建立可恢復的封存工作流程……");
  elements.operationCancelButton.disabled = true;
  elements.operationConfirmation.disabled = true;
  elements.operationConfirmButton.disabled = true;
  let status;
  try {
    const payload = await apiJson("/api/game/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: operation.mode,
        expectedWorldId: operation.expectedWorldId,
        operationKey: operation.operationKey,
        typedConfirmation: WORLD_OPERATION_COPY[operation.mode].phrase,
      }),
    });
    status = payload.status;
  } catch (startError) {
    try {
      const payload = await readArchiveStatus(operation);
      status = payload.status;
    } catch (statusError) {
      showArchiveRetry(operation, statusError.status === 404 ? startError : statusError);
      return;
    }
  }
  try {
    await monitorArchive(operation, status);
  } catch (error) {
    showArchiveRetry(operation, error);
  }
}

async function monitorArchive(operation, initialStatus) {
  let status = initialStatus;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (status?.reset === true && status?.worldState === "EMPTY") {
      await finishArchivedOperation(operation);
      return;
    }
    if (["errored", "terminated", "canceled", "cancelled"].includes(status?.workflowStatus)) {
      throw new Error(status.error || "封存工作流程中斷；可使用同一識別碼安全續跑。");
    }
    setOperationProgress(archiveStatusText(status));
    await delay(attempt < 5 ? 1_000 : 2_000);
    const payload = await readArchiveStatus(operation);
    status = payload.status;
  }
  throw new Error("封存仍在背景執行。保留本頁或重新載入後，系統會以同一識別碼繼續核對。");
}

function archiveStatusText(status = {}) {
  if (status.reset) return "封存已驗證，固定世界頁面已安全清空。";
  if (status.archiveVerified) return "封存逐頁驗證完成，正在清空固定世界頁面……";
  if (status.workflowStatus === "queued") return "封存工作已排入佇列，尚未改動目前世界……";
  if (status.workflowStatus === "waiting") return "封存正在等待上游服務，檢查點已保留……";
  return "正在逐頁封存並驗證目前世界；尚未驗證完成前不會清空……";
}

function readArchiveStatus(operation) {
  const query = new URLSearchParams({
    mode: operation.mode,
    expectedWorldId: operation.expectedWorldId,
    operationKey: operation.operationKey,
  });
  return apiJson(`/api/game/archive/status?${query}`);
}

function setOperationProgress(message, error = false) {
  elements.operationProgress.hidden = false;
  elements.operationProgress.textContent = message;
  elements.operationProgress.classList.toggle("error", error);
}

function showArchiveRetry(operation, error) {
  setBusy(false, "封存待續");
  setOperationProgress(error.message, true);
  game.operationCandidate = operation;
  setOperationConfirmationVisible(true);
  elements.operationConfirmation.disabled = false;
  elements.operationConfirmation.value = "";
  elements.operationConfirmButton.hidden = false;
  elements.operationConfirmButton.textContent = "以同一識別碼重試";
  elements.operationConfirmButton.disabled = true;
  elements.operationCancelButton.disabled = true;
  openAppDialog(elements.operationDialog);
  setTimeout(() => elements.operationConfirmation.focus(), 50);
}

async function finishArchivedOperation(operation) {
  const nextPhase = operation.mode === "new_game" ? "character_creation" :
    operation.mode === "restart_game" ? "initialize" : "complete";
  operation.phase = nextPhase;
  if (!persistWorldOperation(operation)) {
    operation.phase = "archive";
    throw new Error("封存已完成，但瀏覽器無法更新本機檢查點；請釋放網站儲存空間後以同一操作續查。");
  }
  game.choices = [];
  game.state = emptyWorldState();
  game.checkpoint = null;
  clearActionDraft();
  localStorage.removeItem(STORAGE.pending);
  localStorage.removeItem(STORAGE.state);
  renderWorldState();
  renderStoryFromStorage();
  setOperationProgress("封存與驗證完成；正在核對 EMPTY／PENDING 狀態……");
  await loadWorld({ refresh: true });

  if (operation.mode === "reset_world") {
    clearWorldOperation();
    closeAppDialog(elements.operationDialog);
    setBusy(false, "等待建立新遊戲");
    showAlert("目前世界已完整封存，固定世界頁面已重置為 EMPTY／PENDING；未自動建立新世界。", false);
    return;
  }
  if (operation.mode === "new_game") {
    closeAppDialog(elements.operationDialog);
    setBusy(false, "等待角色建立");
    openCharacterCreation(operation);
    return;
  }
  await initializeWorldFromOperation(operation);
}

function openCharacterCreation(operation) {
  if (isPlayableWorld()) {
    showAlert("目前仍有 ACTIVE 世界，不能略過封存直接建立新角色。", true);
    return;
  }
  game.worldOperation = operation;
  elements.characterError.textContent = "";
  elements.characterSubmitButton.disabled = false;
  elements.characterCancelButton.disabled = false;
  openAppDialog(elements.characterDialog);
  setTimeout(() => elements.characterForm.elements.namedItem("name")?.focus(), 50);
  updateWorldControlState();
}

function applyCharacterPreset(event) {
  const preset = event.currentTarget;
  const target = elements.characterForm.elements.namedItem(preset.dataset.characterTarget);
  if (!target || !preset.value) return;
  target.value = preset.value;
  target.focus({ preventScroll: true });
}

function cancelCharacterCreation(event) {
  event?.preventDefault?.();
  if (game.busy || game.worldOperation?.phase !== "character_creation") return;
  closeAppDialog(elements.characterDialog);
  clearWorldOperation();
  showAlert("未建立新角色；世界維持 EMPTY／PENDING。已封存的舊世界不受影響。", false);
  setBusy(false, "等待建立新遊戲");
}

async function submitCharacterCreation(event) {
  event.preventDefault();
  if (game.busy || !elements.characterForm.reportValidity()) return;
  const form = new FormData(elements.characterForm);
  const operation = game.worldOperation || createWorldOperation("new_game", { phase: "character_creation" });
  operation.phase = "initialize";
  operation.character = {
    name: formText(form, "name"),
    gender: formText(form, "gender"),
    age: formText(form, "age"),
    appearance: formText(form, "appearance"),
    personality: splitList(formText(form, "personality")),
    background: formText(form, "background"),
    motivation: formText(form, "motivation") || "守護珍視之人並踏上修行之路",
    bottomLine: formText(form, "bottomLine") || "不主動傷害無辜，不背棄珍視之人",
    equipment: formText(form, "equipment") || "隨身衣物",
    cultivation: "凡人，尚未引氣入體",
    body: "健康",
    constraints: "無",
  };
  operation.opening = {
    location: formText(form, "location") || "山村外圍",
    time: formText(form, "time") || "清晨",
    premise: formText(form, "premise") || "一場尚未發生的異變，即將把主角推向修行之路。",
    knownAbilities: splitList(formText(form, "knownAbilities")),
    knownWorldFacts: ["修行者與凡人的世界彼此交疊，但規則尚待親自理解"],
    promises: [],
    visibleClue: "遠處出現一絲不尋常的動靜",
    choices: ["先觀察四周", "確認隨身物品", "向最近的人打聽消息"],
  };
  if (!persistWorldOperation(operation)) {
    operation.phase = "character_creation";
    elements.characterError.textContent = "瀏覽器無法保存角色建立檢查點；為避免半成品，新世界尚未建立。";
    return;
  }
  await initializeWorldFromOperation(operation);
}

async function initializeWorldFromOperation(operation) {
  if (!operation.character || !operation.opening) {
    if (operation.mode === "restart_game" && operation.restartDraft) {
      operation.character = operation.restartDraft.character;
      operation.opening = operation.restartDraft.opening;
      if (!persistWorldOperation(operation)) {
        showInitializationRetry(operation, new Error("瀏覽器無法保存序章初始化檢查點。"));
        return;
      }
    } else {
      operation.phase = "character_creation";
      if (!persistWorldOperation(operation)) {
        showAlert("瀏覽器無法保存角色建立檢查點。", true);
        return;
      }
      openCharacterCreation(operation);
      return;
    }
  }
  setBusy(true, "建立新世界中");
  if (operation.mode === "restart_game" || !elements.characterDialog.open) showInitializationProgress(operation);
  elements.characterSubmitButton.disabled = true;
  elements.characterCancelButton.disabled = true;
  elements.characterError.textContent = "";
  try {
    await apiJson("/api/game/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: operation.mode,
        saveKey: operation.saveKey,
        character: operation.character,
        opening: operation.opening,
      }),
    });
    clearWorldOperation();
    game.choices = [];
    localStorage.removeItem(STORAGE.state);
    closeAppDialog(elements.characterDialog);
    closeAppDialog(elements.operationDialog);
    await loadWorld({ refresh: true, navigateToCurrent: true });
    showAlert(operation.mode === "restart_game"
      ? "舊世界已封存；主角設定已保留，序章世界建立完成。"
      : "新角色與新世界已建立完成。", false);
  } catch (error) {
    setBusy(false, "建立世界待續");
    if (operation.mode === "new_game" && elements.characterDialog.open) {
      elements.characterError.textContent = `${error.message}（將使用同一存檔鍵重試）`;
      elements.characterSubmitButton.disabled = false;
      elements.characterCancelButton.disabled = true;
    } else {
      showInitializationRetry(operation, error);
    }
  }
}

function showInitializationProgress(operation) {
  const copy = WORLD_OPERATION_COPY[operation.mode];
  game.operationCandidate = operation;
  elements.operationTitle.textContent = operation.mode === "restart_game" ? "封存完成，正在重建序章" : "正在建立新世界";
  elements.operationDescription.textContent = operation.mode === "restart_game"
    ? "固定頁面已驗證為 EMPTY／PENDING；現在以保留的主角設定建立全新序章。"
    : "固定頁面已確認為 EMPTY／PENDING；現在以剛確認的角色設定建立新世界。";
  elements.operationWorldId.textContent = operation.expectedWorldId || "EMPTY／PENDING";
  setOperationConfirmationVisible(false);
  elements.operationConfirmButton.hidden = true;
  elements.operationCancelButton.hidden = true;
  setOperationProgress("正在寫入新世界；權威存檔會在所有固定頁面準備完成後才啟用……");
  openAppDialog(elements.operationDialog);
  elements.operationConfirmButton.textContent = copy.confirm;
}

function showInitializationRetry(operation, error) {
  game.operationCandidate = operation;
  setOperationProgress(`${error.message}（將使用同一存檔鍵重試）`, true);
  setOperationConfirmationVisible(false);
  elements.operationConfirmButton.hidden = false;
  elements.operationConfirmButton.disabled = false;
  elements.operationConfirmButton.textContent = operation.mode === "restart_game" ? "重試建立序章" : "重試建立世界";
  elements.operationCancelButton.hidden = true;
  openAppDialog(elements.operationDialog);
}

async function resumeWorldOperation() {
  const operation = game.worldOperation;
  if (!operation) return;
  if (!WORLD_OPERATION_COPY[operation.mode] || operation.version !== 1) {
    clearWorldOperation();
    return;
  }
  if (operation.phase === "character_creation") {
    if (isPlayableWorld()) {
      game.state = emptyWorldState();
      renderWorldState();
      renderStoryFromStorage();
    }
    openCharacterCreation(operation);
    return;
  }
  if (operation.phase === "initialize") {
    await initializeWorldFromOperation(operation);
    return;
  }
  if (operation.phase !== "archive") {
    clearWorldOperation();
    return;
  }
  setBusy(true, "核對封存進度");
  game.operationCandidate = operation;
  openWorldOperationDialog(operation, { retry: true });
  setOperationConfirmationVisible(false);
  elements.operationConfirmButton.hidden = true;
  elements.operationCancelButton.disabled = true;
  setOperationProgress("正在讀取既有封存工作流程，不會自動建立第二個操作……");
  try {
    const payload = await readArchiveStatus(operation);
    await monitorArchive(operation, payload.status);
  } catch (error) {
    showArchiveRetry(operation, error);
  }
}

function buildRestartDraft() {
  const profile = game.state?.profile || {};
  const name = profile.name || game.state?.playerState?.name || "主角";
  const isChu = name.includes("楚凌霄");
  return {
    character: {
      name,
      gender: "男",
      age: profile.age || "16歲",
      appearance: profile.intro || "衣著樸素，目光敏銳。",
      personality: isChu ? ["沉著", "敏銳", "重視家人", "善於觀察山勢"] : ["沉著", "敏銳"],
      background: profile.intro || "山村出身，尚未踏入修行。",
      motivation: profile.motto || "守護珍視之人並踏上修行之路",
      bottomLine: "不主動傷害無辜，不背棄珍視之人",
      equipment: isChu ? "採藥短刀、藥簍、火摺子" : "隨身衣物與簡單行囊",
      cultivation: "凡人，尚未引氣入體",
      body: "健康",
      constraints: "無",
      relationships: isChu ? ["母親與妹妹是最珍視的家人"] : [],
    },
    opening: {
      location: isChu ? "青石村外・禁山山腳" : "故鄉外圍",
      time: "清晨",
      premise: `${name}仍未踏入修行；一場尚未發生的異變，即將把其推向修真世界。`,
      knownAbilities: isChu ? ["辨識草藥", "熟悉山路", "攀爬與追蹤", "簡單傷口處理"] : ["觀察環境", "基本野外求生"],
      knownWorldFacts: ["禁地危險，凡人通常不會深入"],
      promises: isChu ? ["保護母親與妹妹"] : [],
      visibleClue: "遠處傳來一陣不尋常的動靜",
      choices: ["先查看家中狀況", "整理行囊", "觀察遠處異象"],
    },
  };
}

function persistWorldOperation(operation) {
  try {
    const serialized = JSON.stringify(operation);
    localStorage.setItem(STORAGE.worldOperation, serialized);
    const stored = JSON.parse(localStorage.getItem(STORAGE.worldOperation) || "null");
    if (stored?.operationKey !== operation.operationKey || stored?.phase !== operation.phase) return false;
    game.worldOperation = operation;
    game.operationCandidate = operation;
    updateWorldControlState();
    return true;
  } catch {
    return false;
  }
}

function clearWorldOperation() {
  game.worldOperation = null;
  game.operationCandidate = null;
  try {
    localStorage.removeItem(STORAGE.worldOperation);
  } catch {
    // The server state remains authoritative even if optional local cleanup fails.
  }
  updateWorldControlState();
}

function emptyWorldState() {
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
    loadedAt: new Date().toISOString(),
    cache: "local-transition",
  };
}

function formText(form, name) {
  return String(form.get(name) || "").trim();
}

function splitList(value) {
  return String(value || "").split(/[、,，;；\n]+/u).map((item) => item.trim()).filter(Boolean);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

async function loadWorld({ refresh = false, navigateToCurrent = !game.initialNavigationComplete } = {}) {
  setBusy(true, refresh ? "核對世界中" : "載入世界中");
  hideAlert();
  try {
    const payload = await apiJson(`/api/game/state${refresh ? "?refresh=1" : ""}`);
    game.state = payload.state;
    repairLocalProtagonistIdentity();
    game.choices = [];
    if (!isPlayableWorld() && game.checkpoint) {
      game.checkpoint = null;
      localStorage.removeItem(STORAGE.pending);
    }
    const cached = readStorage(STORAGE.state);
    if (
      cached?.state?.worldId === game.state.worldId &&
      cached.state.simTick === game.state.simTick &&
      Array.isArray(cached.choices)
    ) game.choices = cached.choices;
    cacheCurrentState();
    renderWorldState();
    renderStoryFromStorage();
    if (isPlayableWorld()) reconcilePendingCheckpoint();
    if (!payload.ready.model) showAlert("介面與世界引擎已就緒；設定 OPENAI_API_KEY 後即可生成新回合。", false);
    setBusy(false, isPlayableWorld() ? "等待你的行動" : "等待建立新遊戲");
    elements.saveState.textContent = isPlayableWorld() ? "已同步" : "空白";
    if (navigateToCurrent) {
      game.initialNavigationComplete = true;
      if (isPlayableWorld()) scheduleCurrentTurnNavigation();
    }
  } catch (error) {
    elements.saveState.textContent = "讀取失敗";
    showAlert(error.message, true);
    if (error.status === 401) openLogin();
    setBusy(true, "世界未就緒");
  }
}

function renderWorldState() {
  if (!game.state) return;
  const playable = isPlayableWorld();
  elements.tickBadge.textContent = playable ? `T${game.state.simTick}` : "T—";
  elements.worldId.textContent = game.state.worldId;
  elements.worldId.title = game.state.worldId;
  elements.revision.textContent = playable ? `R${game.state.revision}` : "R—";
  elements.mainline.textContent = game.state.mainline;
  setQuickDisplay(elements.quickMainline, game.state.mainline, "尚未建立世界");
  setQuickDisplay(elements.quickTick, playable ? `T${game.state.simTick}` : "T—");
  setQuickDisplay(elements.quickRevision, playable ? `R${game.state.revision}` : "R—");
  renderCharacterState();
  game.handbookDirty = true;
  if (elements.handbookDialog.open) renderHandbook();
  updateWorldControlState();
}

function renderCharacterState() {
  if (!isPlayableWorld()) {
    elements.profileName.textContent = "等待主角";
    elements.profileAge.textContent = "未建立";
    elements.profileIntro.textContent = "使用「新的遊戲」建立角色與開局。";
    elements.profileMotto.textContent = "";
    elements.protagonistPortrait.hidden = true;
    elements.portraitPlaceholder.hidden = false;
    elements.playerStateSync.textContent = "空白世界";
    elements.playerStateSync.classList.remove("synced");
    elements.quickPlayerSync.textContent = "空白世界";
    elements.quickPlayerSync.classList.remove("synced");
    setQuickDisplay(elements.quickProfileName, "等待主角");
    setQuickDisplay(elements.quickProfileAge, "未建立");
    for (const element of [
      elements.stateCultivation,
      elements.stateBody,
      elements.stateEquipment,
      elements.stateLocation,
      elements.stateConstraints,
      elements.stateAbilities,
    ]) element.textContent = "尚未建立";
    fitStateCards();
    for (const element of [
      elements.quickStateCultivation,
      elements.quickStateBody,
      elements.quickStateLocation,
      elements.quickStateConstraints,
      elements.quickStateEquipment,
      elements.quickStateAbilities,
    ]) setQuickDisplay(element, "尚未建立");
    return;
  }
  const profile = game.state?.profile || {};
  const playerState = game.state?.playerState || {};
  const name = profile.name || playerState.name || "主角";
  elements.profileName.textContent = name;
  elements.profileAge.textContent = profile.age || "年齡未知";
  elements.profileIntro.textContent = profile.intro || "角色資料尚未載入。";
  elements.profileMotto.textContent = profile.motto ? `「${profile.motto}」` : "";
  setQuickDisplay(elements.quickProfileName, name);
  setQuickDisplay(elements.quickProfileAge, profile.age || "年齡未知");
  elements.protagonistPortrait.hidden = !profile.portrait;
  elements.portraitPlaceholder.hidden = Boolean(profile.portrait);
  if (profile.portrait) elements.protagonistPortrait.src = profile.portrait;
  elements.protagonistPortrait.alt = profile.portrait ? `${name}立繪` : "";
  elements.actionInput.placeholder = `輸入${name}要做或要說的事……`;

  elements.playerStateSync.textContent = playerState.calibrated ? "即時同步" : "待校準";
  elements.playerStateSync.classList.toggle("synced", Boolean(playerState.calibrated));
  elements.quickPlayerSync.textContent = playerState.calibrated ? "即時同步" : "待校準";
  elements.quickPlayerSync.classList.toggle("synced", Boolean(playerState.calibrated));
  const fields = [
    [elements.stateCultivation, playerState.cultivation],
    [elements.stateBody, playerState.body],
    [elements.stateEquipment, playerState.equipment],
    [elements.stateLocation, playerState.location],
    [elements.stateConstraints, playerState.constraints],
    [elements.stateAbilities, playerState.abilities],
  ];
  for (const [element, value] of fields) element.textContent = value || "待下一回合校準";
  fitStateCards();
  const quickFields = [
    [elements.quickStateCultivation, playerState.cultivation],
    [elements.quickStateBody, playerState.body],
    [elements.quickStateLocation, playerState.location],
    [elements.quickStateConstraints, playerState.constraints],
    [elements.quickStateEquipment, playerState.equipment],
    [elements.quickStateAbilities, playerState.abilities],
  ];
  for (const [element, value] of quickFields) setQuickDisplay(element, value, "待下一回合校準");
}

function fitStateCards() {
  for (const card of elements.playerPanel.querySelectorAll(".state-list > div")) {
    const text = card.querySelector("dd")?.textContent?.trim() || "";
    const itemCount = text.split(/[、，；;\n]/u).filter(Boolean).length;
    const needsMoreRoom = Array.from(text).length > 24 || itemCount > 3;
    card.classList.toggle("state-card-wide", needsMoreRoom);
  }
}

function setQuickDisplay(element, value, fallback = "—") {
  const text = String(value || fallback);
  element.textContent = text;
  element.title = text;
}

function renderHandbook() {
  const playable = isPlayableWorld();
  const playerState = playable ? game.state?.playerState || {} : {};
  renderHandbookTokens(
    elements.handbookEquipment,
    splitDisplayItems(playerState.equipment),
    playable ? "尚未記錄可確認的裝備。" : "建立新遊戲後才會出現行囊資料。",
  );
  renderHandbookTokens(
    elements.handbookAbilities,
    splitDisplayItems(playerState.abilities),
    playable ? "尚未掌握或確認任何能力。" : "建立新遊戲後才會出現能力資料。",
  );
  renderHandbookPeople(playable);
  renderHandbookClues(playable);
  renderHandbookJourney(playable);
  game.handbookDirty = false;
}

function splitDisplayItems(value) {
  return [...new Set(String(value || "")
    .split(/[、;；\n]+/u)
    .map((item) => item.trim())
    .filter((item) => item && !["無", "未知", "尚未記錄"].includes(item)))];
}

function renderHandbookTokens(container, items, emptyText) {
  container.replaceChildren();
  if (!items.length) {
    container.append(handbookEmpty(emptyText));
    return;
  }
  for (const item of items) {
    const token = document.createElement("span");
    token.className = "handbook-token";
    token.textContent = item;
    container.append(token);
  }
}

function renderHandbookPeople(playable) {
  elements.handbookPeople.replaceChildren();
  if (!playable) {
    elements.handbookPeople.append(handbookEmpty("尚未建立人物資料。"));
    return;
  }
  const profile = game.state?.profile || {};
  const playerState = game.state?.playerState || {};
  const entry = handbookEntry(
    profile.name || playerState.name || "此世主角",
    profile.age || "年齡未知",
    [profile.intro, profile.motto ? `「${profile.motto}」` : ""].filter(Boolean),
  );
  elements.handbookPeople.append(entry, handbookEmpty("尚未有可確認的人物關係紀錄。"));
}

function renderHandbookClues(playable) {
  elements.handbookClues.replaceChildren();
  const facts = playable
    ? [...new Set(historyForCurrentWorld().flatMap((turn) => turn.committedSummary?.facts || []))].reverse()
    : [];
  if (!facts.length) {
    elements.handbookClues.append(handbookEmpty(playable ? "近期存檔尚未累積公開線索。" : "建立新遊戲後才會累積線索。"));
    return;
  }
  for (const [index, fact] of facts.entries()) {
    elements.handbookClues.append(handbookEntry(`線索 ${facts.length - index}`, "已確認", [fact]));
  }
}

function renderHandbookJourney(playable) {
  elements.handbookJourney.replaceChildren();
  const history = playable ? historyForCurrentWorld().slice().reverse() : [];
  if (!history.length) {
    elements.handbookJourney.append(handbookEmpty(playable ? "這台裝置尚未保存近期旅程。" : "建立新遊戲後才會記錄旅程。"));
    return;
  }
  for (const turn of history) {
    const summary = turn.committedSummary || {};
    const excerpt = summary.result || clampDisplayText(turn.narrative, 140);
    const entry = handbookEntry(`回合 ${turn.tick}`, "已保存", [turn.action, excerpt].filter(Boolean));
    entry.classList.add("journey-entry");
    entry.querySelector("p")?.classList.add("journey-action");
    elements.handbookJourney.append(entry);
  }
}

function handbookEntry(title, meta, paragraphs) {
  const entry = document.createElement("article");
  entry.className = "handbook-entry";
  const header = document.createElement("header");
  const heading = document.createElement("h3");
  heading.textContent = title;
  const metadata = document.createElement("span");
  metadata.className = "entry-meta";
  metadata.textContent = meta;
  header.append(heading, metadata);
  entry.append(header);
  for (const text of paragraphs) {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    entry.append(paragraph);
  }
  return entry;
}

function handbookEmpty(message) {
  const empty = document.createElement("p");
  empty.className = "handbook-empty";
  empty.textContent = message;
  return empty;
}

function clampDisplayText(value, maximum) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function renderStoryFromStorage() {
  const fragment = document.createDocumentFragment();
  if (!isPlayableWorld()) {
    const card = appendNarrativeCard(0, "固定世界頁面目前為 EMPTY／PENDING。舊世界若已執行封存，仍保存在世界封存庫；此處不會自動建立或覆寫新世界。", "等待建立", false, fragment);
    card.querySelector(".turn-label").textContent = "空白世界";
    card.classList.remove("generating");
    elements.story.replaceChildren(fragment);
    renderChoices([]);
    return;
  }
  const history = historyForCurrentWorld();
  for (const turn of history) {
    appendPlayerAction(turn.action, false, fragment);
    const card = appendNarrativeCard(turn.tick, turn.narrative, "已保存", false, fragment);
    card.classList.remove("generating");
    appendTurnChangeCard(turn.committedSummary, false, fragment);
  }
  const lastTick = history.at(-1)?.tick;
  if (!history.length || lastTick !== game.state.simTick) {
    const card = appendNarrativeCard(
      game.state.simTick,
      [game.state.mainline, game.state.situation].filter(Boolean).join("\n\n"),
      "世界錨點",
      false,
      fragment,
    );
    card.classList.remove("generating");
  }
  elements.story.replaceChildren(fragment);
  renderChoices(game.choices);
}

function scheduleCurrentTurnNavigation() {
  const target = currentTurnTarget();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    target.scrollIntoView({ behavior: "auto", block: "start" });
  }));
}

function currentTurnTarget() {
  const currentTurns = elements.story.querySelectorAll(".narrative-card");
  return currentTurns.item(currentTurns.length - 1) || elements.decisionArea;
}

async function submitAction(action) {
  if (game.busy || !isPlayableWorld()) return;
  if (game.checkpoint) {
    showAlert("上一回合仍有待確認的存檔，請先補存後再行動。", false);
    return;
  }
  hideAlert();
  const baseState = { ...game.state };
  const actionKey = crypto.randomUUID();
  persistActionDraft(action);
  elements.actionInput.value = "";
  resizeActionInput();
  renderChoices([]);
  appendPlayerAction(action);
  const card = appendNarrativeCard(baseState.simTick + 1, "", "推演中", true);
  game.currentCard = card;
  const narrativeWriter = createNarrativeWriter(card);
  setBusy(true, "世界推演中");
  elements.saveState.textContent = "尚未提交";
  card.scrollIntoView({ behavior: "auto", block: "center" });

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
        if (data.text && card.querySelector(".card-status").textContent === "推演中") {
          card.querySelector(".card-status").textContent = "敘事生成中";
          elements.turnStatus.textContent = "敘事生成中";
        }
        narrativeWriter.push(data.text || "");
      } else if (event === "checkpoint") {
        narrativeWriter.flush();
        game.checkpoint = data.checkpoint;
        writeStorage(STORAGE.pending, game.checkpoint);
        clearActionDraft(action);
        card.querySelector(".card-status").textContent = "敘事完成 · 存檔中";
        elements.turnStatus.textContent = "敘事完成，正在保存";
      } else if (event === "committed") {
        narrativeWriter.flush();
        committed = true;
        clearActionDraft(action);
        finalizeCommittedTurn(card, action, data);
      } else if (event === "save_error") {
        narrativeWriter.flush();
        markTurnUnsaved(card, data.error || "敘事已生成，但存檔尚未完成。");
      } else if (event === "error") {
        narrativeWriter.flush();
        markTurnFailed(card, data.error || "本回合生成失敗。", action);
      }
    });
    narrativeWriter.flush();
    if (!committed && !game.checkpoint && !card.classList.contains("failed")) {
      markTurnFailed(card, "連線在回合完成前中斷；世界狀態未確認變更。", action);
    }
  } catch (error) {
    narrativeWriter.flush();
    if (game.checkpoint) markTurnUnsaved(card, error.message);
    else markTurnFailed(card, error.message, action);
  } finally {
    narrativeWriter.flush();
    game.currentCard = null;
    setBusy(false, "等待你的行動");
  }
}

function finalizeCommittedTurn(card, action, data) {
  card.classList.remove("generating", "unsaved", "failed");
  card.querySelector(".card-status").textContent = `已保存 · T${data.simTick}`;
  const narrative = card.querySelector(".narrative-text");
  if (!narrative.textContent) narrative.textContent = data.narrative || "本回合已保存。";
  const previousPlayerState = game.state?.playerState || null;
  const nextPlayerState = data.playerState
    ? { ...data.playerState, calibrated: true }
    : game.state.playerState;
  const committedSummary = buildCommittedSummary(previousPlayerState, nextPlayerState, data);
  game.state = {
    ...game.state,
    worldId: data.worldId,
    simTick: data.simTick,
    revision: data.revision,
    saveKey: data.saveKey || game.state.saveKey,
    lastActionKey: data.actionKey || game.state.lastActionKey,
    mainline: data.mainline || game.state.mainline,
    situation: data.situation || game.state.situation,
    playerState: nextPlayerState,
  };
  game.choices = Array.isArray(data.choices) ? data.choices : [];
  appendTurnChangeCard(committedSummary);
  appendHistory({
    action,
    narrative: narrative.textContent,
    tick: data.simTick,
    actionKey: data.actionKey,
    committedSummary,
  });
  renderWorldState();
  renderChoices(game.choices);
  elements.saveState.textContent = "已保存";
  game.checkpoint = null;
  localStorage.removeItem(STORAGE.pending);
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

function markTurnFailed(card, message, action = "") {
  card.classList.remove("generating", "unsaved");
  card.classList.add("failed");
  card.querySelector(".card-status").textContent = "未提交";
  if (!card.querySelector(".narrative-text").textContent) {
    card.querySelector(".narrative-text").textContent = "這次推演沒有改變世界。你可以稍後再次送出行動。";
  }
  elements.saveState.textContent = "未變更";
  if (action) restoreActionDraft(action);
  showAlert(`${message} 行動草稿已保留；若連線曾中斷，請先重新核對世界再決定是否重送。`, true);
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
      summary: checkpoint.summary,
      mainline: checkpoint.mainline,
      visibleResult: checkpoint.visibleResult,
      visibleCost: checkpoint.visibleCost,
      situation: checkpoint.situation,
      choices: checkpoint.choices,
      facts: checkpoint.facts,
      playerState: payload.data.playerState || checkpoint.playerState,
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

function appendPlayerAction(action, animate = true, target = elements.story) {
  const node = elements.playerTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector("p").textContent = action;
  if (!animate) node.style.animation = "none";
  target.append(node);
  return node;
}

function appendNarrativeCard(tick, narrative, status, generating, target = elements.story) {
  const card = elements.narrativeTemplate.content.firstElementChild.cloneNode(true);
  card.querySelector(".turn-label").textContent = `回合 ${tick}`;
  card.querySelector(".card-status").textContent = status;
  card.querySelector(".narrative-text").textContent = narrative;
  card.classList.toggle("generating", generating);
  target.append(card);
  return card;
}

function appendNarrativeDelta(card, text) {
  if (!text) return;
  card.querySelector(".narrative-text").append(document.createTextNode(text));
}

function createNarrativeWriter(card) {
  let pending = "";
  let frameId = null;

  const commitPending = () => {
    frameId = null;
    if (!pending) return;
    const text = pending;
    pending = "";
    appendNarrativeDelta(card, text);
  };

  return {
    push(text) {
      if (!text) return;
      pending += text;
      if (frameId === null) frameId = requestAnimationFrame(commitPending);
    },
    flush() {
      if (frameId !== null) cancelAnimationFrame(frameId);
      commitPending();
    },
  };
}

function buildCommittedSummary(previousPlayerState, nextPlayerState, data) {
  const deltas = [];
  for (const [field, label] of PLAYER_STATE_PRESENTATION) {
    const before = String(previousPlayerState?.[field] || "").trim();
    const after = String(nextPlayerState?.[field] || "").trim();
    if (!after || before === after) continue;
    deltas.push({ label, before: before || "未記錄", after });
  }
  return {
    tick: data.simTick,
    result: String(data.visibleResult || "").trim(),
    cost: String(data.visibleCost || "").trim(),
    facts: [...new Set((Array.isArray(data.facts) ? data.facts : [])
      .map((fact) => String(fact || "").trim())
      .filter(Boolean))].slice(0, 8),
    deltas,
  };
}

function appendTurnChangeCard(summary, animate = true, target = elements.story) {
  if (!summary || (!summary.result && !summary.cost && !summary.deltas?.length && !summary.facts?.length)) return null;
  const node = elements.turnChangeTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".turn-change-tick").textContent = Number.isInteger(summary.tick) ? `T${summary.tick}` : "已保存";
  const result = node.querySelector(".turn-outcome.result");
  const cost = node.querySelector(".turn-outcome.cost");
  result.hidden = !summary.result;
  cost.hidden = !summary.cost;
  node.querySelector(".turn-outcome-grid").classList.toggle("single", !summary.result || !summary.cost);
  result.querySelector("p").textContent = summary.result || "";
  cost.querySelector("p").textContent = summary.cost || "";

  const deltaList = node.querySelector(".turn-delta-list");
  const deltas = Array.isArray(summary.deltas) ? summary.deltas : [];
  if (!deltas.length) {
    const empty = document.createElement("li");
    empty.className = "turn-delta-empty";
    empty.textContent = "本回合沒有改變已確認的主角狀態。";
    deltaList.append(empty);
  } else {
    for (const delta of deltas) {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.className = "turn-delta-label";
      label.textContent = delta.label;
      const values = document.createElement("span");
      values.className = "turn-delta-values";
      const before = document.createElement("del");
      before.textContent = delta.before;
      const arrow = document.createElement("span");
      arrow.className = "turn-delta-arrow";
      arrow.textContent = "→";
      values.append(before, arrow, document.createTextNode(delta.after));
      item.append(label, values);
      deltaList.append(item);
    }
  }

  const factsList = node.querySelector(".turn-facts-list");
  const facts = Array.isArray(summary.facts) ? summary.facts : [];
  if (!facts.length) {
    const empty = document.createElement("li");
    empty.className = "turn-facts-empty";
    empty.textContent = "本回合沒有新增可確認線索。";
    factsList.append(empty);
  } else {
    for (const fact of facts) {
      const item = document.createElement("li");
      item.textContent = fact;
      factsList.append(item);
    }
  }
  if (!animate) node.style.animation = "none";
  target.append(node);
  return node;
}

function renderChoices(choices) {
  const fragment = document.createDocumentFragment();
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
    fragment.append(button);
  }
  elements.choices.replaceChildren(fragment);
}

function setBusy(value, status) {
  game.busy = value;
  const playable = isPlayableWorld();
  elements.sendButton.disabled = value || !playable;
  elements.actionInput.disabled = value || !playable;
  elements.refreshButton.disabled = value;
  elements.style.disabled = value;
  elements.length.disabled = value;
  elements.playPanel.setAttribute("aria-busy", String(value));
  elements.decisionArea.setAttribute("aria-busy", String(value));
  elements.turnStatus.textContent = status;
  for (const button of elements.choices.querySelectorAll("button")) button.disabled = value;
  updateWorldControlState();
}

function updateWorldControlState() {
  const playable = isPlayableWorld();
  const operationLocked = Boolean(game.worldOperation && game.worldOperation.phase !== "character_creation");
  elements.continueGameButton.disabled = game.busy || !playable || operationLocked;
  elements.newGameButton.disabled = operationLocked;
  elements.restartGameButton.disabled = !playable || operationLocked;
  elements.resetWorldButton.disabled = !playable || operationLocked;
  if (operationLocked) {
    reportWorldControlIssue("前次世界操作仍在恢復或封存中；請依確認視窗完成目前操作。");
  } else if (game.busy) {
    const activity = elements.turnStatus.textContent || "處理目前工作";
    reportWorldControlIssue(`目前正在「${activity}」；完成後即可管理世界。`);
  } else {
    clearWorldControlMessage();
  }
}

function reportWorldControlIssue(message, error = false) {
  if (!elements.worldControlStatus) {
    showAlert(message, error);
    return;
  }
  elements.worldControlStatus.textContent = message;
  elements.worldControlStatus.hidden = false;
  elements.worldControlStatus.classList.toggle("error", error);
}

function clearWorldControlMessage() {
  if (!elements.worldControlStatus) return;
  elements.worldControlStatus.textContent = "";
  elements.worldControlStatus.hidden = true;
  elements.worldControlStatus.classList.remove("error");
}

function isPlayableWorld() {
  return game.state?.worldState === "ACTIVE" && game.state?.empty !== true;
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

function repairLocalProtagonistIdentity() {
  const authoritativeName = String(game.state?.profile?.name || "").trim();
  if (!authoritativeName || authoritativeName === LEGACY_DEFAULT_PROTAGONIST) return false;

  let stateChanged = false;
  for (const field of ["mainline", "situation"]) {
    const current = game.state?.[field];
    if (typeof current !== "string" || !current.includes(LEGACY_DEFAULT_PROTAGONIST)) continue;
    game.state[field] = current.replaceAll(LEGACY_DEFAULT_PROTAGONIST, authoritativeName);
    stateChanged = true;
  }
  if (game.state?.playerState?.name === LEGACY_DEFAULT_PROTAGONIST) {
    game.state.playerState = { ...game.state.playerState, name: authoritativeName };
    stateChanged = true;
  }

  const key = `${STORAGE.historyPrefix}${game.state.worldId}`;
  const history = readStorage(key);
  if (!Array.isArray(history) || !game.state.lastActionKey) return stateChanged;
  let historyChanged = false;
  const repaired = history.map((turn) => {
    if (turn?.actionKey !== game.state.lastActionKey) return turn;
    const next = replaceLegacyIdentity(turn, authoritativeName);
    if (JSON.stringify(next) !== JSON.stringify(turn)) historyChanged = true;
    return next;
  });
  if (historyChanged) writeStorage(key, repaired);
  return stateChanged || historyChanged;
}

function replaceLegacyIdentity(value, authoritativeName) {
  if (typeof value === "string") {
    return value.replaceAll(LEGACY_DEFAULT_PROTAGONIST, authoritativeName);
  }
  if (Array.isArray(value)) return value.map((item) => replaceLegacyIdentity(item, authoritativeName));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === "action" ? item : replaceLegacyIdentity(item, authoritativeName),
  ]));
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

function scheduleActionDraftSave() {
  clearTimeout(game.draftTimer);
  game.draftTimer = setTimeout(() => persistActionDraft(elements.actionInput.value), 180);
}

function persistActionDraft(value) {
  clearTimeout(game.draftTimer);
  game.draftTimer = null;
  const text = String(value || "").slice(0, 800);
  if (!text.trim()) {
    localStorage.removeItem(STORAGE.draft);
    return;
  }
  writeStorage(STORAGE.draft, { text, savedAt: Date.now() });
}

function restoreActionDraft(fallback = "") {
  const saved = readStorage(STORAGE.draft);
  const text = String(fallback || saved?.text || "").slice(0, 800);
  if (!text || elements.actionInput.value) {
    resizeActionInput();
    return;
  }
  elements.actionInput.value = text;
  persistActionDraft(text);
  resizeActionInput();
}

function clearActionDraft(action = "") {
  clearTimeout(game.draftTimer);
  game.draftTimer = null;
  const saved = readStorage(STORAGE.draft);
  if (!action || saved?.text === action) localStorage.removeItem(STORAGE.draft);
  if (!action || elements.actionInput.value === action) elements.actionInput.value = "";
  resizeActionInput();
}

function resizeActionInput() {
  const input = elements.actionInput;
  input.style.height = "auto";
  const height = Math.min(Math.max(input.scrollHeight, 88), 180);
  input.style.height = `${height}px`;
  input.style.overflowY = input.scrollHeight > 180 ? "auto" : "hidden";
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
  repairLocalProtagonistIdentity();
  game.choices = Array.isArray(cached.choices) ? cached.choices : [];
  renderWorldState();
  renderStoryFromStorage();
  game.initialNavigationComplete = true;
  if (isPlayableWorld()) scheduleCurrentTurnNavigation();
  setBusy(true, "離線閱讀");
  elements.saveState.textContent = "離線快照";
  showAlert("目前離線；你仍可閱讀最近內容，重新連線後才能推進世界。", false);
  return true;
}

function hydrateCachedState() {
  const cached = readStorage(STORAGE.state);
  if (!cached?.state?.worldId) return false;
  game.state = cached.state;
  repairLocalProtagonistIdentity();
  game.choices = Array.isArray(cached.choices) ? cached.choices : [];
  renderWorldState();
  renderStoryFromStorage();
  elements.saveState.textContent = "核對中";
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
