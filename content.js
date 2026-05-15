// YouNote content script — owns WebRTC PeerConnection lifecycle, the in-page
// overlay panel, and YT video element capture. Background tells us when to
// start/stop/update; we tell background what's happening via CONTENT_STATE.
//
// All user-visible strings flow through chrome.i18n. Status/error sent to
// background are i18n keys (or {key, subs} payloads) — the popup resolves.
// Toasts display directly in the overlay so are resolved locally.
//
// Layered: F9 version guard, F6 token-guarded async, F5 captureStream retry,
// F1 overlay panel, F2 history, F3 source captions, F4 handover.

(() => {
  // ───── F9 — Idempotent version guard ──────────────────────────────────────
  const YOUNOTE_VERSION = "0.4.4";
  const GLOBAL_KEY = "__younoteContentVersion";
  if (window[GLOBAL_KEY] === YOUNOTE_VERSION) return;
  // Older copy may have left UI behind (also covers Echoly-era v0.2.x).
  document.querySelectorAll(".ec-root").forEach((el) => el.remove());
  window[GLOBAL_KEY] = YOUNOTE_VERSION;

  // ───── i18n with manual locale override ──────────────────────────────────
  // Mirror of popup's logic: chrome.i18n.getMessage cannot be overridden at
  // runtime, so when user picks a UI language inside the extension we fetch
  // the matching messages.json ourselves and resolve from it.
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

  // ───── Constants ──────────────────────────────────────────────────────────
  const KYMA_BASE = "https://api.kymaapi.com/v1";
  const OPENAI_CALLS_URL = "https://api.openai.com/v1/realtime/translations/calls";
  const SESSION_LIMIT_MS = 60 * 60 * 1000;
  const SESSION_WARNING_MS = 55 * 60 * 1000;
  const HEARTBEAT_MS = 30_000;
  const CAPTION_POLL_MS = 350;
  const HISTORY_MAX = 16;
  // Persistent history kept across sessions in chrome.storage.local. Capped
  // so the storage entry never balloons; oldest dropped FIFO when over.
  const HISTORY_PERSIST_MAX = 500;
  const HISTORY_STORAGE_KEY = "younoteTranslationHistory";
  const VOICE_GAIN_MAX = 2.0;
  // Storage key intentionally kept as "echolyOverlayLayout" so users who
  // upgrade from Echoly v0.2.x retain their saved panel layout. Renaming
  // would silently reset position/size on first run after the rebrand.
  const LAYOUT_KEY = "echolyOverlayLayout";
  const RTL_LANGS = new Set(["ar", "fa", "he", "ur"]);

  // Languages: code → i18n key. Code is canonical, label is locale-dependent.
  const LANGUAGES = [
    ["en", "langEn"], ["vi", "langVi"], ["ja", "langJa"],
    ["ko", "langKo"], ["zh", "langZh"], ["fr", "langFr"],
    ["es", "langEs"], ["de", "langDe"], ["pt", "langPt"],
    ["hi", "langHi"], ["id", "langId"], ["it", "langIt"],
    ["ru", "langRu"],
  ];
  const LANG_KEY = Object.fromEntries(LANGUAGES);
  const langName = (code) => LANG_KEY[code] ? t(LANG_KEY[code]) : code;

  const REALTIME_VOICES = [
    "marin", "alloy", "ash", "ballad", "coral",
    "echo", "sage", "shimmer", "verse",
  ];
  const REALTIME_VOICE_KEY = {
    marin:   "voiceMarinName",
    alloy:   "voiceAlloyName",
    ash:     "voiceAshName",
    ballad:  "voiceBalladName",
    coral:   "voiceCoralName",
    echo:    "voiceEchoName",
    sage:    "voiceSageName",
    shimmer: "voiceShimmerName",
    verse:   "voiceVerseName",
  };
  const STANDARD_VOICES = [
    ["English_magnetic_voiced_man",   "voiceMagneticMan"],
    ["English_captivating_female1",   "voiceCaptivatingFemale"],
    ["English_ManWithDeepVoice",      "voiceDeepVoiceMan"],
    ["English_ConfidentWoman",        "voiceConfidentWoman"],
    ["Chinese (Mandarin)_News_Anchor","voiceNewsAnchor"],
  ];
  const STANDARD_DEFAULT_VOICE = STANDARD_VOICES[0][0];

  const STANDARD_CHUNK_MS = 5000;
  const STANDARD_MIN_CHUNK_BYTES = 2000;
  const STANDARD_RECORDER_MIMES = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];

  // ───── F6 — Token-guarded session state ───────────────────────────────────
  let pageToken = 0;
  let session = null;
  let prevSession = null;
  let settings = null;
  let history = [];
  let currentTargetText = "";
  let currentSourceText = "";
  let captionPollTimer = null;
  let heartbeatTimer = null;
  let warningTimer = null;
  let limitTimer = null;
  let warningShown = false;
  let videoEl = null;
  let onYTPause = null;
  let onYTPlay = null;
  let lastSpaUrl = location.href;
  let layout = loadLayout();
  // Ad detection: YT toggles `.ad-showing` on the player element while an ad
  // plays (preroll/midroll). We pause processing without tearing down session.
  let adObserver = null;
  let isAdPlaying = false;
  let onVideoEnded = null;
  // persistedHistory is the long-lived store loaded from chrome.storage.local
  // on overlay build. New turns are pushed into both `history` (in-memory,
  // capped 16, drives sidebar render) and `persistedHistory` (capped 500,
  // drives the download export).
  let persistedHistory = [];
  let persistDebounce = null;
  let persistedHistoryLoadPromise = null;

  // ───── Background channel ─────────────────────────────────────────────────
  // Guard every chrome.* call against "Extension context invalidated" — this
  // happens whenever the user reloads/updates the extension while a YT tab
  // still has our old content script running. Old listeners fire, hit a dead
  // chrome.runtime, and would throw uncaught synchronously. We swallow the
  // error and self-destruct the stale overlay so the user can re-trigger
  // a fresh inject (or the static content_scripts entry will reinject on
  // next page navigation) without a confusing red console error.
  let contextInvalidated = false;
  function isExtensionAlive() {
    try { return !!chrome?.runtime?.id; } catch { return false; }
  }
  function teardownStaleOverlay() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    try {
      document.querySelectorAll(".ec-root").forEach((el) => el.remove());
      try { window[GLOBAL_KEY] = null; } catch {}
    } catch {}
  }
  function notifyBackground(msg) {
    if (!isExtensionAlive()) { teardownStaleOverlay(); return; }
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      teardownStaleOverlay();
    }
  }
  function emitState(partial) {
    notifyBackground({ type: "CONTENT_STATE", ...partial });
  }
  function emitEnded(reason) {
    notifyBackground({ type: "CONTENT_ENDED", reason });
  }

  // ───── F1 — Overlay panel ─────────────────────────────────────────────────
  let root = null;
  let elements = {};

  function loadLayout() {
    try {
      return {
        left: null, top: null, width: null, height: null, sideCollapsed: false,
        ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}"),
      };
    } catch {
      return { left: null, top: null, width: null, height: null, sideCollapsed: false };
    }
  }
  function saveLayout() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch {}
  }
  function clampLayout() {
    const maxW = Math.max(300, window.innerWidth - 24);
    const maxH = Math.max(130, window.innerHeight - 24);
    const w = Math.min(Math.max(layout.width || 580, 300), maxW);
    const h = Math.min(Math.max(layout.height || 220, 130), maxH);
    const left = Math.min(
      Math.max(layout.left ?? window.innerWidth - w - 24, 12),
      Math.max(12, window.innerWidth - w - 12),
    );
    const top = Math.min(
      Math.max(layout.top ?? window.innerHeight - h - 96, 12),
      Math.max(12, window.innerHeight - h - 12),
    );
    layout = { ...layout, left, top, width: w, height: h };
  }
  function applyLayout() {
    if (!root) return;
    clampLayout();
    root.style.left = layout.left + "px";
    root.style.top = layout.top + "px";
    root.style.width = layout.width + "px";
    root.style.height = layout.height + "px";
    root.style.right = "auto";
    root.style.bottom = "auto";
    root.classList.toggle("is-side-collapsed", !!layout.sideCollapsed);
    root.classList.toggle("is-compact", layout.width < 580 || layout.height < 220);
    root.classList.toggle("is-roomy", layout.width > 780 && layout.height > 245);
    root.style.setProperty(
      "--ec-target-lines",
      String(Math.max(2, Math.min(8, Math.floor((layout.height - 78) / 38)))),
    );
    if (elements.hideBtn) {
      elements.hideBtn.textContent = layout.sideCollapsed ? t("btnShow") : t("btnHide");
    }
  }

  function buildOverlay() {
    if (root) return;
    root = document.createElement("aside");
    root.className = "ec-root";
    root.dataset.state = "ready";
    root.innerHTML = `
      <div class="ec-toolbar" data-ec-drag>
        <span class="ec-brand">
          <span class="ec-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
              <path d="M7 9v6M11 6v12M15 8v8M19 11v2"/>
            </svg>
          </span>
          <span class="ec-wordmark">YouNote</span>
          <span class="ec-state" data-ec-status></span>
        </span>
        <div class="ec-toolbar-actions">
          <select class="ec-select" data-ec-language aria-label="${t("languageLabel")}"></select>
          <select class="ec-select" data-ec-voice aria-label="${t("voiceLabel")}"></select>
          <button class="ec-btn" type="button" data-ec-history-btn></button>
          <button class="ec-btn" type="button" data-ec-download></button>
          <button class="ec-btn" type="button" data-ec-hide></button>
          <button class="ec-btn" type="button" data-ec-minimize></button>
          <button class="ec-btn ec-btn-primary" type="button" data-ec-stop></button>
        </div>
      </div>
      <div class="ec-live-bar" data-ec-live-bar>
        <span class="ec-live-label" data-ec-live-label></span>
        <span class="ec-live-text" data-ec-live-source></span>
      </div>
      <div class="ec-compare" data-ec-compare>
        <div class="ec-col-head ec-col-head-source" data-ec-col-source></div>
        <div class="ec-col-head ec-col-head-target" data-ec-col-target></div>
        <div class="ec-compare-empty" data-ec-compare-empty></div>
      </div>
      <div class="ec-footer">
        <span class="ec-attribution"></span>
      </div>
      <div class="ec-modal" data-ec-modal hidden>
        <div class="ec-modal-head">
          <span class="ec-modal-title" data-ec-modal-title></span>
          <span class="ec-modal-meta" data-ec-modal-meta></span>
          <span class="ec-spacer"></span>
          <button class="ec-btn" type="button" data-ec-modal-download></button>
          <button class="ec-btn" type="button" data-ec-modal-clear></button>
          <button class="ec-btn" type="button" data-ec-modal-close>×</button>
        </div>
        <div class="ec-modal-body" data-ec-modal-body></div>
      </div>
      <span class="ec-resize-edge ec-resize-edge-n" data-ec-resize="n"></span>
      <span class="ec-resize-edge ec-resize-edge-e" data-ec-resize="e"></span>
      <span class="ec-resize-edge ec-resize-edge-s" data-ec-resize="s"></span>
      <span class="ec-resize-edge ec-resize-edge-w" data-ec-resize="w"></span>
      <span class="ec-resize-corner ec-resize-corner-nw" data-ec-resize="nw"></span>
      <span class="ec-resize-corner ec-resize-corner-ne" data-ec-resize="ne"></span>
      <span class="ec-resize-corner ec-resize-corner-sw" data-ec-resize="sw"></span>
      <span class="ec-resize-corner ec-resize-corner-se" data-ec-resize="se"></span>
    `;
    document.documentElement.appendChild(root);

    elements = {
      status: root.querySelector("[data-ec-status]"),
      langSelect: root.querySelector("[data-ec-language]"),
      voiceSelect: root.querySelector("[data-ec-voice]"),
      liveBar: root.querySelector("[data-ec-live-bar]"),
      liveLabel: root.querySelector("[data-ec-live-label]"),
      liveText: root.querySelector("[data-ec-live-source]"),
      compare: root.querySelector("[data-ec-compare]"),
      colSource: root.querySelector("[data-ec-col-source]"),
      colTarget: root.querySelector("[data-ec-col-target]"),
      compareEmpty: root.querySelector("[data-ec-compare-empty]"),
      hideBtn: root.querySelector("[data-ec-hide]"),
      minimizeBtn: root.querySelector("[data-ec-minimize]"),
      stopBtn: root.querySelector("[data-ec-stop]"),
      downloadBtn: root.querySelector("[data-ec-download]"),
      historyBtn: root.querySelector("[data-ec-history-btn]"),
      attribution: root.querySelector(".ec-attribution"),
      drag: root.querySelector("[data-ec-drag]"),
      modal: root.querySelector("[data-ec-modal]"),
      modalTitle: root.querySelector("[data-ec-modal-title]"),
      modalMeta: root.querySelector("[data-ec-modal-meta]"),
      modalBody: root.querySelector("[data-ec-modal-body]"),
      modalDownload: root.querySelector("[data-ec-modal-download]"),
      modalClear: root.querySelector("[data-ec-modal-clear]"),
      modalClose: root.querySelector("[data-ec-modal-close]"),
    };

    refreshOverlayLabels(true);

    for (const [code, key] of LANGUAGES) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = t(key);
      elements.langSelect.appendChild(opt);
    }

    populateVoicePicker(settings?.tier || "standard");
    elements.langSelect.value = settings?.targetLanguage || "vi";

    elements.langSelect.addEventListener("change", () => {
      const newLang = elements.langSelect.value;
      if (settings?.tier === "standard") {
        settings.targetLanguage = newLang;
        notifyBackground({ type: "UPDATE_SETTINGS", settings: { targetLanguage: newLang } });
        setStatusText(t("statusSwitchLang", [langName(newLang)]));
        setOverlayState("live");
      } else {
        requestHandover({ targetLanguage: newLang });
      }
    });
    elements.voiceSelect.addEventListener("change", () => {
      const newVoice = elements.voiceSelect.value;
      if (settings?.tier === "standard") {
        settings.standardVoice = newVoice;
        notifyBackground({ type: "UPDATE_SETTINGS", settings: { standardVoice: newVoice } });
      } else {
        requestHandover({ realtimeVoice: newVoice });
      }
    });
    elements.hideBtn.addEventListener("click", () => {
      layout.sideCollapsed = !layout.sideCollapsed;
      saveLayout();
      applyLayout();
      // Re-text Hide ↔ Show whenever side toggles
      elements.hideBtn.textContent = layout.sideCollapsed ? t("btnShow") : t("btnHide");
    });
    elements.minimizeBtn.addEventListener("click", () => {
      minimizeOverlay();
    });
    elements.downloadBtn.addEventListener("click", () => {
      downloadTranscript();
    });
    elements.historyBtn.addEventListener("click", () => {
      openHistoryModal();
    });
    elements.modalClose.addEventListener("click", closeHistoryModal);
    elements.modalDownload.addEventListener("click", downloadTranscript);
    elements.modalClear.addEventListener("click", async () => {
      await clearPersistedHistory();
      renderHistoryModal();
      showToast(t("historyCleared"), 2500);
    });
    elements.modal.addEventListener("click", (e) => {
      // Click on backdrop (the modal element itself, not its children) closes.
      if (e.target === elements.modal) closeHistoryModal();
    });
    elements.stopBtn.addEventListener("click", () => {
      stopSession("user-stop");
      notifyBackground({ type: "CONTENT_STATE", running: false, status: "statusStopped" });
      emitEnded("statusStopped");
    });

    bindDragResize();
    applyLayout();

    window.addEventListener("resize", applyLayout);

    // Honor previously-saved minimized state — user closed the panel last
    // session and expects it to stay closed until they click the floater.
    if (layout.minimized) {
      root.classList.add("is-minimized");
      showFloater();
    }

    // Lazily load persisted transcript so the Download button works even
    // before any new turn arrives this session.
    void loadPersistedHistory();
  }

  function populateVoicePicker(tier) {
    if (!elements.voiceSelect) return;
    elements.voiceSelect.replaceChildren();
    if (tier === "standard") {
      for (const [id, key] of STANDARD_VOICES) {
        const opt = document.createElement("option");
        opt.value = id; opt.textContent = t(key);
        elements.voiceSelect.appendChild(opt);
      }
      elements.voiceSelect.value = settings?.standardVoice || STANDARD_DEFAULT_VOICE;
    } else {
      const autoOpt = document.createElement("option");
      autoOpt.value = ""; autoOpt.textContent = t("voiceAuto");
      elements.voiceSelect.appendChild(autoOpt);
      for (const v of REALTIME_VOICES) {
        const opt = document.createElement("option");
        opt.value = v; opt.textContent = t(REALTIME_VOICE_KEY[v]);
        elements.voiceSelect.appendChild(opt);
      }
      elements.voiceSelect.value = settings?.realtimeVoice ?? "marin";
    }
  }

  // Re-applies every i18n-derived label on the overlay. Called once on build
  // and again whenever the user toggles UI language. Static text only — does
  // NOT touch pair cells (user content), status text (live state-driven),
  // or modal body items (re-render on open).
  function refreshOverlayLabels(initial = false) {
    if (!elements.hideBtn) return;
    elements.hideBtn.textContent = layout.sideCollapsed ? t("btnShow") : t("btnHide");
    elements.stopBtn.textContent = t("btnStop");
    elements.downloadBtn.textContent = t("btnDownload");
    elements.downloadBtn.title = t("btnDownloadFull");
    elements.historyBtn.textContent = t("btnHistory");
    elements.historyBtn.title = t("btnHistoryFull");
    if (elements.minimizeBtn) {
      elements.minimizeBtn.textContent = t("btnMinimize");
      elements.minimizeBtn.title = t("btnMinimizeFull");
    }
    elements.modalTitle.textContent = t("historyTitle");
    elements.modalDownload.textContent = t("btnDownload");
    elements.modalClear.textContent = t("btnClearHistory");
    elements.modalClose.title = t("btnClose");
    elements.liveLabel.textContent = t("liveLabel");
    elements.colSource.textContent = t("colSourceLabel");
    elements.colTarget.textContent = t("colTargetLabel");
    elements.compareEmpty.textContent = t("compareEmpty");
    elements.attribution.textContent = t("attribution");
    if (initial) elements.status.textContent = t("statusReady");
  }
  function setOverlayState(state) {
    if (root) root.dataset.state = state;
  }
  function setStatusText(text) {
    if (elements.status) elements.status.textContent = text;
  }
  // setLiveCaption updates ONLY the top banner — a preview of whatever
  // Whisper/YT captions are emitting moment-to-moment. It is intentionally
  // decoupled from per-chunk pair cells so live caption polling cannot
  // overwrite a turn's committed source text.
  function setLiveCaption(text) {
    if (!elements.liveText) return;
    const trimmed = (text || "").trim();
    elements.liveText.textContent = trimmed;
    if (elements.liveBar) elements.liveBar.classList.toggle("is-empty", !trimmed);
  }
  function autoScrollCompare() {
    if (!elements.compare) return;
    // Only auto-scroll when user is already near the bottom — respect
    // manual scroll-up so they can read older content uninterrupted.
    const dist = elements.compare.scrollHeight - elements.compare.scrollTop - elements.compare.clientHeight;
    if (dist < 100) elements.compare.scrollTop = elements.compare.scrollHeight;
  }
  // Toast accepts plain text + optional CTA. Built via DOM APIs (not innerHTML)
  // because the text often comes from upstream API errors — a crafted error
  // body would otherwise be an XSS vector inside youtube.com's origin.
  function showToast(text, opts, durationMs) {
    if (!root) return;
    if (typeof opts === "number") { durationMs = opts; opts = null; }
    if (!durationMs) durationMs = 8000;
    let toast = root.querySelector(".ec-toast");
    if (toast) toast.remove();
    toast = document.createElement("div");
    toast.className = "ec-toast";
    toast.textContent = String(text || "");
    if (opts && opts.cta) {
      toast.append(" ");
      const a = document.createElement("a");
      a.href = String(opts.cta);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = String(opts.ctaLabel || t("topUp"));
      toast.appendChild(a);
    }
    root.appendChild(toast);
    setTimeout(() => toast.remove(), durationMs);
  }
  function removeOverlay() {
    if (!root) return;
    window.removeEventListener("resize", applyLayout);
    root.remove();
    root = null;
    elements = {};
    removeFloater();
  }

  // ───── Minimize / floater ─────────────────────────────────────────────────
  // Hide the whole overlay panel and replace it with a small floating button
  // anchored bottom-right. Click the floater → restore the panel. Session
  // stays alive in the background (audio dub keeps playing) so user can
  // watch the video unobstructed but resume the panel anytime.
  let floater = null;
  function minimizeOverlay() {
    if (!root) return;
    // Use class (not inline style) — the .ec-root rule has `display: grid
    // !important` to defend against YT page CSS, so inline style:none would
    // be silently overridden. The .is-minimized class is `!important` too,
    // declared after, so cascade order makes it win.
    root.classList.add("is-minimized");
    layout.minimized = true;
    saveLayout();
    showFloater();
  }
  function restoreOverlay() {
    removeFloater();
    if (root) root.classList.remove("is-minimized");
    layout.minimized = false;
    saveLayout();
  }
  function showFloater() {
    if (floater) return;
    floater = document.createElement("button");
    floater.type = "button";
    floater.className = "ec-floater";
    floater.title = t("btnRestoreFull");
    floater.setAttribute("aria-label", t("btnRestoreFull"));
    floater.innerHTML = `
      <span class="ec-floater-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
          <path d="M7 9v6M11 6v12M15 8v8M19 11v2"/>
        </svg>
      </span>
      <span class="ec-floater-dot" aria-hidden="true"></span>
    `;
    floater.addEventListener("click", restoreOverlay);
    document.documentElement.appendChild(floater);
  }
  function removeFloater() {
    if (floater) { floater.remove(); floater = null; }
  }

  // ───── Drag + resize ──────────────────────────────────────────────────────
  function bindDragResize() {
    let dragMode = null;
    let pointer = null;

    elements.drag.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button, select, input")) return;
      dragMode = "move";
      pointer = capturePointer(e);
      root.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    for (const handle of root.querySelectorAll("[data-ec-resize]")) {
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        dragMode = "resize-" + handle.dataset.ecResize;
        pointer = capturePointer(e);
        handle.setPointerCapture?.(e.pointerId);
        e.preventDefault();
      });
    }

    root.addEventListener("pointermove", (e) => {
      if (!dragMode || !pointer) return;
      const dx = e.clientX - pointer.x;
      const dy = e.clientY - pointer.y;
      if (dragMode === "move") {
        layout.left = pointer.left + dx;
        layout.top = pointer.top + dy;
      } else {
        const m = dragMode.slice(7);
        if (m.includes("e")) layout.width = pointer.width + dx;
        if (m.includes("s")) layout.height = pointer.height + dy;
        if (m.includes("w")) {
          layout.width = pointer.width - dx;
          layout.left = pointer.left + dx;
        }
        if (m.includes("n")) {
          layout.height = pointer.height - dy;
          layout.top = pointer.top + dy;
        }
      }
      applyLayout();
    });

    root.addEventListener("pointerup", () => {
      if (dragMode) saveLayout();
      dragMode = null;
      pointer = null;
    });
    root.addEventListener("pointercancel", () => {
      dragMode = null;
      pointer = null;
    });
  }
  function capturePointer(e) {
    const rect = root.getBoundingClientRect();
    return {
      x: e.clientX, y: e.clientY,
      left: layout.left ?? rect.left,
      top: layout.top ?? rect.top,
      width: layout.width ?? rect.width,
      height: layout.height ?? rect.height,
    };
  }

  // ───── F2 — History rendering + persistence ───────────────────────────────
  function loadPersistedHistory() {
    // Memoize so multiple callers (overlay build + first push) await the
    // same in-flight read instead of racing.
    if (persistedHistoryLoadPromise) return persistedHistoryLoadPromise;
    persistedHistoryLoadPromise = (async () => {
      if (!isExtensionAlive()) return;
      try {
        const stored = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
        const arr = stored?.[HISTORY_STORAGE_KEY];
        if (Array.isArray(arr)) persistedHistory = arr;
      } catch {}
    })();
    return persistedHistoryLoadPromise;
  }
  function schedulePersistHistory() {
    // Debounced write — Standard chunks come ~5s apart so 800ms keeps lag
    // imperceptible while coalescing handover bursts (rapid voice/lang swaps).
    if (persistDebounce) clearTimeout(persistDebounce);
    persistDebounce = setTimeout(() => {
      persistDebounce = null;
      if (!isExtensionAlive()) return;
      try {
        chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: persistedHistory })
          .catch(() => {});
      } catch { teardownStaleOverlay(); }
    }, 800);
  }
  // pushHistoryTurn accepts EXPLICIT source/target so callers don't depend
  // on shared global state. Falls back to globals only for legacy paths
  // (markers, manual session-end commits).
  function pushHistoryTurn(opts = {}) {
    const source = (opts.source !== undefined ? opts.source : currentSourceText) || "";
    const target = (opts.target !== undefined ? opts.target : currentTargetText) || "";
    if (!target && !opts.marker) return;
    const ts = opts.ts || Date.now();
    const entry = {
      ts,
      time: new Date(ts).toTimeString().slice(0, 5),
      target: target.slice(0, 280),
      source: source.slice(0, 220),
      lang: opts.lang || settings?.targetLanguage,
      voice: opts.voice || (settings?.tier === "standard" ? settings?.standardVoice : settings?.realtimeVoice),
      tier: opts.tier || settings?.tier,
      marker: opts.marker || null,
    };
    history.unshift(entry);
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;

    // Skip pure marker rows from persisted log — they're UI cues for the
    // sidebar, not meaningful transcript turns to export.
    if (entry.target) {
      const persisted = {
        ts,
        source: entry.source,
        target: entry.target,
        lang: entry.lang,
        voice: entry.voice,
        tier: entry.tier,
        videoUrl: location.href,
      };
      // Wait for the initial storage read to finish before mutating, so we
      // don't clobber pre-existing transcript turns from earlier sessions.
      void loadPersistedHistory().then(() => {
        persistedHistory.push(persisted);
        if (persistedHistory.length > HISTORY_PERSIST_MAX) {
          persistedHistory.splice(0, persistedHistory.length - HISTORY_PERSIST_MAX);
        }
        schedulePersistHistory();
      });
    }

    // For per-chunk pair architecture, the caller already committed its own
    // DOM pair before invoking pushHistoryTurn. We only need to handle marker
    // chips here (no caller does DOM for them).
    if (opts.marker) appendMarkerChip(opts.marker);
  }
  function appendMarkerChip(text) {
    if (!elements.compare) return;
    const m = document.createElement("div");
    m.className = "ec-pair-marker";
    const chip = document.createElement("span");
    chip.className = "ec-h-marker-chip";
    chip.textContent = text;
    m.appendChild(chip);
    // Insert before any in-flight pending pair so the marker appears at the
    // boundary between committed history and the upcoming turn.
    const pending = elements.compare.querySelector(".ec-pair-source.is-current");
    if (pending) elements.compare.insertBefore(m, pending);
    else elements.compare.appendChild(m);
    autoScrollCompare();
  }
  async function clearPersistedHistory() {
    persistedHistory = [];
    if (!isExtensionAlive()) return;
    try { await chrome.storage.local.remove(HISTORY_STORAGE_KEY); } catch {}
  }

  // ───── Download / export ──────────────────────────────────────────────────
  function pad2(n) { return String(n).padStart(2, "0"); }
  function formatTimestamp(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
      + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  function formatFilenameDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
      + `-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  }
  function buildTranscriptText() {
    const now = Date.now();
    const lines = [];
    lines.push(t("downloadHeader"));
    lines.push("=".repeat(60));
    lines.push(t("downloadVideoLine", [location.href]));
    lines.push(t("downloadGeneratedAt", [formatTimestamp(now)]));
    lines.push(t("downloadCount", [String(persistedHistory.length)]));
    lines.push("");
    const srcLabel = t("downloadSourceLabel");
    const tgtLabel = t("downloadTargetLabel");
    for (const turn of persistedHistory) {
      lines.push(`[${formatTimestamp(turn.ts)}]`);
      if (turn.source) lines.push(`  ${srcLabel}: ${turn.source}`);
      if (turn.target) lines.push(`  ${tgtLabel}: ${turn.target}`);
      lines.push("");
    }
    return lines.join("\n");
  }
  function downloadTranscript() {
    if (!persistedHistory.length) {
      showToast(t("downloadEmpty"), 4000);
      return;
    }
    const text = buildTranscriptText();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const filename = `younote-${formatFilenameDate(Date.now())}.txt`;
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 1000);
    showToast(t("downloadDone", [String(persistedHistory.length)]), 3000);
  }

  // ───── History modal ──────────────────────────────────────────────────────
  function openHistoryModal() {
    if (!elements.modal) return;
    elements.modal.hidden = false;
    void loadPersistedHistory().then(renderHistoryModal);
  }
  function closeHistoryModal() {
    if (elements.modal) elements.modal.hidden = true;
  }
  function copyText(text) {
    try {
      navigator.clipboard?.writeText(text);
    } catch {}
  }
  function deleteHistoryEntry(ts) {
    persistedHistory = persistedHistory.filter((e) => e.ts !== ts);
    schedulePersistHistory();
    renderHistoryModal();
  }
  // Group consecutive entries with the same videoUrl into one collapsible
  // "session" so a long transcript stays scannable and the user can find a
  // specific video they translated days ago.
  function groupHistoryByVideo(entries) {
    // Sort newest first then walk; emit a new group whenever videoUrl changes.
    const sorted = [...entries].sort((a, b) => b.ts - a.ts);
    const groups = [];
    let curr = null;
    for (const e of sorted) {
      const url = e.videoUrl || "";
      if (!curr || curr.url !== url) {
        curr = { url, entries: [] };
        groups.push(curr);
      }
      curr.entries.push(e);
    }
    return groups;
  }
  function shortenUrl(url) {
    if (!url) return "";
    try {
      const u = new URL(url);
      const v = u.searchParams.get("v");
      if (v) return `youtube.com/watch?v=${v}`;
      return u.host + u.pathname;
    } catch { return url.slice(0, 60); }
  }
  function renderHistoryModal() {
    if (!elements.modalBody) return;
    elements.modalMeta.textContent = t("downloadCount", [String(persistedHistory.length)]);
    elements.modalBody.replaceChildren();
    if (!persistedHistory.length) {
      const empty = document.createElement("div");
      empty.className = "ec-modal-empty";
      empty.textContent = t("historyEmpty");
      elements.modalBody.appendChild(empty);
      return;
    }
    const groups = groupHistoryByVideo(persistedHistory);
    const srcLabel = t("downloadSourceLabel");
    const tgtLabel = t("downloadTargetLabel");
    for (const g of groups) {
      const groupEl = document.createElement("div");
      groupEl.className = "ec-modal-group";

      const head = document.createElement("div");
      head.className = "ec-modal-group-head";
      const link = document.createElement("a");
      link.href = g.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = shortenUrl(g.url);
      const count = document.createElement("span");
      count.className = "ec-modal-group-count";
      count.textContent = String(g.entries.length);
      head.append(link, count);
      groupEl.appendChild(head);

      for (const e of g.entries) {
        const row = document.createElement("div");
        row.className = "ec-modal-row";

        const meta = document.createElement("div");
        meta.className = "ec-modal-row-meta";
        meta.textContent = formatTimestamp(e.ts);

        const body = document.createElement("div");
        body.className = "ec-modal-row-body";
        if (e.source) {
          const src = document.createElement("div");
          src.className = "ec-modal-row-src";
          const lbl = document.createElement("span");
          lbl.className = "ec-modal-row-label";
          lbl.textContent = srcLabel;
          src.append(lbl, document.createTextNode(" " + e.source));
          body.appendChild(src);
        }
        if (e.target) {
          const tgt = document.createElement("div");
          tgt.className = "ec-modal-row-tgt";
          const lbl = document.createElement("span");
          lbl.className = "ec-modal-row-label";
          lbl.textContent = tgtLabel;
          tgt.append(lbl, document.createTextNode(" " + e.target));
          body.appendChild(tgt);
        }

        const actions = document.createElement("div");
        actions.className = "ec-modal-row-actions";
        const copyBtn = document.createElement("button");
        copyBtn.className = "ec-modal-icon-btn";
        copyBtn.type = "button";
        copyBtn.textContent = t("btnCopy");
        copyBtn.title = t("btnCopy");
        copyBtn.addEventListener("click", () => {
          copyText([e.source, e.target].filter(Boolean).join("\n"));
          copyBtn.textContent = "✓";
          setTimeout(() => { copyBtn.textContent = t("btnCopy"); }, 1200);
        });
        const delBtn = document.createElement("button");
        delBtn.className = "ec-modal-icon-btn";
        delBtn.type = "button";
        delBtn.textContent = "×";
        delBtn.title = t("btnDeleteEntry");
        delBtn.addEventListener("click", () => deleteHistoryEntry(e.ts));
        actions.append(copyBtn, delBtn);

        row.append(meta, body, actions);
        groupEl.appendChild(row);
      }
      elements.modalBody.appendChild(groupEl);
    }
  }
  // Render committed turns into the compare grid as paired cells: each turn
  // produces one .ec-pair-source (left col) + one .ec-pair-target (right col)
  // sharing the same grid row, so source ↔ translation align horizontally.
  // Defensive cleanup — drops all in-flight pending pairs (called on session
  // teardown or handover where pending chunks are abandoned).
  function clearAllPendingPairs() {
    if (!elements.compare) return;
    elements.compare.querySelectorAll(".ec-pair-source.is-current, .ec-pair-target.is-current")
      .forEach((el) => el.remove());
  }
  // Wipe the entire compare grid (used when starting a fresh session).
  function clearCompareGrid() {
    if (!elements.compare) return;
    elements.compare.querySelectorAll(
      ".ec-pair-source, .ec-pair-target, .ec-pair-marker"
    ).forEach((el) => el.remove());
    if (elements.compareEmpty) elements.compareEmpty.hidden = false;
  }

  // ───── Per-chunk pair element helpers ─────────────────────────────────────
  // Each in-flight chunk owns its own DOM cells so concurrent chunks can't
  // overwrite each other's display state. Cells are appended in chunk-START
  // order, so visual order matches audio playback order. Returns a handle
  // {sourceEl, targetEl, time} the caller stores and uses to mutate later.
  let pairSerial = 0;
  function createPendingPair() {
    if (!elements.compare) return null;
    pairSerial += 1;
    const id = String(pairSerial);
    const src = document.createElement("div");
    src.className = "ec-pair-source is-current";
    src.dataset.pairId = id;
    const tgt = document.createElement("div");
    tgt.className = "ec-pair-target is-current";
    tgt.dataset.pairId = id;
    elements.compare.appendChild(src);
    elements.compare.appendChild(tgt);
    if (elements.compareEmpty) elements.compareEmpty.hidden = true;
    autoScrollCompare();
    return { id, sourceEl: src, targetEl: tgt };
  }
  function setPairSource(pair, text) {
    if (!pair?.sourceEl) return;
    pair.sourceEl.textContent = text || "";
    pair.sourceEl.classList.toggle("is-empty", !text);
    autoScrollCompare();
  }
  function setPairTarget(pair, text, lang) {
    if (!pair?.targetEl) return;
    pair.targetEl.textContent = text || "";
    if (lang && RTL_LANGS.has(lang)) pair.targetEl.dir = "rtl";
    else pair.targetEl.dir = "ltr";
    autoScrollCompare();
  }
  function commitPair(pair, time) {
    // Promote from in-flight (.is-current) to committed. We KEEP the same DOM
    // node (no re-render) so the visual position is stable — important when
    // multiple chunks are in flight and the user is reading.
    if (!pair?.sourceEl || !pair?.targetEl) return;
    pair.sourceEl.classList.remove("is-current");
    pair.targetEl.classList.remove("is-current");
    if (time) {
      const meta = document.createElement("span");
      meta.className = "ec-pair-time";
      meta.textContent = time;
      pair.targetEl.appendChild(meta);
    }
  }
  function dropPair(pair) {
    if (!pair) return;
    pair.sourceEl?.remove();
    pair.targetEl?.remove();
  }

  // ───── F3 — Source caption polling ────────────────────────────────────────
  let lastSeenCaption = "";
  function readYTCaptions() {
    const segs = document.querySelectorAll(".ytp-caption-segment");
    return Array.from(segs).map((s) => s.textContent).join(" ").trim().replace(/\s+/g, " ");
  }
  function startCaptionPoll() {
    stopCaptionPoll();
    lastSeenCaption = "";
    captionPollTimer = setInterval(() => {
      const text = readYTCaptions();
      if (!text || text === lastSeenCaption) return;
      lastSeenCaption = text;
      // currentSourceText reflects the latest caption — used by Realtime tier
      // as the source snapshot when a new transcript turn begins. NOT pushed
      // into pair cells (per-chunk pair owns its own source text).
      currentSourceText = text;
      setLiveCaption(text);
      if (elements.source && settings?.showSource) {
        elements.source.textContent = text.slice(-220);
      }
    }, CAPTION_POLL_MS);
  }
  function stopCaptionPoll() {
    if (captionPollTimer) {
      clearInterval(captionPollTimer);
      captionPollTimer = null;
    }
  }
  function applySourceVisibility() {
    if (!elements.source) return;
    elements.source.hidden = !settings?.showSource;
  }

  // ───── Ad detection ───────────────────────────────────────────────────────
  // YT toggles `.ad-showing` on `.html5-video-player` while an ad plays. We
  // pause processing without tearing down the session so the user keeps the
  // dub for the actual content and isn't billed for ad audio translation.
  const AD_SELECTORS = [
    ".html5-video-player.ad-showing",
    ".ytp-ad-player-overlay-instream-info",
    ".ytp-ad-player-overlay",
    ".video-ads .ytp-ad-module > *",  // legacy
  ];
  function isAdActive() {
    return AD_SELECTORS.some((sel) => document.querySelector(sel));
  }
  function startAdWatcher() {
    stopAdWatcher();
    const player = document.querySelector(".html5-video-player");
    if (!player) return;
    adObserver = new MutationObserver(() => {
      const adNow = isAdActive();
      if (adNow !== isAdPlaying) {
        isAdPlaying = adNow;
        if (adNow) onAdStart(); else onAdEnd();
      }
    });
    adObserver.observe(player, {
      attributes: true,
      attributeFilter: ["class"],
      subtree: false,
    });
    isAdPlaying = isAdActive();
    if (isAdPlaying) onAdStart();
  }
  function stopAdWatcher() {
    if (adObserver) { adObserver.disconnect(); adObserver = null; }
    isAdPlaying = false;
  }
  function onAdStart() {
    setStatusText(t("statusAdPlaying"));
    setOverlayState("paused");
    emitState({ status: "statusAdPlaying" });
    if (session) session.adPaused = true;
    // Realtime: silence the dub output while ad plays. PC stays alive so we
    // don't pay reconnect cost when ad ends.
    if (session?.outputGain && session?.audioCtx) {
      try { session.outputGain.gain.setValueAtTime(0, session.audioCtx.currentTime); } catch {}
    }
  }
  function onAdEnd() {
    if (!session) return;
    setStatusText(t("statusTranslating"));
    setOverlayState("live");
    emitState({ status: "statusTranslating" });
    session.adPaused = false;
    if (session.outputGain && session.audioCtx) {
      try {
        session.outputGain.gain.setValueAtTime(
          computeGain(settings?.voiceVolume ?? 100),
          session.audioCtx.currentTime,
        );
      } catch {}
    }
  }

  // ───── F5 — captureStream re-acquisition with playback nudge ──────────────
  function findVideo() {
    return document.querySelector("video.html5-main-video") || document.querySelector("video");
  }
  async function waitForNewVideo(timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = findVideo();
      if (v && v.readyState >= 2) return v;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  }
  function nudgePlay(video) {
    if (!video.paused) return Promise.resolve();
    const p = video.play();
    if (!p?.then) return Promise.resolve();
    return Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 250))]);
  }
  async function captureWithRetry(video, timeoutMs = 9000) {
    if (typeof video.captureStream !== "function" && typeof video.mozCaptureStream !== "function") {
      throw asI18nError("errCannotCapture");
    }
    const start = Date.now();
    let lastStream;
    while (Date.now() - start < timeoutMs) {
      if (video.paused) await nudgePlay(video);
      lastStream = (video.captureStream || video.mozCaptureStream).call(video);
      if (lastStream.getAudioTracks().length) {
        return new MediaStream(lastStream.getAudioTracks());
      }
      lastStream.getTracks().forEach((t) => t.stop());
      await new Promise((r) => setTimeout(r, 300));
    }
    throw asI18nError("errAudioNotReady");
  }

  // ───── i18n error helpers ─────────────────────────────────────────────────
  // Errors thrown internally carry an i18n key + optional subs so callers
  // can either resolve locally (toast/status text) or forward to background
  // as an opaque payload that the popup will resolve.
  function asI18nError(key, subs) {
    const err = new Error(t(key, subs));
    err.i18n = subs ? { key, subs } : key;
    return err;
  }
  function errorToI18n(err) {
    if (!err) return "errCannotStart";
    if (err.i18n) return err.i18n;
    if (typeof err === "string") return err;
    return err.message || String(err);
  }

  // ───── Kyma error parser ──────────────────────────────────────────────────
  function parseKymaError(status, errText) {
    try {
      const parsed = JSON.parse(errText);
      const err = parsed.error || {};
      if (err.code === "insufficient_balance") {
        const cta = err.cta_url || "https://kymaapi.com/billing";
        return { i18n: "errOutOfBalance", text: t("errOutOfBalance"), cta, ctaLabel: t("topUp") };
      }
      if (err.code === "too_many_sessions") {
        return { i18n: "errTooManySessions", text: t("errTooManySessions") };
      }
      if (err.code === "upstream_error") {
        return { i18n: "errUpstream", text: t("errUpstream") };
      }
      if (err.code === "rate_limited") {
        return { i18n: "errRateLimited", text: t("errRateLimited") };
      }
      if (err.message) {
        const subs = [String(status), String(err.message)];
        return { i18n: { key: "errKymaPrefix", subs }, text: t("errKymaPrefix", subs) };
      }
    } catch {}
    const subs = [String(status), (errText || "").slice(0, 160)];
    return { i18n: { key: "errKymaPrefix", subs }, text: t("errKymaPrefix", subs) };
  }

  // ───── Heartbeat + session timer (60-min cap, one-shot 55-min warning) ────
  function startHeartbeat(kymaSessionId, kymaKey) {
    stopHeartbeat();
    if (!kymaSessionId || !kymaKey) return;
    heartbeatTimer = setInterval(() => {
      if (!session) return;
      fetch(`${KYMA_BASE}/realtime/translations/sessions/${kymaSessionId}/heartbeat`, {
        method: "POST",
        headers: { Authorization: "Bearer " + kymaKey },
      }).catch(() => {});
    }, HEARTBEAT_MS);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  function startSessionTimer() {
    clearSessionTimer();
    warningShown = false;
    warningTimer = setTimeout(() => {
      if (warningShown) return;
      warningShown = true;
      showToast(t("sessionEndingSoon"), 6000);
    }, SESSION_WARNING_MS);
    limitTimer = setTimeout(() => {
      stopSession("auto-stop-60min");
      emitEnded("sessionAutoStopped");
    }, SESSION_LIMIT_MS);
  }
  function clearSessionTimer() {
    if (warningTimer) { clearTimeout(warningTimer); warningTimer = null; }
    if (limitTimer) { clearTimeout(limitTimer); limitTimer = null; }
  }

  async function endKymaSession(kymaSessionId, kymaKey) {
    if (!kymaSessionId || !kymaKey) return;
    try {
      await fetch(`${KYMA_BASE}/realtime/translations/sessions/${kymaSessionId}/end`, {
        method: "POST",
        headers: { Authorization: "Bearer " + kymaKey },
        keepalive: true,
      });
    } catch {}
  }

  // ───── Session core (build PeerConnection through Kyma → OpenAI) ─────────
  async function buildRealtimeSession(token, audioStream, opts) {
    const kymaKey = opts.kymaKey;
    const lang = opts.targetLanguage || "vi";
    const voice = opts.realtimeVoice || "";

    setStatusText(t("statusConnecting"));
    setOverlayState("connecting");

    let mintResp;
    try {
      mintResp = await fetch(`${KYMA_BASE}/realtime/translations/client_secrets`, {
        method: "POST",
        headers: { Authorization: "Bearer " + kymaKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          session: {
            model: "gpt-realtime-translate",
            audio: {
              // Enable input-side transcription so OpenAI streams the SOURCE
              // text back via session.input_transcript.* events. Without this,
              // the source column stays empty for videos that don't have YT
              // captions enabled (which is most of them).
              input: { transcription: { model: "whisper-1" } },
              output: { language: lang, ...(voice ? { voice } : {}) },
            },
          },
        }),
      });
    } catch (e) {
      throw asI18nError("errNetwork");
    }
    if (token !== pageToken) throw asI18nError("errStaleSession");
    if (!mintResp.ok) {
      const text = await mintResp.text().catch(() => "");
      const parsed = parseKymaError(mintResp.status, text);
      const err = new Error(parsed.text);
      err.i18n = parsed.i18n;
      err.cta = parsed.cta;
      err.ctaLabel = parsed.ctaLabel;
      throw err;
    }
    const mint = await mintResp.json();
    if (token !== pageToken) throw asI18nError("errStaleSession");
    const clientSecret = mint.value;
    const kymaSessionId = mint.kyma_session_id;
    if (!clientSecret) throw asI18nError("errMintNoSecret");

    const pc = new RTCPeerConnection();
    for (const track of audioStream.getAudioTracks()) pc.addTrack(track, audioStream);

    const dc = pc.createDataChannel("oai-events");
    dc.addEventListener("message", (e) => {
      if (token !== pageToken && session?.token !== token) return;
      handleRealtimeEvent(e.data, token);
    });

    const newSession = {
      token, pc, dc,
      stream: audioStream,
      remoteAudio: null,
      audioCtx: null,
      outputGain: null,
      kymaSessionId,
      kymaKey,
      targetLanguage: lang,
      realtimeVoice: voice,
    };

    pc.addEventListener("track", (event) => {
      if (newSession.remoteAudio) return;
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.muted = true;
      audio.srcObject = event.streams[0];
      document.body.appendChild(audio);
      newSession.remoteAudio = audio;

      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        const src = ctx.createMediaStreamSource(event.streams[0]);
        const gain = ctx.createGain();
        gain.gain.value = computeGain(settings?.voiceVolume ?? 100);
        src.connect(gain);
        gain.connect(ctx.destination);
        newSession.audioCtx = ctx;
        newSession.outputGain = gain;
      } catch {
        audio.muted = false;
        audio.volume = Math.min((settings?.voiceVolume ?? 100) / 100, 1.0);
      }
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      if (token !== pageToken && session?.token !== token) return;
      if (["closed", "failed", "disconnected"].includes(pc.iceConnectionState)) {
        if (newSession === session) {
          stopSession("connection-lost");
          emitEnded("connectionLost");
        }
      }
    });

    const offer = await pc.createOffer();
    if (token !== pageToken) throw asI18nError("errStaleSession");
    await pc.setLocalDescription(offer);

    const sdpResp = await fetch(OPENAI_CALLS_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + clientSecret, "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    if (token !== pageToken) {
      try { pc.close(); } catch {}
      throw asI18nError("errStaleSession");
    }
    if (!sdpResp.ok) {
      const errText = await sdpResp.text().catch(() => "");
      try { pc.close(); } catch {}
      void endKymaSession(kymaSessionId, kymaKey);
      // SDP errors come from OpenAI directly; commonly 429 means the gateway's
      // upstream OpenAI account is rate-limited or out of quota.
      if (sdpResp.status === 429) {
        const err = new Error(t("errRateLimited"));
        err.i18n = "errRateLimited";
        err.cta = "https://kymaapi.com/status";
        throw err;
      }
      const subs = [String(sdpResp.status), errText.slice(0, 160)];
      const err = new Error(t("errSdpExchange", subs));
      err.i18n = { key: "errSdpExchange", subs };
      throw err;
    }
    const answerSdp = await sdpResp.text();
    if (token !== pageToken) {
      try { pc.close(); } catch {}
      throw asI18nError("errStaleSession");
    }
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    return newSession;
  }

  function handleRealtimeEvent(raw, token) {
    if (token !== pageToken && session?.token !== token) return;
    if (!session) return;  // session torn down between event arrival and this tick
    let evt;
    try { evt = JSON.parse(raw); } catch { return; }
    if (evt.type === "error") {
      setStatusText(t("statusError"));
      return;
    }

    // Lazily create the per-turn pair the FIRST time any delta (input or
    // output) arrives. Both source and target deltas may interleave — we
    // need a single shared pair element so the row stays aligned.
    function ensurePair() {
      if (!session.currentPair) {
        session.currentPair = createPendingPair();
        session.currentTurnSource = "";
        session.currentTurnTarget = "";
        session.currentTurnStartTs = Date.now();
      }
    }

    // ── INPUT (source language) transcript stream ────────────────────────
    // Enabled by `input: { transcription: { model: "whisper-1" } }` in mint.
    // OpenAI emits these for the audio WE send → that's the original source.
    const isInputDelta =
      evt.type === "session.input_transcript.delta" ||
      evt.type === "conversation.item.input_audio_transcription.delta";
    if (isInputDelta && evt.delta) {
      ensurePair();
      session.currentTurnSource += evt.delta;
      setPairSource(session.currentPair, session.currentTurnSource);
      setOverlayState("live");
      return;
    }
    const isInputDone =
      evt.type === "session.input_transcript.done" ||
      evt.type === "session.input_transcript.completed" ||
      evt.type === "conversation.item.input_audio_transcription.completed";
    if (isInputDone) {
      ensurePair();
      const finalSrc = evt.transcript || session.currentTurnSource || "";
      session.currentTurnSource = finalSrc;
      setPairSource(session.currentPair, finalSrc);
      // Don't commit here — wait for OUTPUT done so audio playback aligns.
      return;
    }

    // ── OUTPUT (translated) transcript stream ────────────────────────────
    const isDelta =
      evt.type === "session.output_transcript.delta" ||
      evt.type === "response.audio_transcript.delta" ||
      evt.type === "response.output_audio_transcript.delta" ||
      (evt.type === "response.text.delta" && typeof evt.delta === "string");
    if (isDelta && evt.delta) {
      ensurePair();
      // Fallback: if no input transcript came in (e.g. mint config rejected
      // input transcription), seed source from latest YT caption snapshot.
      if (!session.currentTurnSource && currentSourceText) {
        session.currentTurnSource = currentSourceText;
        setPairSource(session.currentPair, session.currentTurnSource);
      }
      session.currentTurnTarget += evt.delta;
      setPairTarget(session.currentPair, session.currentTurnTarget, session.targetLanguage);
      setOverlayState("live");
      return;
    }
    const isDone =
      evt.type === "session.output_transcript.done" ||
      evt.type === "response.audio_transcript.done" ||
      evt.type === "response.output_audio_transcript.done" ||
      evt.type === "response.text.done";
    if (isDone) {
      if (!session.currentPair) return;
      const finalTarget = evt.transcript || session.currentTurnTarget || "";
      const finalSource = session.currentTurnSource || currentSourceText || "";
      const ts = session.currentTurnStartTs || Date.now();
      setPairTarget(session.currentPair, finalTarget, session.targetLanguage);
      setPairSource(session.currentPair, finalSource);
      commitPair(session.currentPair, new Date(ts).toTimeString().slice(0, 5));
      pushHistoryTurn({
        source: finalSource,
        target: finalTarget,
        ts,
        lang: session.targetLanguage,
        voice: session.realtimeVoice,
        tier: "realtime",
      });
      session.currentPair = null;
      session.currentTurnTarget = "";
      session.currentTurnSource = "";
      return;
    }
  }

  function computeGain(voiceVolume) {
    return voiceVolume === 0 ? 0 : (voiceVolume / 100) * VOICE_GAIN_MAX;
  }

  function applyVolumes(originalVolume, voiceVolume) {
    if (videoEl) {
      videoEl.volume = (originalVolume ?? 18) / 100;
      videoEl.muted = (originalVolume ?? 0) === 0;
    }
    if (session?.outputGain) {
      session.outputGain.gain.value = computeGain(voiceVolume ?? 100);
    } else if (session?.remoteAudio) {
      session.remoteAudio.volume = Math.min((voiceVolume ?? 100) / 100, 1.0);
      session.remoteAudio.muted = voiceVolume === 0;
    }
  }

  // ───── F4 — Voice / language handover (zero-gap) ──────────────────────────
  async function requestHandover(partial) {
    if (!session) return;
    const newSettings = { ...settings, ...partial };
    const same =
      newSettings.targetLanguage === session.targetLanguage &&
      (newSettings.realtimeVoice || "") === (session.realtimeVoice || "");
    if (same) return;

    const fromLang = langName(session.targetLanguage);
    const toLang = langName(newSettings.targetLanguage);
    if (newSettings.targetLanguage !== session.targetLanguage) {
      pushHistoryTurn({ marker: `${fromLang} → ${toLang}` });
      setStatusText(t("statusSwitchLang", [toLang]));
    } else {
      pushHistoryTurn({ marker: t("statusSwitchVoice") });
      setStatusText(t("statusSwitchVoice"));
    }
    setOverlayState("connecting");

    const newToken = ++pageToken;
    settings = newSettings;
    notifyBackground({ type: "UPDATE_SETTINGS", settings: newSettings });
    if (elements.langSelect) elements.langSelect.value = newSettings.targetLanguage;
    if (elements.voiceSelect) elements.voiceSelect.value = newSettings.realtimeVoice || "";

    let newSession;
    try {
      newSession = await buildRealtimeSession(newToken, session.stream, {
        kymaKey: settings.kymaKey,
        targetLanguage: newSettings.targetLanguage,
        realtimeVoice: newSettings.realtimeVoice,
      });
      if (newToken !== pageToken) {
        try { newSession.pc.close(); } catch {}
        return;
      }
    } catch (err) {
      if (newToken !== pageToken) return;
      setStatusText(t("errSwitchFailed"));
      setOverlayState("live");
      showToast(err.message, { cta: err.cta, ctaLabel: err.ctaLabel }, 9000);
      return;
    }

    prevSession = session;
    session = newSession;
    setStatusText(t("statusTranslating"));
    setOverlayState("live");

    setTimeout(() => {
      if (prevSession) {
        try {
          if (prevSession.remoteAudio) {
            prevSession.remoteAudio.pause();
            prevSession.remoteAudio.srcObject = null;
            prevSession.remoteAudio.remove();
          }
          if (prevSession.outputGain) prevSession.outputGain.disconnect();
          if (prevSession.audioCtx) prevSession.audioCtx.close();
          prevSession.pc?.close();
        } catch {}
        void endKymaSession(prevSession.kymaSessionId, prevSession.kymaKey);
        prevSession = null;
      }
    }, 400);

    startHeartbeat(newSession.kymaSessionId, newSession.kymaKey);
    applyVolumes(settings.originalVolume, settings.voiceVolume);
  }

  // ───── Standard tier (chunked: whisper → gemini → minimax) ────────────────
  async function startStandardSession() {
    const video = findVideo();
    if (!video) return { ok: false, error: "errNoVideo" };
    videoEl = video;

    let stream;
    try {
      buildOverlay();
      setStatusText(t("statusAcquiringAudio"));
      stream = await captureWithRetry(video);
    } catch (err) {
      removeOverlay();
      return { ok: false, error: errorToI18n(err) };
    }

    const recorderMime = pickRecorderMime();
    if (!recorderMime) {
      stream.getTracks().forEach((t) => t.stop());
      removeOverlay();
      return { ok: false, error: "errBrowserNoRecord" };
    }

    let audioCtx;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      removeOverlay();
      return { ok: false, error: { key: "errAudioContext", subs: [err.message || String(err)] } };
    }
    const outputGain = audioCtx.createGain();
    outputGain.gain.value = computeGain(settings.voiceVolume ?? 100);
    outputGain.connect(audioCtx.destination);

    const token = ++pageToken;
    const newSession = {
      token,
      type: "standard",
      stream,
      audioCtx,
      outputGain,
      remoteAudio: null,
      pc: null,
      dc: null,
      kymaSessionId: null,
      kymaKey: settings.kymaKey,
      recorderMime,
      activeRecorder: null,
      nextPlayAt: 0,
      stopFlag: false,
      abortController: new AbortController(),
    };
    session = newSession;

    setStatusText(t("statusTranslating"));
    setOverlayState("live");
    startSessionTimer();
    applyVolumes(settings.originalVolume, settings.voiceVolume);
    applySourceVisibility();
    startCaptionPoll();
    startAdWatcher();

    onYTPause = () => {
      if (isAdPlaying) return;  // ad-induced pause already handled by watcher
      setStatusText(t("statusPaused"));
      setOverlayState("paused");
      emitState({ paused: true, status: "statusPaused" });
    };
    onYTPlay = () => {
      if (isAdPlaying) return;
      setStatusText(t("statusTranslating"));
      setOverlayState("live");
      emitState({ paused: false, status: "statusTranslating" });
    };
    onVideoEnded = () => {
      // Don't tear down — wait for user / autoplay. SPA nav handler will
      // restart automatically if URL changes.
      setStatusText(t("statusVideoEnded"));
      setOverlayState("paused");
      emitState({ paused: true, status: "statusVideoEnded" });
    };
    video.addEventListener("pause", onYTPause);
    video.addEventListener("play", onYTPlay);
    video.addEventListener("ended", onVideoEnded);

    runChunkLoop(newSession);
    emitState({ running: true, paused: false, status: "statusTranslating" });
    return { ok: true };
  }

  function pickRecorderMime() {
    if (typeof MediaRecorder === "undefined") return "";
    for (const m of STANDARD_RECORDER_MIMES) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
    }
    return "";
  }

  async function webmBlobToWav(blob, sharedCtx) {
    const arrayBuf = await blob.arrayBuffer();
    let ownCtx;
    let ctx = sharedCtx;
    if (!ctx) {
      ownCtx = new (window.AudioContext || window.webkitAudioContext)();
      ctx = ownCtx;
    }
    let audioBuf;
    try {
      audioBuf = await ctx.decodeAudioData(arrayBuf);
    } finally {
      if (ownCtx) ownCtx.close().catch(() => {});
    }
    return audioBufferToWavBlob(audioBuf);
  }

  function audioBufferToWavBlob(audioBuf) {
    const targetRate = 16000;
    const monoSamples = downmixAndResample(audioBuf, targetRate);
    const dataSize = monoSamples.length * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    let p = 0;
    function wstr(s) { for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i)); }
    function w32(n) { view.setUint32(p, n, true); p += 4; }
    function w16(n) { view.setUint16(p, n, true); p += 2; }
    wstr("RIFF"); w32(36 + dataSize); wstr("WAVE");
    wstr("fmt "); w32(16); w16(1); w16(1); w32(targetRate);
    w32(targetRate * 2); w16(2); w16(16);
    wstr("data"); w32(dataSize);
    for (let i = 0; i < monoSamples.length; i++) {
      const s = Math.max(-1, Math.min(1, monoSamples[i]));
      view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      p += 2;
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  function downmixAndResample(audioBuf, targetRate) {
    const srcRate = audioBuf.sampleRate;
    const channels = audioBuf.numberOfChannels;
    const srcLen = audioBuf.length;
    const mono = new Float32Array(srcLen);
    for (let ch = 0; ch < channels; ch++) {
      const data = audioBuf.getChannelData(ch);
      for (let i = 0; i < srcLen; i++) mono[i] += data[i];
    }
    if (channels > 1) for (let i = 0; i < srcLen; i++) mono[i] /= channels;
    if (srcRate === targetRate) return mono;
    const ratio = srcRate / targetRate;
    const outLen = Math.floor(srcLen / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const src = i * ratio;
      const i0 = Math.floor(src);
      const i1 = Math.min(i0 + 1, srcLen - 1);
      const f = src - i0;
      out[i] = mono[i0] * (1 - f) + mono[i1] * f;
    }
    return out;
  }

  function runChunkLoop(s) {
    const cycle = () => {
      if (s !== session || s.stopFlag) return;
      // Skip recording while video paused OR ad playing — captureStream
      // emits silence/ad-audio; processing would burn credits for nothing.
      if (videoEl?.paused || s.adPaused) {
        setTimeout(cycle, 400);
        return;
      }
      let recorder;
      try {
        recorder = new MediaRecorder(s.stream, { mimeType: s.recorderMime });
      } catch {
        try { recorder = new MediaRecorder(s.stream); } catch {
          setTimeout(cycle, 1000);
          return;
        }
      }
      s.activeRecorder = recorder;
      const parts = [];
      recorder.addEventListener("dataavailable", (e) => {
        if (e.data && e.data.size > 0) parts.push(e.data);
      });
      recorder.addEventListener("stop", () => {
        if (s !== session || s.stopFlag) return;
        if (parts.length) {
          const blob = new Blob(parts, { type: s.recorderMime });
          // Capture START timestamp at recorder.start() time, NOT here at stop,
          // so multiple in-flight chunks can be sorted chronologically by
          // when their audio actually started — not by which one finished its
          // pipeline first.
          processStandardChunk(s, blob, chunkStartedAt).catch(() => {});
        }
        cycle();
      });
      let chunkStartedAt = Date.now();
      try { recorder.start(); chunkStartedAt = Date.now(); } catch {
        setTimeout(cycle, 1000);
        return;
      }
      setTimeout(() => {
        try { if (recorder.state !== "inactive") recorder.stop(); } catch {}
      }, STANDARD_CHUNK_MS);
    };
    cycle();
  }

  // processStandardChunk owns its own pair element so concurrent chunks
  // can't overwrite each other's source/target text. Pair is created early
  // (after blob check) so the user sees a "pending" row appear immediately,
  // updated as Whisper → Gemini → TTS finish, and committed atomically.
  // On any failure, the pair is dropped so dead rows don't pile up.
  async function processStandardChunk(s, blob, chunkStartedAt) {
    if (s !== session || s.token !== pageToken) return;
    if (s.adPaused) return;
    if (blob.size < STANDARD_MIN_CHUNK_BYTES) return;
    const tk = s.token;
    const lang = settings.targetLanguage || "vi";
    const targetLangName = langName(lang);
    const voiceId = settings.standardVoice || STANDARD_DEFAULT_VOICE;
    const kymaKey = s.kymaKey;
    const ts = chunkStartedAt || Date.now();

    let wavBlob;
    try {
      wavBlob = await webmBlobToWav(blob, s.audioCtx);
    } catch {
      return;
    }
    if (s !== session || s.token !== tk) return;

    // Reserve this chunk's row in the compare grid NOW. Both cells visible
    // as "pending" while pipeline runs — gives feedback the chunk is live.
    const pair = createPendingPair();
    const fd = new FormData();
    fd.append("file", wavBlob, "chunk.wav");
    fd.append("model", "whisper-v3-turbo");
    fd.append("response_format", "json");
    let trResp;
    try {
      trResp = await fetch(`${KYMA_BASE}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: "Bearer " + kymaKey },
        body: fd,
        signal: s.abortController.signal,
      });
    } catch {
      dropPair(pair);
      return;
    }
    if (s !== session || s.token !== tk) { dropPair(pair); return; }
    if (!trResp.ok) {
      const txt = await trResp.text().catch(() => "");
      const parsed = parseKymaError(trResp.status, txt);
      showStandardError(parsed);
      dropPair(pair);
      return;
    }
    const tr = await trResp.json().catch(() => ({}));
    const sourceText = String(tr.text || "").trim();
    if (!sourceText || sourceText.length < 2) { dropPair(pair); return; }
    // Update THIS chunk's source cell — global currentSourceText kept in
    // sync only as a hint for live banner reuse, NOT as commit source.
    currentSourceText = sourceText;
    setLiveCaption(sourceText);
    setPairSource(pair, sourceText);
    if (elements.source && settings.showSource) {
      elements.source.textContent = sourceText.slice(-220);
    }

    let tlResp;
    try {
      tlResp = await fetch(`${KYMA_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + kymaKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gemini-2.5-flash",
          messages: [
            {
              role: "system",
              content: `You are a live dubbing translator. Translate the user's sentence into ${targetLangName}. Output ONLY the translation. No quotes, no commentary, no explanation, no labels. Preserve names, brand names, and technical terms verbatim.`,
            },
            { role: "user", content: sourceText },
          ],
          temperature: 0.2,
        }),
        signal: s.abortController.signal,
      });
    } catch {
      dropPair(pair);
      return;
    }
    if (s !== session || s.token !== tk) { dropPair(pair); return; }
    if (!tlResp.ok) {
      const txt = await tlResp.text().catch(() => "");
      const parsed = parseKymaError(tlResp.status, txt);
      showStandardError(parsed);
      dropPair(pair);
      return;
    }
    const tl = await tlResp.json().catch(() => ({}));
    const targetText = String(tl?.choices?.[0]?.message?.content || "").trim();
    if (!targetText) { dropPair(pair); return; }
    setPairTarget(pair, targetText, lang);
    setOverlayState("live");

    let ttsResp;
    try {
      ttsResp = await fetch(`${KYMA_BASE}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + kymaKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "minimax-speech-turbo",
          input: targetText,    // ← exact same string sent to TTS as displayed
          voice_id: voiceId,
          response_format: "mp3",
        }),
        signal: s.abortController.signal,
      });
    } catch {
      // Display still has the translation; mark pair committed even though
      // audio dub failed (text-only fallback so user sees what was translated).
      commitPair(pair, new Date(ts).toTimeString().slice(0, 5));
      pushHistoryTurn({ source: sourceText, target: targetText, ts, lang, voice: voiceId, tier: "standard" });
      return;
    }
    if (s !== session || s.token !== tk) { dropPair(pair); return; }
    if (!ttsResp.ok) {
      const txt = await ttsResp.text().catch(() => "");
      const parsed = parseKymaError(ttsResp.status, txt);
      showStandardError(parsed);
      commitPair(pair, new Date(ts).toTimeString().slice(0, 5));
      pushHistoryTurn({ source: sourceText, target: targetText, ts, lang, voice: voiceId, tier: "standard" });
      return;
    }
    const arrayBuf = await ttsResp.arrayBuffer();
    if (s !== session || s.token !== tk) { dropPair(pair); return; }

    let audioBuf;
    try {
      audioBuf = await s.audioCtx.decodeAudioData(arrayBuf);
    } catch {
      commitPair(pair, new Date(ts).toTimeString().slice(0, 5));
      pushHistoryTurn({ source: sourceText, target: targetText, ts, lang, voice: voiceId, tier: "standard" });
      return;
    }
    if (s !== session || s.token !== tk) { dropPair(pair); return; }

    if (s.nextPlayAt < s.audioCtx.currentTime) s.nextPlayAt = 0;
    const startAt = Math.max(s.audioCtx.currentTime + 0.05, s.nextPlayAt);
    const src = s.audioCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(s.outputGain);
    try { src.start(startAt); } catch {}
    s.nextPlayAt = startAt + audioBuf.duration;

    // Commit AFTER audio scheduled so visual + audio land at roughly the
    // same moment. Pair stays in DOM at its created position; just toggles
    // class + appends time meta.
    commitPair(pair, new Date(ts).toTimeString().slice(0, 5));
    pushHistoryTurn({
      source: sourceText,
      target: targetText,
      ts,
      lang,
      voice: voiceId,
      tier: "standard",
    });
  }

  function showStandardError(parsed) {
    setStatusText(parsed.text || t("statusPipelineError"));
    showToast(parsed.text, { cta: parsed.cta, ctaLabel: parsed.ctaLabel }, 6000);
  }

  // ───── Start session (token-bumped on each call) ──────────────────────────
  async function startSession(incomingSettings) {
    if (session) return { ok: false, error: "errSessionRunning" };
    settings = { ...incomingSettings };
    history = [];
    currentTargetText = "";
    currentSourceText = "";
    // Load user-chosen UI language BEFORE buildOverlay paints labels — avoids
    // a flash of Chrome-default locale on first frame.
    if (settings.uiLanguage && settings.uiLanguage !== "auto") {
      await loadManualMessages(settings.uiLanguage);
    } else {
      manualMessages = null;
    }
    clearCompareGrid();
    setLiveCaption("");

    if (settings.tier === "standard") {
      return startStandardSession();
    }
    if (settings.tier !== "realtime") {
      return { ok: false, error: { key: "errUnknownTier", subs: [String(settings.tier)] } };
    }

    const video = findVideo();
    if (!video) return { ok: false, error: "errNoVideo" };
    videoEl = video;

    let stream;
    try {
      buildOverlay();
      setStatusText(t("statusAcquiringAudio"));
      stream = await captureWithRetry(video);
    } catch (err) {
      removeOverlay();
      return { ok: false, error: errorToI18n(err) };
    }

    const token = ++pageToken;
    let newSession;
    try {
      newSession = await buildRealtimeSession(token, stream, {
        kymaKey: settings.kymaKey,
        targetLanguage: settings.targetLanguage,
        realtimeVoice: settings.realtimeVoice,
      });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      removeOverlay();
      return { ok: false, error: errorToI18n(err) };
    }
    if (token !== pageToken) {
      try { newSession.pc.close(); } catch {}
      removeOverlay();
      return { ok: false, error: "errCancelledBeforeConnect" };
    }

    session = newSession;
    setStatusText(t("statusTranslating"));
    setOverlayState("live");
    startHeartbeat(session.kymaSessionId, session.kymaKey);
    startSessionTimer();
    applyVolumes(settings.originalVolume, settings.voiceVolume);
    applySourceVisibility();
    startCaptionPoll();
    startAdWatcher();

    onYTPause = () => {
      if (isAdPlaying) return;
      setStatusText(t("statusPaused"));
      setOverlayState("paused");
      emitState({ paused: true, status: "statusPaused" });
    };
    onYTPlay = () => {
      if (isAdPlaying) return;
      setStatusText(t("statusTranslating"));
      setOverlayState("live");
      emitState({ paused: false, status: "statusTranslating" });
    };
    onVideoEnded = () => {
      setStatusText(t("statusVideoEnded"));
      setOverlayState("paused");
      emitState({ paused: true, status: "statusVideoEnded" });
    };
    video.addEventListener("pause", onYTPause);
    video.addEventListener("play", onYTPlay);
    video.addEventListener("ended", onVideoEnded);

    emitState({ running: true, paused: false, status: "statusTranslating" });
    return { ok: true };
  }

  function stopSession(reason = "stop") {
    pageToken += 1;
    clearSessionTimer();
    stopHeartbeat();
    stopCaptionPoll();
    stopAdWatcher();
    if (videoEl) {
      if (onYTPause) videoEl.removeEventListener("pause", onYTPause);
      if (onYTPlay) videoEl.removeEventListener("play", onYTPlay);
      if (onVideoEnded) videoEl.removeEventListener("ended", onVideoEnded);
      videoEl.muted = false;
      videoEl.volume = 1.0;
      videoEl = null;
    }
    onYTPause = null;
    onYTPlay = null;
    onVideoEnded = null;
    if (session) {
      try {
        if (session.type === "standard") {
          session.stopFlag = true;
          if (session.abortController) {
            try { session.abortController.abort(); } catch {}
          }
          if (session.activeRecorder && session.activeRecorder.state !== "inactive") {
            try { session.activeRecorder.stop(); } catch {}
          }
        }
        if (session.remoteAudio) {
          session.remoteAudio.pause();
          session.remoteAudio.srcObject = null;
          session.remoteAudio.remove();
        }
        if (session.outputGain) session.outputGain.disconnect();
        if (session.audioCtx) session.audioCtx.close();
        if (session.dc) session.dc.close();
        if (session.pc) session.pc.close();
        if (session.stream) session.stream.getTracks().forEach((t) => t.stop());
      } catch {}
      if (session.kymaSessionId) {
        void endKymaSession(session.kymaSessionId, session.kymaKey);
      }
      session = null;
    }
    if (prevSession) {
      try { prevSession.pc?.close(); } catch {}
      void endKymaSession(prevSession.kymaSessionId, prevSession.kymaKey);
      prevSession = null;
    }
    clearAllPendingPairs();
    history = [];
    currentTargetText = "";
    currentSourceText = "";
    removeOverlay();
  }

  function applySettingsLive(newSettings) {
    const prev = settings || {};
    settings = { ...prev, ...newSettings };
    // UI language change → reload messages and re-text every overlay label
    // in place. No need to rebuild the DOM (preserves scroll position +
    // any in-flight pair cells the user is reading).
    if ("uiLanguage" in newSettings && newSettings.uiLanguage !== prev.uiLanguage) {
      void loadManualMessages(newSettings.uiLanguage === "auto" ? null : newSettings.uiLanguage)
        .then(() => refreshOverlayLabels());
    }
    if ("tier" in newSettings && newSettings.tier !== prev.tier && session) {
      showToast(t("tierLockToast"), 5000);
    }
    if (elements.langSelect && newSettings.targetLanguage) {
      elements.langSelect.value = newSettings.targetLanguage;
    }
    if (elements.voiceSelect &&
        (newSettings.realtimeVoice !== undefined || newSettings.standardVoice !== undefined)) {
      const tier = settings.tier || "standard";
      populateVoicePicker(tier);
    }
    if ("showSource" in newSettings) {
      applySourceVisibility();
      if (settings.showSource && session) startCaptionPoll();
      else stopCaptionPoll();
    }
    if (session?.type !== "standard") {
      if (("targetLanguage" in newSettings && newSettings.targetLanguage !== prev.targetLanguage) ||
          ("realtimeVoice" in newSettings && newSettings.realtimeVoice !== prev.realtimeVoice)) {
        void requestHandover(newSettings);
      }
    }
    if ("originalVolume" in newSettings || "voiceVolume" in newSettings) {
      applyVolumes(settings.originalVolume, settings.voiceVolume);
    }
  }

  // ───── SPA navigation handling ────────────────────────────────────────────
  // YT autoplays the next video by replacing the <video> element and changing
  // location.href via History API (no full page reload). We auto-restart the
  // session on the new video using the same settings, so playlists/autoplay
  // chains keep translating without the user re-clicking Start.
  let isAutoRestarting = false;
  setInterval(async () => {
    if (location.href === lastSpaUrl) return;
    const newUrl = location.href;
    lastSpaUrl = newUrl;
    if (!session || isAutoRestarting) return;

    if (/\/watch\?v=/.test(newUrl)) {
      // YT video → video transition. Tear down on old <video>, wait for new
      // one to be playable, then restart with the same settings.
      isAutoRestarting = true;
      const savedSettings = { ...settings };
      stopSession("yt-navigation-restart");
      const newVideo = await waitForNewVideo(4000);
      if (!newVideo) {
        emitEnded("ytNavigated");
        isAutoRestarting = false;
        return;
      }
      const result = await startSession(savedSettings);
      isAutoRestarting = false;
      if (result?.ok) {
        showToast(t("autoRestarted"), 3000);
      } else {
        emitEnded(typeof result?.error === "string" ? result.error : "ytNavigated");
      }
    } else {
      // Navigated off /watch (homepage, channel page, external) — stop cleanly.
      stopSession("yt-navigation");
      emitEnded("ytNavigated");
    }
  }, 500);

  // ───── Tab unload — fire /end with keepalive ──────────────────────────────
  const handleUnload = () => {
    if (session) {
      void endKymaSession(session.kymaSessionId, session.kymaKey);
    }
  };
  window.addEventListener("beforeunload", handleUnload);
  window.addEventListener("pagehide", handleUnload);

  // ───── Background message router ──────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      switch (msg?.type) {
        case "CONTENT_PING":
          sendResponse({ ok: true, version: YOUNOTE_VERSION });
          break;
        case "CONTENT_START":
          sendResponse(await startSession(msg.settings || {}));
          break;
        case "CONTENT_STOP":
          stopSession("backend-stop");
          sendResponse({ ok: true });
          break;
        case "CONTENT_UPDATE_SETTINGS":
          applySettingsLive(msg.settings || {});
          sendResponse({ ok: true });
          break;
        case "CONTENT_UPDATE_VOLUME":
          settings = { ...(settings || {}), originalVolume: msg.originalVolume, voiceVolume: msg.voiceVolume };
          applyVolumes(msg.originalVolume, msg.voiceVolume);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: { key: "errUnknownMessage", subs: [String(msg?.type)] } });
      }
    })();
    return true;
  });
})();
