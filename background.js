// YouNote background service worker — single source of truth for session state.
//
// Popup is a passive renderer. Content script owns the WebRTC PeerConnection
// lifecycle. Background glues them: ensureContentScript(tabId) makes Start
// work without a refresh. state.* is the canonical snapshot. Status fields
// hold i18n keys (e.g. "statusReady"); popup resolves to text via chrome.i18n.

const DEFAULT_SETTINGS = {
  tier: "standard",
  targetLanguage: "vi",
  realtimeVoice: "marin",
  // Standard tier (Minimax chunked pipeline). Default voice is Magnetic Man,
  // the male voice Son ranked highest in the 2026-05-08 listening test.
  standardVoice: "English_magnetic_voiced_man",
  originalVolume: 18,
  voiceVolume: 100,
  showSource: false,
  kymaKey: "",
  // UI language override. "auto" = use Chrome's locale (chrome.i18n).
  // "vi" / "en" = force a specific locale via manual messages.json fetch.
  uiLanguage: "auto",
};

// In-memory state. Resets when the service worker cold-starts.
const state = {
  running: false,
  connecting: false,
  paused: false,
  tabId: null,
  status: "statusReady",
  errorMessage: "",
  ...DEFAULT_SETTINGS,
};

// Restrict storage access so rogue page scripts on youtube.com cannot read
// the user's Kyma key.
chrome.storage.local
  .setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch(() => {});

let lastBroadcastAt = 0;
const BROADCAST_DEBOUNCE_MS = 50;

function snapshot() {
  return { ...state };
}

function broadcastToPopup() {
  const now = Date.now();
  if (now - lastBroadcastAt < BROADCAST_DEBOUNCE_MS) return;
  lastBroadcastAt = now;
  chrome.runtime
    .sendMessage({ type: "BACKGROUND_STATE_UPDATE", state: snapshot() })
    .catch(() => {});
}

async function relayToContent(tabId, message) {
  if (!tabId) throw new Error("No active tab to relay to.");
  return chrome.tabs.sendMessage(tabId, message);
}

function isYouTubeUrl(url) {
  return typeof url === "string" && /^https?:\/\/[^/]*youtube\.com\//.test(url);
}

async function activeYouTubeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw { i18n: "errNoActiveTab" };
  if (!isYouTubeUrl(tab.url)) throw { i18n: "errOpenYT" };
  return tab;
}

// Ensure content script is alive in the target tab.
async function ensureContentScript(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: "CONTENT_PING" });
    if (reply?.ok) return;
  } catch {
    // Not yet injected.
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"],
    });
  } catch {
    // CSS may already be present from manifest static match — harmless.
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  Object.assign(state, stored);
  return stored;
}

async function persistSettings(partial) {
  Object.assign(state, partial);
  const persistable = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (k in partial) persistable[k] = state[k];
  }
  if (Object.keys(persistable).length) {
    await chrome.storage.local.set(persistable);
  }
}

async function handleStart(settings) {
  if (state.running || state.connecting) {
    return { ok: false, error: "errSessionRunning" };
  }
  await persistSettings(settings || {});
  let tab;
  try {
    tab = await activeYouTubeTab();
  } catch (err) {
    return { ok: false, error: err?.i18n || err?.message || String(err) };
  }
  state.tabId = tab.id;
  state.connecting = true;
  state.errorMessage = "";
  state.status = "statusConnecting";
  broadcastToPopup();

  try {
    await ensureContentScript(tab.id);
    const reply = await relayToContent(tab.id, {
      type: "CONTENT_START",
      settings: snapshot(),
    });
    if (!reply?.ok) {
      throw reply?.error || "errCannotStart";
    }
    state.connecting = false;
    state.running = true;
    state.status = "statusTranslating";
    broadcastToPopup();
    return { ok: true, state: snapshot() };
  } catch (err) {
    state.connecting = false;
    state.running = false;
    // err may be: an i18n key string, an i18n payload object {key, subs},
    // an Error, or a plain string. Preserve as-is so popup can resolve.
    if (typeof err === "string" || (err && typeof err === "object" && err.key)) {
      state.errorMessage = err;
    } else {
      state.errorMessage = err?.message || String(err);
    }
    state.status = state.errorMessage;
    broadcastToPopup();
    return { ok: false, error: state.errorMessage };
  }
}

async function handleStop() {
  const tabId = state.tabId;
  state.running = false;
  state.connecting = false;
  state.paused = false;
  state.status = "statusStopped";
  broadcastToPopup();
  if (tabId) {
    try {
      await relayToContent(tabId, { type: "CONTENT_STOP" });
    } catch {
      // Tab may be gone; that's fine.
    }
  }
  state.tabId = null;
  return { ok: true, state: snapshot() };
}

async function handleUpdateSettings(settings) {
  await persistSettings(settings || {});
  broadcastToPopup();
  if (state.tabId && (state.running || state.connecting)) {
    try {
      const reply = await relayToContent(state.tabId, {
        type: "CONTENT_UPDATE_SETTINGS",
        settings: snapshot(),
      });
      if (reply?.state) Object.assign(state, reply.state);
    } catch (err) {
      state.errorMessage = err?.message || String(err);
      broadcastToPopup();
    }
  }
  return { ok: true, state: snapshot() };
}

async function handleUpdateVolume(originalVolume, voiceVolume) {
  if (typeof originalVolume === "number") state.originalVolume = originalVolume;
  if (typeof voiceVolume === "number") state.voiceVolume = voiceVolume;
  chrome.storage.local
    .set({ originalVolume: state.originalVolume, voiceVolume: state.voiceVolume })
    .catch(() => {});
  if (state.tabId) {
    try {
      await relayToContent(state.tabId, {
        type: "CONTENT_UPDATE_VOLUME",
        originalVolume: state.originalVolume,
        voiceVolume: state.voiceVolume,
      });
    } catch {
      // Tab gone; volume will be re-applied next start.
    }
  }
  return { ok: true };
}

// Content-side push: session live state + transient events.
function handleContentEvent(message) {
  if (message.type === "CONTENT_STATE") {
    if (typeof message.running === "boolean") state.running = message.running;
    if (typeof message.paused === "boolean") state.paused = message.paused;
    // Status can be a bare key string or {key, subs} payload.
    if (message.status !== undefined) state.status = message.status;
    if (message.errorMessage !== undefined) state.errorMessage = message.errorMessage;
    broadcastToPopup();
  }
  if (message.type === "CONTENT_ENDED") {
    state.running = false;
    state.connecting = false;
    state.paused = false;
    state.tabId = null;
    state.status = message.reason || "statusStopped";
    broadcastToPopup();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab) {
    handleContentEvent(message);
    sendResponse?.({ ok: true });
    return false;
  }

  (async () => {
    try {
      switch (message?.type) {
        case "GET_STATE":
          await loadSettings();
          sendResponse({ ok: true, state: snapshot() });
          break;
        case "START":
          sendResponse(await handleStart(message.settings));
          break;
        case "STOP":
          sendResponse(await handleStop());
          break;
        case "UPDATE_SETTINGS":
          sendResponse(await handleUpdateSettings(message.settings));
          break;
        case "UPDATE_VOLUME":
          sendResponse(await handleUpdateVolume(
            message.originalVolume,
            message.voiceVolume,
          ));
          break;
        default:
          sendResponse({ ok: false, error: { key: "errUnknownMessage", subs: [String(message?.type)] } });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId) {
    void handleStop();
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== state.tabId) return;
  if (!changeInfo.url) return;
  void handleStop();
});

void loadSettings();
