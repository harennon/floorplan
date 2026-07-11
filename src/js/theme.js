/**
 * theme.js — theme management (light/dark toggle)
 *
 * Owns:
 *  - applying data-theme to <html> (dark by default in :root; light via html[data-theme="light"])
 *  - caching the resolved palette (concrete color strings) from CSS custom properties
 *  - notifying subscribers on theme change
 *
 * CSS custom properties are the single source of truth for all palette values.
 * This module reads them once per theme change via getComputedStyle, then caches
 * the result for synchronous access by render/export layers.
 */

import { getTheme as prefsGetTheme, setTheme as prefsSetTheme, toggleTheme as prefsToggleTheme } from "./prefs.js";

/**
 * @typedef {{
 *   bg: string, bgDeep: string, ink: string, muted: string,
 *   gold: string, goldSoft: string,
 *   wallBody: string, wallLine: string, wallLineHi: string, draft: string,
 *   roomFill: string, roomFillHi: string,
 *   snapGrid: string, snapPoint: string, snapClose: string,
 *   symFill: string, symStroke: string, symSelFill: string,
 *   ghostFill: string, ghostStroke: string, snapTeal: string,
 *   alignEdge: string, alignCenter: string, roomCenter: string,
 *   dim: string,
 *   accentRgb: string,
 *   symInkRgb: string,
 *   measureLine: string
 * }} Palette
 */

/** @type {Palette} */
let _palette = _buildFallback();

/** @type {Array<(t: "light"|"dark") => void>} */
const _listeners = [];

// ── Fallback palette (dark theme hardcoded) ────────────────────────────────────
// Used when CSS custom properties are unavailable (e.g. test environment).

function _buildFallback() {
  return {
    bg:          "#14140f",
    bgDeep:      "#100f0b",
    ink:         "#ece7d6",
    muted:       "#8f8a78",
    gold:        "#c9a84c",
    goldSoft:    "rgba(201,168,76,0.55)",
    wallBody:    "rgba(201,168,76,0.30)",
    wallLine:    "#d9be6e",
    wallLineHi:  "#e8cf7a",
    draft:       "#d9be6e",
    roomFill:    "rgba(201,168,76,0.07)",
    roomFillHi:  "rgba(201,168,76,0.15)",
    snapGrid:    "#7fd0c8",
    snapPoint:   "#e0b64f",
    snapClose:   "#9cd67a",
    symFill:     "rgba(201,168,76,0.12)",
    symStroke:   "#d9be6e",
    symSelFill:  "rgba(201,168,76,0.18)",
    ghostFill:   "rgba(201,168,76,0.25)",
    ghostStroke: "#c9a84c",
    snapTeal:    "#7fd0c8",
    alignEdge:   "#b98bd9",
    alignCenter: "#7fd0c8",
    roomCenter:  "#e08fbf",
    dim:         "#8f8a78",
    accentRgb:   "201,168,76",
    symInkRgb:   "201,168,76",
    measureLine: "#6fb3d9",
  };
}

// ── Token map: CSS var name → palette key ──────────────────────────────────────

const _TOKEN_MAP = [
  ["--bg",           "bg"],
  ["--bg-deep",      "bgDeep"],
  ["--ink",          "ink"],
  ["--muted",        "muted"],
  ["--gold",         "gold"],
  ["--gold-soft",    "goldSoft"],
  ["--wall-body",    "wallBody"],
  ["--wall-line",    "wallLine"],
  ["--wall-line-hi", "wallLineHi"],
  ["--draft",        "draft"],
  ["--room-fill",    "roomFill"],
  ["--room-fill-hi", "roomFillHi"],
  ["--snap-grid",    "snapGrid"],
  ["--snap-point",   "snapPoint"],
  ["--snap-close",   "snapClose"],
  ["--sym-fill",     "symFill"],
  ["--sym-stroke",   "symStroke"],
  ["--sym-sel-fill", "symSelFill"],
  ["--ghost-fill",   "ghostFill"],
  ["--ghost-stroke", "ghostStroke"],
  ["--snap-teal",    "snapTeal"],
  ["--align-edge",    "alignEdge"],
  ["--align-center",  "alignCenter"],
  ["--room-center",   "roomCenter"],
  ["--dim",           "dim"],
  ["--accent-rgb",    "accentRgb"],
  ["--sym-ink-rgb",   "symInkRgb"],
  ["--measure-line",  "measureLine"],
];

// ── Cache refresh ──────────────────────────────────────────────────────────────

function _refreshCache() {
  if (typeof document === "undefined") return;
  const cs = getComputedStyle(document.documentElement);
  const fallback = _buildFallback();
  const p = {};
  for (const [cssVar, key] of _TOKEN_MAP) {
    const v = cs.getPropertyValue(cssVar).trim();
    p[key] = v || fallback[key];
  }
  _palette = /** @type {Palette} */ (p);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Apply the persisted theme to <html data-theme> and build the palette cache.
 * Call early in main.js, before the first render.
 */
export function init() {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = prefsGetTheme();
  _refreshCache();
}

/**
 * Get the current theme ("light" or "dark"). Delegates to prefs.
 * @returns {"light"|"dark"}
 */
export function getTheme() {
  return prefsGetTheme();
}

/**
 * Set theme: update prefs, apply to DOM, refresh palette cache, notify listeners.
 * @param {"light"|"dark"} t
 */
export function setTheme(t) {
  prefsSetTheme(t);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = prefsGetTheme();
  }
  _refreshCache();
  const current = prefsGetTheme();
  for (const cb of _listeners) cb(current);
}

/**
 * Toggle between light and dark; returns the new theme value.
 * @returns {"light"|"dark"}
 */
export function toggleTheme() {
  prefsToggleTheme();
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = prefsGetTheme();
  }
  _refreshCache();
  const current = prefsGetTheme();
  for (const cb of _listeners) cb(current);
  return current;
}

/**
 * Return the cached palette. Concrete resolved color strings.
 * @returns {Palette}
 */
export function palette() {
  return _palette;
}

/**
 * Register a callback that fires after any theme change.
 * @param {(t: "light"|"dark") => void} cb
 */
export function onThemeChange(cb) {
  _listeners.push(cb);
}
