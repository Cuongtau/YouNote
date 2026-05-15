// YouNote popup — passive renderer. Background owns state. Popup queries
// GET_STATE on open, subscribes to BACKGROUND_STATE_UPDATE pushes, and
// dispatches user actions via runtime messages.
//
// All user-visible strings flow through chrome.i18n. Background sends
// status as i18n keys (e.g. "statusConnecting"); popup resolves to text.

// ───── i18n with manual locale override ──────────────────────────────────
// chrome.i18n.getMessage() picks locale from Chrome's UI language and
// cannot be overridden at runtime. To let the user pick UI language inside
// our popup (independent of Chrome's setting), we manually fetch the
// matching messages.json and resolve from it; falling back to chrome.i18n
// when "auto".
let manualMessages = null;
async function loadManualMessages(locale) {
  if (!locale || locale === "auto") { manualMessages = null; return; }
  try {
    const url = chrome.runtime.getURL(`_locales/${locale}/messages.json`);
    const r = await fetch(url);
    if (r.ok) manualMessages = await r.json();
  } catch { manualMessages = null; }
}
function resolveManual(entry, subs) {
  let msg = entry.message || "";
  if (entry.placeholders && subs) {
    for (const [name, def] of Object.entries(entry.placeholders)) {
      const val = String(def.content || "").replace(/\$(\d+)/g,
        (_, n) => subs[parseInt(n, 10) - 1] ?? "");
      msg = msg.split(`$${name.toUpperCase()}$`).join(val);
    }
  } else if (subs) {
    subs.forEach((v, i) => { msg = msg.split(`$${i + 1}`).join(v); });
  }
  return msg;
}
function t(key, subs) {
  if (manualMessages?.[key]?.message) return resolveManual(manualMessages[key], subs);
  return chrome.i18n.getMessage(key, subs) || key;
}

const $ = (id) => document.getElementById(id);
const tierSelect = $("tier");
const voiceSelect = $("voice");
const langSelect = $("lang");
const kymaKeyInput = $("kymaKey");
const keyBadge = $("keyBadge");
const toggleBtn = $("toggle");
const statusEl = $("status");
const originalVolumeInput = $("originalVolume");
const voiceVolumeInput = $("voiceVolume");
const originalOut = $("originalOut");
const voiceOut = $("voiceOut");
const showSourceCheckbox = $("showSource");

// Languages: code → i18n key for display name. The code is the canonical
// identifier sent to the translation pipeline; the label is locale-dependent.
const LANGUAGES = [
  ["en", "langEn"], ["vi", "langVi"], ["ja", "langJa"],
  ["ko", "langKo"], ["zh", "langZh"], ["fr", "langFr"],
  ["es", "langEs"], ["de", "langDe"], ["pt", "langPt"],
  ["hi", "langHi"], ["id", "langId"], ["it", "langIt"],
  ["ru", "langRu"],
];
const REALTIME_VOICES = [
  { id: "", nameKey: "voiceAuto" },
  { id: "marin",   nameKey: "voiceMarinName" },
  { id: "alloy",   nameKey: "voiceAlloyName" },
  { id: "ash",     nameKey: "voiceAshName" },
  { id: "ballad",  nameKey: "voiceBalladName" },
  { id: "coral",   nameKey: "voiceCoralName" },
  { id: "echo",    nameKey: "voiceEchoName" },
  { id: "sage",    nameKey: "voiceSageName" },
  { id: "shimmer", nameKey: "voiceShimmerName" },
  { id: "verse",   nameKey: "voiceVerseName" },
];
// Standard tier — Minimax `speech-02-turbo` voice IDs. Cross-language: each
// voice speaks any of the 13 target languages. Curated from the 333-voice
// catalog after a Vietnamese listening test (Son, 2026-05-08).
const STANDARD_VOICES = [
  { id: "English_magnetic_voiced_man",      nameKey: "voiceMagneticMan" },
  { id: "English_captivating_female1",      nameKey: "voiceCaptivatingFemale" },
  { id: "English_ManWithDeepVoice",         nameKey: "voiceDeepVoiceMan" },
  { id: "English_ConfidentWoman",           nameKey: "voiceConfidentWoman" },
  { id: "Chinese (Mandarin)_News_Anchor",   nameKey: "voiceNewsAnchor" },
];

let state = {
  running: false, connecting: false, paused: false,
  tier: "standard", targetLanguage: "vi",
  realtimeVoice: "marin",
  standardVoice: "English_magnetic_voiced_man",
  originalVolume: 18, voiceVolume: 100, showSource: false,
  kymaKey: "", status: "statusReady",
  uiLanguage: "auto",
};

// Resolve a status payload from background into displayable text. Background
// sends either a bare i18n key ("statusConnecting") or an object
// { key, subs: [...] } when the message has placeholders.
function resolveStatus(s) {
  if (!s) return "";
  if (typeof s === "string") return t(s);
  if (typeof s === "object" && s.key) return t(s.key, s.subs || []);
  return String(s);
}

