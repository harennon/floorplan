/**
 * prefs.js — persisted editor preferences
 *
 * Distinct from the plan document (store.js / floorplan:plan:v1) which is
 * document state. prefs.js owns editor-session preferences that should survive
 * reload but must NOT appear in exported JSON or share links.
 *
 * Preferences: gridSnap (boolean), theme ("light"|"dark").
 */

export const PREFS_KEY = "floorplan:prefs:v1";

/** @typedef {{ gridSnap: boolean, theme: "light"|"dark" }} Prefs */

/**
 * Resolve the default theme from prefers-color-scheme.
 * Only an explicit OS dark preference yields "dark"; everything else → "light".
 * @returns {"light"|"dark"}
 */
function _resolveDefaultTheme() {
  try {
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  } catch {
    // matchMedia unavailable or throws
  }
  return "light";
}

const _defaults = {
  gridSnap: true,
  // Theme default is computed at module load from prefers-color-scheme (light fallback).
  theme: _resolveDefaultTheme(),
};

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
    if (!parsed) return;
    if (typeof parsed.gridSnap === "boolean") {
      _prefs.gridSnap = parsed.gridSnap;
    }
    if (parsed.theme === "light" || parsed.theme === "dark") {
      _prefs.theme = parsed.theme;
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
  _persist();
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
 * Read the current theme preference.
 * @returns {"light"|"dark"}
 */
export function getTheme() {
  return _prefs.theme;
}

/**
 * Set theme preference; persists to localStorage and fires onChange listeners.
 * @param {"light"|"dark"} theme
 */
export function setTheme(theme) {
  _prefs.theme = (theme === "light" || theme === "dark") ? theme : _defaults.theme;
  _persist();
  for (const cb of _listeners) cb();
}

/**
 * Toggle theme and return the new value.
 * @returns {"light"|"dark"}
 */
export function toggleTheme() {
  setTheme(_prefs.theme === "light" ? "dark" : "light");
  return _prefs.theme;
}

/**
 * Register a callback fired after any pref change.
 * @param {() => void} cb
 */
export function onPrefsChange(cb) {
  _listeners.push(cb);
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _persist() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(_prefs));
  } catch {
    // QuotaExceededError, SecurityError, or private-mode write failure.
    // The in-memory value was already updated, so the session behaves correctly.
  }
}
