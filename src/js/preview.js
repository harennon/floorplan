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

/** Session-only preview scope: "all" or a room id (LLD 130). Never persisted. */
let _scope = "all";

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
 * Resets scope to "all" when turning off (LLD 130).
 * @param {boolean} on
 */
export function setActive(on) {
  const next = !!on;
  if (next === _active) return;
  _active = next;
  if (!_active) _scope = "all";
  _notify();
}

/** Toggle preview active state. Fires onChange listeners.
 *  Resets scope to "all" when toggling off (LLD 130). */
export function toggle() {
  _active = !_active;
  if (!_active) _scope = "all";
  _notify();
}

/** @returns {"all"|string} current scope: "all" or a room id (LLD 130) */
export function getScope() {
  return _scope;
}

/**
 * Set the preview scope. Fires onChange if the value changed (LLD 130).
 * @param {"all"|string} scopeId
 */
export function setScope(scopeId) {
  const next = scopeId ?? "all";
  if (next === _scope) return;
  _scope = next;
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