// Apply chrome.i18n to every element with data-i18n / data-i18n-placeholder.
// Called once at init; subsequent dynamic content uses t() directly.
function applyStaticI18n(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const msg = t(el.dataset.i18n);
    if (msg) el.textContent = msg;
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    const msg = t(el.dataset.i18nPlaceholder);
    if (msg) el.placeholder = msg;
  }
}

function populateLanguages() {
  for (const [code, nameKey] of LANGUAGES) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = t(nameKey);
    langSelect.appendChild(opt);
  }
}

// Voice list swaps between tiers. Called whenever the tier changes so the
// dropdown only shows valid voices for the current pipeline.
function repopulateVoices(tier, preferredVoiceId) {
  const list = tier === "standard" ? STANDARD_VOICES : REALTIME_VOICES;
  voiceSelect.replaceChildren();
  for (const v of list) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = t(v.nameKey);
    voiceSelect.appendChild(opt);
  }
  const wanted = preferredVoiceId ?? "";
  const match = Array.from(voiceSelect.options).some((o) => o.value === wanted);
  voiceSelect.value = match ? wanted : list[0].id;
}

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (reply) => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message));
      else resolve(reply);
    });
  });
}

function isBenign(msg) {
  if (!msg) return false;
  return /message channel closed|asynchronous response|message port closed|Receiving end does not exist/i.test(msg);
}

function setStateClass(name) {
  document.body.dataset.state = name;
}

function setKeyBadge(k) {
  keyBadge.classList.remove("ok", "warn");
  if (!k) {
    keyBadge.textContent = t("keyMissing");
  } else if (k.startsWith("ky") || k.startsWith("kyma-")) {
    keyBadge.textContent = t("keySaved");
    keyBadge.classList.add("ok");
  } else {
    keyBadge.textContent = t("keyCheck");
    keyBadge.classList.add("warn");
  }
}

function applyState(s) {
  state = { ...state, ...s };
  if (typeof state.tier === "string") {
    const allowed = state.tier === "standard" ? "standard" : "realtime";
    if (tierSelect.value !== allowed) tierSelect.value = allowed;
  }
  if (typeof state.targetLanguage === "string") langSelect.value = state.targetLanguage;
  const activeVoice = tierSelect.value === "standard" ? state.standardVoice : state.realtimeVoice;
  repopulateVoices(tierSelect.value, activeVoice);
  if (typeof state.originalVolume === "number") {
    originalVolumeInput.value = state.originalVolume;
    originalOut.textContent = state.originalVolume;
  }
  if (typeof state.voiceVolume === "number") {
    voiceVolumeInput.value = state.voiceVolume;
    voiceOut.textContent = state.voiceVolume;
  }
  if (typeof state.showSource === "boolean") showSourceCheckbox.checked = state.showSource;
  if (typeof state.kymaKey === "string") {
    if (kymaKeyInput.value !== state.kymaKey) kymaKeyInput.value = state.kymaKey;
    setKeyBadge(state.kymaKey);
  }

  // Status + button. Background sends keys; we resolve here.
  if (state.connecting) {
    setStateClass("connecting");
    statusEl.textContent = resolveStatus(state.status) || t("statusConnecting");
    toggleBtn.textContent = t("btnStop");
    toggleBtn.classList.add("is-live");
  } else if (state.running && state.paused) {
    setStateClass("paused");
    statusEl.textContent = t("statusPaused");
    toggleBtn.textContent = t("btnStop");
    toggleBtn.classList.add("is-live");
  } else if (state.running) {
    setStateClass("active");
    const langKey = LANGUAGES.find(([c]) => c === state.targetLanguage)?.[1];
    const langName = langKey ? t(langKey) : state.targetLanguage;
    statusEl.textContent = t("statusTranslatingTo", [langName]);
    toggleBtn.textContent = t("btnStop");
    toggleBtn.classList.add("is-live");
  } else if (state.errorMessage) {
    setStateClass("error");
    statusEl.textContent = resolveStatus(state.errorMessage);
    toggleBtn.textContent = t("btnStart");
    toggleBtn.classList.remove("is-live");
  } else {
    setStateClass("idle");
    statusEl.textContent = state.kymaKey ? t("statusReady") : t("statusReadyNoKey");
    toggleBtn.textContent = t("btnStart");
    toggleBtn.classList.remove("is-live");
  }
  toggleBtn.disabled = false;
}

function readSettings() {
  const tier = tierSelect.value;
  const voiceKey = tier === "standard" ? "standardVoice" : "realtimeVoice";
  return {
    tier,
    targetLanguage: langSelect.value,
    [voiceKey]: voiceSelect.value,
    originalVolume: Number(originalVolumeInput.value),
    voiceVolume: Number(voiceVolumeInput.value),
    showSource: showSourceCheckbox.checked,
    kymaKey: kymaKeyInput.value.trim(),
  };
}

async function pushSettings() {
  try {
    const reply = await send({ type: "UPDATE_SETTINGS", settings: readSettings() });
    if (reply?.state) applyState(reply.state);
  } catch (err) {
    if (!isBenign(err.message)) {
      statusEl.textContent = err.message;
      setStateClass("error");
    }
  }
}

