/**
 * prefs.js — persisted editor preferences
 *
 * Distinct from the plan document (store.js / floorplan:plan:v1) which is
 * document state. prefs.js owns editor-session preferences that should survive
 * reload but must NOT appear in exported JSON or share links.
 *
 * Starting preference: gridSnap (boolean, default true).
 */

export const PREFS_KEY = "floorplan:prefs:v1";

/** @typedef {{ gridSnap: boolean }} Prefs */

const _defaults = { gridSnap: true };

/** In-memory copy, kept in sync with localStorage. */
let _prefs = { ..._defaults };

/** Registered change callbacks. */
const _listeners = [];

// ── Module init: load from localStorage ───────────────────────────────────────

(function _load() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.gridSnap === "boolean") {
      _prefs = { gridSnap: parsed.gridSnap };
    }
    // Unrecognised keys are silently ignored; missing keys fall back to defaults.
  } catch {
    // Corrupt JSON or inaccessible storage — fall back to defaults.
    _prefs = { ..._defaults };
  }
})();

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Read the current grid-snap preference.
 * @returns {boolean}
 */
export function gridSnap() {
  return _prefs.gridSnap;
}

/**
 * Set grid-snap on/off; persists to localStorage and fires onChange listeners.
 * @param {boolean} on
 */
export function setGridSnap(on) {
  _prefs.gridSnap = !!on;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(_prefs));
  } catch {
    // QuotaExceededError, SecurityError, or private-mode write failure.
    // The in-memory value was already updated, so the session behaves correctly.
  }
  for (const cb of _listeners) cb();
}

/**
 * Toggle grid-snap and return the new value.
 * @returns {boolean}
 */
export function toggleGridSnap() {
  setGridSnap(!_prefs.gridSnap);
  return _prefs.gridSnap;
}

/**
 * Register a callback fired after any pref change.
 * @param {() => void} cb
 */
export function onPrefsChange(cb) {
  _listeners.push(cb);
}
