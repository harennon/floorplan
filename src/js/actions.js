/**
 * actions.js — persistence/share actions cluster wiring
 *
 * Wires Share / Export / Overflow / Toasts / Banner to the underlying modules.
 * Called once from main.js after all other modules are initialised.
 */

import { buildPlan } from "./plan.js";
import { encodePlanToHash } from "./share.js";
import { exportSvg, exportPng } from "./exportImg.js";
import { exportJson, importJson, setToastCallback } from "./exportJson.js";
import { clearLocal, saveNow } from "./store.js";
import { hydrate as hydrateWalls } from "./walls.js";
import { hydrate as hydrateSymbols } from "./symbols.js";
import { resetView } from "./view.js";
import { render, onRender } from "./surface.js";
import * as surface from "./surface.js";
import { setPlanName, getPlanName } from "./planName.js";

// history is wired in after init() via setHistoryReset()
let _historyReset = null;

/**
 * Inject the history.reset function from main.js so _confirmReset can call
 * it without creating a circular import.
 * @param {()=>void} fn
 */
export function setHistoryReset(fn) {
  _historyReset = fn;
}

// openTemplates callback injected from main.js
let _openTemplates = null;

/**
 * Inject the "open template gallery" callback from main.js.
 * @param {()=>void} fn
 */
export function setOpenTemplates(fn) {
  _openTemplates = fn;
}

/** Cached encoded hash for synchronous clipboard copy (Safari user-activation). */
let _cachedHashUrl = null;

/**
 * Whether the cache is known stale (set on every render, cleared when cache is rebuilt).
 * We use this to avoid the 100ms warmup timer approach — instead we hook into onRender
 * and invalidate immediately so the cache always reflects the latest plan.
 */
let _cacheStale = true;

/** DOM refs, set by init(). */
let _btnShare        = null;
let _btnExport       = null;
let _btnOverflow     = null;
let _exportMenuEl    = null;
let _overflowMenuEl  = null;
let _toastEl         = null;
let _bannerEl        = null;
let _toastTimer      = null;
const TOAST_DURATION_MS = 3500;

// Share dialog refs + state (LLD-166), set by init().
let _shareDialogEl   = null;  // #share-dialog (scrim + panel)
let _shareUrlField   = null;  // #share-url-field (readonly input)
let _shareCopyBtn    = null;  // #share-copy-btn
let _shareDialogClose= null;  // .share-dialog-close
let _shareWarningEl  = null;  // #share-url-warning
let _shareDialogOpen = false; // gates the Esc/outside-click handlers

// URL length soft threshold (Edge Case 7)
const URL_SOFT_LIMIT = 8000;

/**
 * Init the actions cluster.
 * @param {{
 *   btnShare: HTMLElement,
 *   btnExport: HTMLElement,
 *   btnOverflow: HTMLElement,
 *   exportMenu: HTMLElement,
 *   overflowMenu: HTMLElement,
 *   toast: HTMLElement,
 *   banner: HTMLElement,
 *   shareDialog?: HTMLElement,
 *   shareUrlField?: HTMLElement,
 *   shareCopyBtn?: HTMLElement,
 *   shareDialogClose?: HTMLElement,
 *   shareWarning?: HTMLElement,
 * }} els
 */