let volumeDebounce = null;
function onVolumeChange() {
  originalOut.textContent = originalVolumeInput.value;
  voiceOut.textContent = voiceVolumeInput.value;
  clearTimeout(volumeDebounce);
  volumeDebounce = setTimeout(() => {
    chrome.runtime.sendMessage({
      type: "UPDATE_VOLUME",
      originalVolume: Number(originalVolumeInput.value),
      voiceVolume: Number(voiceVolumeInput.value),
    }).catch(() => {});
  }, 60);
}

async function onToggle() {
  toggleBtn.disabled = true;
  try {
    if (state.running || state.connecting) {
      const reply = await send({ type: "STOP" });
      if (reply?.state) applyState(reply.state);
      else applyState({ running: false, connecting: false, paused: false });
    } else {
      const settings = readSettings();
      if (!settings.kymaKey) {
        statusEl.textContent = t("errAddKey");
        setStateClass("error");
        toggleBtn.disabled = false;
        return;
      }
      const reply = await send({ type: "START", settings });
      if (!reply?.ok) {
        statusEl.textContent = resolveStatus(reply?.error) || t("errCannotStart");
        setStateClass("error");
        toggleBtn.disabled = false;
        return;
      }
      if (reply?.state) applyState(reply.state);
    }
  } catch (err) {
    toggleBtn.disabled = false;
    if (isBenign(err.message)) return;
    statusEl.textContent = err.message;
    setStateClass("error");
  }
}

// ───── Events ─────
tierSelect.addEventListener("change", () => {
  const tier = tierSelect.value;
  const wanted = tier === "standard" ? state.standardVoice : state.realtimeVoice;
  repopulateVoices(tier, wanted);
  pushSettings();
});
voiceSelect.addEventListener("change", pushSettings);
langSelect.addEventListener("change", pushSettings);
showSourceCheckbox.addEventListener("change", pushSettings);
kymaKeyInput.addEventListener("input", () => setKeyBadge(kymaKeyInput.value.trim()));
kymaKeyInput.addEventListener("change", pushSettings);
originalVolumeInput.addEventListener("input", onVolumeChange);
voiceVolumeInput.addEventListener("input", onVolumeChange);
toggleBtn.addEventListener("click", onToggle);

// Background push subscription
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "BACKGROUND_STATE_UPDATE" && message.state) {
    applyState(message.state);
  }
});

// ───── UI language toggle ─────
function applyUiLanguageButtons(active) {
  document.querySelectorAll("[data-ui-lang]").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.uiLang === active);
  });
}
async function onUiLanguageClick(e) {
  const btn = e.target.closest("[data-ui-lang]");
  if (!btn) return;
  const newLang = btn.dataset.uiLang;
  state.uiLanguage = newLang;
  await loadManualMessages(newLang === "auto" ? null : newLang);
  applyStaticI18n();
  // Re-populate dynamic content with new locale
  populateLanguages();
  repopulateVoices(tierSelect.value, tierSelect.value === "standard" ? state.standardVoice : state.realtimeVoice);
  langSelect.value = state.targetLanguage || "vi";
  applyState(state);  // re-render status text with new locale
  applyUiLanguageButtons(newLang);
  // Persist via background so content script also picks it up
  chrome.runtime.sendMessage({
    type: "UPDATE_SETTINGS",
    settings: { uiLanguage: newLang },
  }).catch(() => {});
}
document.querySelectorAll("[data-ui-lang]").forEach((b) =>
  b.addEventListener("click", onUiLanguageClick));

// Init
(async () => {
  // Load uiLanguage preference BEFORE rendering any text so first paint
  // shows the user's chosen locale instead of flashing Chrome's default.
  let stored = {};
  try { stored = await chrome.storage.local.get({ uiLanguage: "auto" }); } catch {}
  const initialLang = stored.uiLanguage || "auto";
  await loadManualMessages(initialLang === "auto" ? null : initialLang);
  applyStaticI18n();
  populateLanguages();
  repopulateVoices(state.tier, state.tier === "standard" ? state.standardVoice : state.realtimeVoice);
  applyUiLanguageButtons(initialLang);

  try {
    const reply = await send({ type: "GET_STATE" });
    if (reply?.state) {
      applyState(reply.state);
      // Honor stored uiLanguage from background settings (overrides local fetch)
      if (reply.state.uiLanguage && reply.state.uiLanguage !== initialLang) {
        await loadManualMessages(reply.state.uiLanguage === "auto" ? null : reply.state.uiLanguage);
        applyStaticI18n();
        populateLanguages();
        repopulateVoices(tierSelect.value, tierSelect.value === "standard" ? state.standardVoice : state.realtimeVoice);
        applyState(reply.state);
        applyUiLanguageButtons(reply.state.uiLanguage);
      }
    }
  } catch (err) {
    if (!isBenign(err.message)) {
      statusEl.textContent = err.message;
      setStateClass("error");
    }
  }
})();
