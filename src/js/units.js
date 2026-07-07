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

/**
 * Parse a user-typed length string to METRES, or null if unparseable.
 * Accepts (case-insensitive, whitespace-tolerant):
 *   - bare number  -> interpreted in the CURRENT display unit ("3.2" => 3.2 units)
 *   - metric suffix: "m", "cm", "mm"            (e.g. "3.2m", "320cm")
 *   - imperial suffix: "ft" | "'", "in" | "\""  (e.g. "10ft", "10'", "6in", "6\"")
 *   - feet+inches:   "10' 6\"" / "10ft 6in"
 * Returns a positive number of metres, or null for empty/NaN/non-positive input.
 * @param {string} str
 * @returns {number|null}
 */
export function parseLen(str) {
  if (!str || typeof str !== "string") return null;
  const s = str.trim();
  if (!s) return null;

  // feet+inches: "10' 6\"" / "10ft 6in" (space optional between parts)
  const feetInchRe = /^(\d+(?:\.\d+)?)\s*(?:ft|')\s*(\d+(?:\.\d+)?)\s*(?:in|")\s*$/i;
  let m = s.match(feetInchRe);
  if (m) {
    const metres = (parseFloat(m[1]) + parseFloat(m[2]) / 12) * M_PER_FT;
    return metres > 0 ? metres : null;
  }

  // metric: mm (must check before plain "m" to avoid partial match)
  m = s.match(/^(\d+(?:\.\d+)?)\s*mm\s*$/i);
  if (m) {
    const metres = parseFloat(m[1]) / 1000;
    return metres > 0 ? metres : null;
  }

  // metric: cm
  m = s.match(/^(\d+(?:\.\d+)?)\s*cm\s*$/i);
  if (m) {
    const metres = parseFloat(m[1]) / 100;
    return metres > 0 ? metres : null;
  }

  // metric: m
  m = s.match(/^(\d+(?:\.\d+)?)\s*m\s*$/i);
  if (m) {
    const metres = parseFloat(m[1]);
    return metres > 0 ? metres : null;
  }

  // imperial: ft or '
  m = s.match(/^(\d+(?:\.\d+)?)\s*(?:ft|')\s*$/i);
  if (m) {
    const metres = parseFloat(m[1]) * M_PER_FT;
    return metres > 0 ? metres : null;
  }

  // imperial: in or "
  m = s.match(/^(\d+(?:\.\d+)?)\s*(?:in|")\s*$/i);
  if (m) {
    const metres = (parseFloat(m[1]) / 12) * M_PER_FT;
    return metres > 0 ? metres : null;
  }

  // bare number: interpreted in the current display unit
  m = s.match(/^(-?\d+(?:\.\d+)?)\s*$/);
  if (m) {
    const val = parseFloat(m[1]);
    if (val <= 0) return null;
    const metres = unit === "ft" ? val * M_PER_FT : val;
    return metres > 0 ? metres : null;
  }

  return null;
}

/**
 * Format an area in square metres for display in the current unit.
 * m:  m², 2 decimals; ft: m² / (M_PER_FT²), 1 decimal.
 * @param {number} m2
 * @returns {string}
 */
export function fmtArea(m2) {
  if (unit === "ft") {
    return (m2 / (M_PER_FT * M_PER_FT)).toFixed(1);
  }
  return m2.toFixed(2);
}

/** Area unit label for the current display unit: "m²" | "ft²". */
export function areaUnitLabel() {
  return unit === "ft" ? "ft²" : "m²";
}