export function init(els) {
  _btnShare       = els.btnShare;
  _btnExport      = els.btnExport;
  _btnOverflow    = els.btnOverflow;
  _exportMenuEl   = els.exportMenu;
  _overflowMenuEl = els.overflowMenu;
  _toastEl        = els.toast;
  _bannerEl       = els.banner;

  // Share dialog refs (LLD-166)
  _shareDialogEl    = els.shareDialog;
  _shareUrlField    = els.shareUrlField;
  _shareCopyBtn     = els.shareCopyBtn;
  _shareDialogClose = els.shareDialogClose;
  _shareWarningEl   = els.shareWarning;

  // Give exportJson our toast callback
  setToastCallback(showToast);

  // Invalidate hash cache on every render so Share always reflects the current plan.
  // The cache is rebuilt asynchronously in the background after each invalidation
  // so that the next Share click is usually served synchronously (Safari activation-safe).
  onRender(_onRenderInvalidateCache);

  // ── Share button ────────────────────────────────────────────────────────────
  _btnShare?.addEventListener("click", _onShare);

  // ── Share dialog (LLD-166) — desktop copy-URL surface ────────────────────────
  _shareCopyBtn?.addEventListener("click", () => _copyUrl(_shareUrlField.value));
  _shareDialogClose?.addEventListener("click", _closeShareDialog);
  // Capture-phase Esc: close before the bubble-phase wall/measure Esc listeners
  // (mirrors templates.js._onKey — NO active-element guard, since the dialog
  // auto-focuses the readonly URL input).
  window.addEventListener("keydown", _onShareDialogKey, true /* capture */);
  // Outside-click dismissal (bubble phase on document).
  document.addEventListener("click", _onShareDialogDocClick);

  // ── Export menu button ──────────────────────────────────────────────────────
  _btnExport?.addEventListener("click", (e) => {
    e.stopPropagation();
    _toggleMenu(_exportMenuEl);
    if (_overflowMenuEl) _overflowMenuEl.classList.remove("menu--open");
  });

  // Export menu items
  _exportMenuEl?.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", _onExportAction);
  });

  // ── Overflow menu button ────────────────────────────────────────────────────
  _btnOverflow?.addEventListener("click", (e) => {
    e.stopPropagation();
    _toggleMenu(_overflowMenuEl);
    if (_exportMenuEl) _exportMenuEl.classList.remove("menu--open");
  });

  // Overflow menu items
  _overflowMenuEl?.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", _onOverflowAction);
  });

  // Close menus on outside click
  document.addEventListener("click", () => {
    _exportMenuEl?.classList.remove("menu--open");
    _overflowMenuEl?.classList.remove("menu--open");
  });

  // Pre-warm the hash cache immediately (async, non-blocking)
  _rebuildCacheAsync();
}

/**
 * Show a transient toast message with an optional one-tap action button.
 * Backward compatible — existing single-arg callers continue to work.
 * @param {string} msg
 * @param {{ label:string, onClick:()=>void }} [action]  optional one-tap button
 */
export function showToast(msg, action) {
  if (!_toastEl) return;
  // Build content: always pointer-events:none on the toast itself, but we
  // need it to accept clicks when an action button is present. We toggle
  // pointer-events inline so the base CSS rule still hides the resting toast.
  if (action) {
    // Render a text span + an action button
    _toastEl.innerHTML = "";
    const textNode = document.createElement("span");
    textNode.textContent = msg;
    const btn = document.createElement("button");
    btn.className = "toast-action-btn";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      action.onClick();
      // Dismiss immediately on tap
      _toastEl.classList.remove("toast--visible");
      _toastEl.style.pointerEvents = "";
      if (_toastTimer) clearTimeout(_toastTimer);
    });
    _toastEl.appendChild(textNode);
    _toastEl.appendChild(btn);
    _toastEl.style.pointerEvents = "auto";
  } else {
    _toastEl.innerHTML = "";
    _toastEl.textContent = msg;
    _toastEl.style.pointerEvents = "";
  }
  _toastEl.classList.add("toast--visible");
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    if (_toastEl) {
      _toastEl.classList.remove("toast--visible");
      _toastEl.style.pointerEvents = "";
    }
  }, TOAST_DURATION_MS);
}

/**
 * Show the restore-conflict banner with "Open shared" and "Keep mine" choices.
 * @param {import("./plan.js").Plan} hashPlan
 * @param {import("./plan.js").Plan} localPlan
 * @param {(choice:"shared"|"local")=>void} onChoice
 */
export function showConflictBanner(hashPlan, localPlan, onChoice) {
  if (!_bannerEl) {
    // No banner element: favor explicit share intent (a hash was present), never
    // silently discard the shared plan in favor of background autosave.
    onChoice("shared");
    return;
  }

  _bannerEl.classList.add("banner--visible");

  const btnOpen = _bannerEl.querySelector("[data-banner-action='open-shared']");
  const btnKeep = _bannerEl.querySelector("[data-banner-action='keep-mine']");

  const _dismiss = (choice) => {
    _bannerEl.classList.remove("banner--visible");
    onChoice(choice);
  };

  if (btnOpen) {
    const newBtn = btnOpen.cloneNode(true); // remove old listeners
    btnOpen.parentNode.replaceChild(newBtn, btnOpen);
    newBtn.addEventListener("click", () => _dismiss("shared"));
  }

  if (btnKeep) {
    const newBtn = btnKeep.cloneNode(true);
    btnKeep.parentNode.replaceChild(newBtn, btnKeep);
    newBtn.addEventListener("click", () => _dismiss("local"));
  }
}

// ── Private: share ────────────────────────────────────────────────────────────

/**
 * Synchronous click dispatcher. Must NOT be async so the user-activation
 * gesture is still live when navigator.share() is called (iOS/Safari
 * requirement). Routes to native share sheet when available and cache is
 * fresh; otherwise falls through to the clipboard path.
 */
