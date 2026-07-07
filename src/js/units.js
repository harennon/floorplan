/**
 * units.js — unit display module
 *
 * World storage is always in metres. This module only controls
 * how lengths are formatted for display. Unit preference is NOT
 * persisted (resets to "ft" on reload — imperial default).
 */

export const M_PER_FT = 0.3048;

/** Current display unit. "ft" | "m". Default imperial. */
export let unit = "ft";

const _listeners = [];

/** Set display unit. Fires onChange callbacks. */
export function setUnit(u) {
  if (u !== "ft" && u !== "m") throw new Error(`Unknown unit: ${u}`);
  unit = u;
  for (const cb of _listeners) cb();
}

/**
 * Format a length in metres for display.
 * ft: metres / M_PER_FT, 1 decimal place
 * m:  metres, 2 decimal places
 */
export function fmtLen(metres) {
  if (unit === "ft") {
    return (metres / M_PER_FT).toFixed(1);
  }
  return metres.toFixed(2);
}

/** Display unit label. */
export function unitLabel() {
  return unit;
}

/** Register a callback fired after unit changes. */
export function onChange(cb) {
  _listeners.push(cb);
}

// ── New exports (LLD 9) ───────────────────────────────────────────────────────

export const M2_PER_FT2 = M_PER_FT * M_PER_FT;

/**
 * Parse a display string → metres, or null if invalid.
 * Accepts an optional unit suffix that overrides the current display unit:
 *   "3.2m" → 3.2  ;  "10ft" / "10'" → 3.048  ;  "10.5" → interpreted in current `unit`.
 * Rejects: NaN, ≤ 0, non-finite, empty. Decimal point only (no locale comma in v1).
 * @param {string} str
 * @returns {number|null}
 */
export function parseLen(str) {
  if (typeof str !== "string") return null;
  const s = str.trim();
  if (s === "") return null;

  let valueStr = s;
  let resolvedUnit = unit; // default to current display unit

  // Detect explicit unit suffix (longest match first)
  if (/ft$/i.test(s)) {
    valueStr = s.slice(0, s.length - 2).trim();
    resolvedUnit = "ft";
  } else if (/'$/.test(s)) {
    valueStr = s.slice(0, s.length - 1).trim();
    resolvedUnit = "ft";
  } else if (/m$/i.test(s)) {
    valueStr = s.slice(0, s.length - 1).trim();
    resolvedUnit = "m";
  }

  const num = Number(valueStr);
  if (!Number.isFinite(num) || num <= 0) return null;
  // Reject locale commas (commas in the value part make Number() return NaN, but
  // also check explicitly to be safe)
  if (valueStr.includes(",")) return null;

  if (resolvedUnit === "ft") {
    return num * M_PER_FT;
  }
  return num; // already metres
}

/**
 * Format an area in metres² for display.
 *   ft²: m2 / M2_PER_FT2, 1 decimal ;  m²: m2, 2 decimals.
 * @param {number} m2
 * @returns {string}
 */
export function fmtArea(m2) {
  if (unit === "ft") {
    return (m2 / M2_PER_FT2).toFixed(1);
  }
  return m2.toFixed(2);
}

/**
 * Area unit label: "ft²" | "m²".
 * @returns {string}
 */
export function areaUnitLabel() {
  return unit === "ft" ? "ft²" : "m²";
}
