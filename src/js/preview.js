/**
 * preview.js — session-only view-mode state for the 3D isometric preview (LLD 128 / LLD 142)
 *
 * Mirrors the structure of clearance.js (session-only, NOT persisted to plan
 * JSON / localStorage / URL hash). Preview is transient inspection state.
 *
 * The isometric preview is toggled on/off via this module; isoRender.js reads
 * isActive() each render to decide whether to paint the #iso SVG group.
 *
 * LLD 142 adds scope state: getScope()/setScope() let the user preview a single
 * room instead of the whole plan. Scope is session-only and resets to null when
 * preview is turned off.
 */

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {boolean} */
let _active = false;

/**
 * Current scope: null = whole plan, else a room id.
 * Session-only; never persisted. Reset to null on setActive(false).
 * @type {string|null}
 */
let _scope = null;

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
 * Resets scope to null when turning off so re-entry starts whole-plan.
 * @param {boolean} on
 */
export function setActive(on) {
  const next = !!on;
  if (next === _active) return;
  _active = next;
  if (!_active) _scope = null; // reset scope on exit (LLD 142 §State)
  _notify();
}

/** Toggle preview active state. Fires onChange listeners. */
export function toggle() {
  _active = !_active;
  if (!_active) _scope = null; // reset scope on exit
  _notify();
}

/**
 * Register a callback fired after any state change (active or scope).
 * @param {()=>void} cb
 */
export function onChange(cb) {
  _listeners.push(cb);
}

/**
 * Current scope: null = whole plan, else a room id (string).
 * @returns {string|null}
 */
export function getScope() {
  return _scope;
}

/**
 * Set the scope (room id or null). Fires onChange if changed. Session-only.
 * @param {string|null} scopeOrNull
 */
export function setScope(scopeOrNull) {
  const next = scopeOrNull ?? null;
  if (next === _scope) return;
  _scope = next;
  _notify();
}

// ── Private ───────────────────────────────────────────────────────────────────

function _notify() {
  for (const cb of _listeners) cb();
}
