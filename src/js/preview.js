/**
 * preview.js — session-only view-mode state for the 3D isometric preview (LLD 128)
 *
 * Mirrors the structure of clearance.js (session-only, NOT persisted to plan
 * JSON / localStorage / URL hash). Preview is transient inspection state.
 *
 * The isometric preview is toggled on/off via this module; isoRender.js reads
 * isActive() each render to decide whether to paint the #iso SVG group.
 */

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {boolean} */
let _active = false;

// ── Listeners ─────────────────────────────────────────────────────────────────

/** @type {Array<()=>void>} */
const _listeners = [];

// ── Public API ────────────────────────────────────────────────────────────────

/** @returns {boolean} true when preview mode is active */
export function isActive() {
  return _active;
}

/**
 * Set preview active state. Fires onChange listeners if the value changed.
 * @param {boolean} on
 */
export function setActive(on) {
  const next = !!on;
  if (next === _active) return;
  _active = next;
  _notify();
}

/** Toggle preview active state. Fires onChange listeners. */
export function toggle() {
  _active = !_active;
  _notify();
}

/**
 * Register a callback fired after any state change.
 * @param {()=>void} cb
 */
export function onChange(cb) {
  _listeners.push(cb);
}

// ── Private ───────────────────────────────────────────────────────────────────

function _notify() {
  for (const cb of _listeners) cb();
}
