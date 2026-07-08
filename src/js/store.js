/**
 * store.js — localStorage autosave + save-state pill
 *
 * Debounced autosave driven by the surface.onRender hook.
 * Never blocks the canvas. Graceful quota/private-mode handling.
 */

import { buildPlan, validatePlan, serializePlan } from "./plan.js";
import { onRender } from "./surface.js";

export const STORAGE_KEY = "floorplan:plan:v1";

/** @typedef {"idle"|"saving"|"saved"|"unsaved"|"error"} SaveState */

let _state = /** @type {SaveState} */ ("idle");
let _pillEl = null;
let _lastWrittenJson = null;
let _debounceTimer = null;
const DEBOUNCE_MS = 800;

const STATE_LABELS = {
  idle:    "",
  saving:  "Saving…",
  saved:   "Saved",
  unsaved: "Unsaved",
  error:   "Not saved — export to keep",
};

/**
 * Wire the save pill element and register the debounced autosave onRender hook.
 * @param {HTMLElement} pillEl
 */
export function init(pillEl) {
  _pillEl = pillEl;
  _setState("idle");
  onRender(_onRenderHook);
}

/**
 * Read + validate the persisted plan. Returns Plan|null.
 * @returns {import("./plan.js").Plan|null}
 */
export function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return validatePlan(parsed);
  } catch {
    return null;
  }
}

/**
 * Force an immediate (non-debounced) save.
 * Used before Reset/import overwrite to keep the pill coherent.
 */
export function saveNow() {
  _clearDebounce();
  _doSave();
}

/**
 * Remove the persisted plan (used by Reset).
 */
export function clearLocal() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore (private mode / disabled)
  }
  _lastWrittenJson = null;
  _setState("saved");
}

/**
 * Current pill state (for tests).
 * @returns {SaveState}
 */
export function getState() {
  return _state;
}

// ── Private ───────────────────────────────────────────────────────────────────

function _onRenderHook() {
  _setState("unsaved");
  _clearDebounce();
  _debounceTimer = setTimeout(_doSave, DEBOUNCE_MS);
}

function _doSave() {
  _debounceTimer = null;
  const plan = buildPlan();
  const json = serializePlan(plan);

  // Dirty-check: if JSON is identical to last written, no write needed
  if (json === _lastWrittenJson) {
    _setState("saved");
    return;
  }

  _setState("saving");
  try {
    localStorage.setItem(STORAGE_KEY, json);
    _lastWrittenJson = json;
    _setState("saved");
  } catch (e) {
    // QuotaExceededError, SecurityError, or other write failure
    _setState("error");
    // Keep _lastWrittenJson unchanged so we retry on next change
  }
}

function _clearDebounce() {
  if (_debounceTimer !== null) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
}

function _setState(newState) {
  _state = newState;
  if (_pillEl) {
    const label = STATE_LABELS[newState] || "";
    _pillEl.textContent = label;
    _pillEl.setAttribute("aria-label", label ? `Save status: ${label}` : "Save status");
  }
}