function _onShare() {
  if (navigator.share && _cachedHashUrl && !_cacheStale) {
    // Native path: URL is available synchronously — activation preserved.
    _nativeShare(_cachedHashUrl);
  } else {
    // Clipboard path: either no native share API, or cache is stale.
    _shareViaClipboard();
  }
}

/**
 * Native OS share sheet path. Called ONLY when the cache is fresh so that
 * navigator.share() fires inside the user-activation task.
 * @param {string} url
 */
function _nativeShare(url) {
  if (url.length > URL_SOFT_LIMIT) {
    showToast("Note: very large plans may not work in all chat apps. Try PNG/JSON export instead.");
  }
  navigator.share({ title: _shareTitle(), url }).catch((err) => {
    if (err?.name === "AbortError") return; // user cancelled — silent
    // Any other error (NotAllowedError, InvalidStateError, etc.) → clipboard fallback
    _copyUrl(url);
  });
}

/**
 * Short human-readable title for the native share sheet.
 * @returns {string}
 */
function _shareTitle() {
  const name = getPlanName();
  return name ? `Floor plan: ${name}` : "My floor plan";
}

/**
 * Fallback path (no fresh native share). Resolves the URL exactly as before,
 * then branches on navigator.share presence (LLD-166):
 *   - navigator.share ABSENT (desktop) → open the copy-URL dialog.
 *   - navigator.share PRESENT (mobile stale-cache fall-through) → _copyUrl
 *     (silent copy + toast), preserving LLD-165 behavior exactly.
 * Safe to be async because this path does not need the user-activation gesture
 * (clipboard write is not activation-gated in the same way, and the manual Copy
 * click inside the dialog is itself a fresh gesture).
 */
async function _shareViaClipboard() {
  // Resolve the URL first. Prefer the synchronous cached URL when it is fresh;
  // the cache is invalidated on every render (via the onRender hook) and rebuilt
  // asynchronously in the background, so _cachedHashUrl is current as long as the
  // plan has not changed since the last background rebuild.
  let url;
  if (_cachedHashUrl && !_cacheStale) {
    url = _cachedHashUrl;
  } else {
    // Async path: compute now (cache was stale or not yet built)
    try {
      url = await _buildAndCacheUrl();
    } catch {
      showToast("Couldn't build share link");
      return;
    }
  }

  if (navigator.share) {
    // Mobile stale-cache fall-through — unchanged LLD-165 behavior. Must NOT
    // open the desktop dialog (would hijack a share-capable device).
    _copyUrl(url);
  } else {
    // Desktop — no native share API. Surface the URL in the dialog.
    _openShareDialog(url);
  }
}

// ── Private: share dialog (LLD-166) ─────────────────────────────────────────────

/**
 * Populate + show the share dialog for a resolved URL string. Idempotent:
 * re-populates and re-adds the visible class on repeat opens.
 * @param {string} url
 */
function _openShareDialog(url) {
  if (!_shareDialogEl || !_shareUrlField) {
    // No dialog markup (defensive) — fall back to the old silent copy.
    _copyUrl(url);
    return;
  }
  _shareUrlField.value = url;
  if (_shareWarningEl) _shareWarningEl.hidden = url.length <= URL_SOFT_LIMIT;
  _shareDialogEl.classList.add("share-dialog--visible");
  _shareDialogOpen = true;
  // Focus + select after the overlay becomes visible (mirrors templates.js).
  setTimeout(() => {
    _shareUrlField.focus();
    _shareUrlField.select();
  }, 0);
}

/** Hide the dialog and restore focus to #btn-share. */
function _closeShareDialog() {
  if (_shareDialogEl) _shareDialogEl.classList.remove("share-dialog--visible");
  _shareDialogOpen = false;
  _btnShare?.focus();
}

/**
 * Capture-phase keydown handler for the dialog. Mirrors templates.js._onKey:
 * Esc closes + stops propagation so it never reaches the bubble-phase
 * wall/measure Esc listeners. Intentionally has NO active-element/input guard
 * (unlike help.js) because the dialog auto-focuses the readonly URL input —
 * such a guard would swallow Esc and leave the dialog stuck open.
 */
function _onShareDialogKey(e) {
  if (e.key === "Escape" && _shareDialogOpen) {
    e.stopPropagation();
    e.preventDefault();
    _closeShareDialog();
  }
}

