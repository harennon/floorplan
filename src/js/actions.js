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

  // Give exportJson our toast callback
  setToastCallback(showToast);

  // Invalidate hash cache on every render so Share always reflects the current plan.
  // The cache is rebuilt asynchronously in the background after each invalidation
  // so that the next Share click is usually served synchronously (Safari activation-safe).
  onRender(_onRenderInvalidateCache);

  // ── Share button ────────────────────────────────────────────────────────────
  _btnShare?.addEventListener("click", _onShare);

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
    if (_toastEl) _toastEl.classList.remove("toast--visible");
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
    // No banner element: silently apply local plan
    onChoice("local");
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

async function _onShare() {
  // Prefer synchronous path: use pre-computed cached URL if it is fresh.
  // The cache is invalidated on every render (via the onRender hook) and
  // rebuilt asynchronously in the background, so _cachedHashUrl is current
  // as long as the plan has not changed since the last background rebuild.
  if (_cachedHashUrl && !_cacheStale) {
    _copyUrl(_cachedHashUrl);
  } else {
    // Async path: compute now (cache was stale or not yet built)
    try {
      const url = await _buildAndCacheUrl();
      _copyUrl(url);
    } catch {
      showToast("Couldn't build share link");
    }
  }
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
