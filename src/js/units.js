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