/**
 * Document-level click handler: close when clicking outside the panel. Clicks
 * inside the panel do not close; clicks on #btn-share do not close here (its own
 * listener runs). Mirrors templates.js._onDocumentClick.
 */
function _onShareDialogDocClick(e) {
  if (!_shareDialogOpen) return;
  const panel = _shareDialogEl?.querySelector(".share-dialog-panel");
  if (panel && panel.contains(/** @type {Node} */ (e.target))) return;
  if (_btnShare && _btnShare.contains(/** @type {Node} */ (e.target))) return;
  _closeShareDialog();
}

function _copyUrl(url) {
  if (url.length > URL_SOFT_LIMIT) {
    showToast("Link copied — note: very large plans may not work in all chat apps. Try PNG/JSON export instead.");
  }

  // Try async clipboard API first
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(
      () => { if (url.length <= URL_SOFT_LIMIT) showToast("Link copied"); },
      () => _fallbackCopy(url)
    );
  } else {
    _fallbackCopy(url);
  }
}

function _fallbackCopy(url) {
  // Create a transient input, select all, copy
  const input = document.createElement("input");
  input.type = "text";
  input.value = url;
  input.style.position = "fixed";
  input.style.left = "-9999px";
  input.style.top = "-9999px";
  input.setAttribute("aria-hidden", "true");
  document.body.appendChild(input);
  input.focus();
  input.select();
  try {
    document.execCommand("copy");
    showToast("Link copied");
  } catch {
    showToast("Copy failed — select and copy the URL manually");
  } finally {
    document.body.removeChild(input);
  }
}

async function _buildAndCacheUrl() {
  const plan = buildPlan();
  const hash = await encodePlanToHash(plan);
  const url = location.origin + location.pathname + "#" + hash;
  _cachedHashUrl = url;
  _cacheStale = false;
  return url;
}

/**
 * Called on every render: mark cache stale, then kick off an async rebuild so
 * the next Share click can use the synchronous path (Safari user-activation safe).
 */
function _onRenderInvalidateCache() {
  _cacheStale = true;
  _cachedHashUrl = null;
  _rebuildCacheAsync();
}

/**
 * Non-blocking background rebuild. If another render fires before this
 * completes, _onRenderInvalidateCache will clear _cachedHashUrl again
 * and restart, which is fine — the last one to complete wins.
 */
function _rebuildCacheAsync() {
  _buildAndCacheUrl().catch(() => {
    // Compression failure is non-fatal; _cacheStale stays true so
    // _onShare will fall through to the async path.
    _cacheStale = true;
    _cachedHashUrl = null;
  });
}

// ── Private: export actions ───────────────────────────────────────────────────

async function _onExportAction(e) {
  e.stopPropagation();
  _exportMenuEl?.classList.remove("menu--open");
  const action = e.currentTarget.dataset.action;

  if (action === "export-png") {
    try {
      await exportPng();
    } catch {
      showToast("Couldn't export PNG — try SVG");
    }
  } else if (action === "export-svg") {
    exportSvg();
  } else if (action === "export-json") {
    exportJson();
  } else if (action === "import-json") {
    importJson();
  }
}

// ── Private: overflow/reset actions ──────────────────────────────────────────

function _onOverflowAction(e) {
  e.stopPropagation();
  _overflowMenuEl?.classList.remove("menu--open");
  const action = e.currentTarget.dataset.action;

  if (action === "reset") {
    _confirmReset();
  } else if (action === "open-templates") {
    if (_openTemplates) _openTemplates();
  }
}

function _confirmReset() {
  const confirmed = window.confirm("Replace current plan? This can't be undone.");
  if (!confirmed) return;

  saveNow(); // keep pill coherent
  hydrateWalls({ rooms: [], chain: [] });
  hydrateSymbols({ symbols: [] });
  clearLocal();
  // Reset history so undo cannot resurrect the wiped plan (Edge Case 11)
  if (_historyReset) _historyReset();
  // Clear the plan name (Edge Case 14: _confirmReset bypasses applyPlan, so
  // we must clear the name explicitly; otherwise the stale name lingers in the
  // header input and is re-persisted by the render()-driven autosave).
  setPlanName("");
  // Invalidate hash cache before render (render will also fire _onRenderInvalidateCache)
  _cachedHashUrl = null;
  _cacheStale = true;
  // Edge Case 16: Reset is the one deliberate view reset
  resetView(surface.W, surface.H);
  render();
}

// ── Private: menu helpers ─────────────────────────────────────────────────────

function _toggleMenu(menuEl) {
  if (!menuEl) return;
  menuEl.classList.toggle("menu--open");
}
