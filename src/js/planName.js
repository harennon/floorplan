/**
 * planName.js — the single current plan's name (live UI state). DOM-free.
 *
 * Mirrors units.js: a simple get/set/onChange module for the plan name.
 * plan.js imports this (plan.js → planName.js; one direction only to avoid cycles).
 * MAX_NAME_LEN is inlined here as 60 (matches plan.js MAX_NAME_LEN) to avoid
 * a back-import cycle.
 */

// Inline cap to avoid import cycle (plan.js → planName.js, not the reverse).
const _MAX_NAME_LEN = 60; // must equal plan.js MAX_NAME_LEN

let _name = "";
const _subs = [];

/** @returns {string} current name ("" ⇒ placeholder at UI). */
export function getPlanName() {
  return _name;
}

/**
 * Set + cap the name; notifies subscribers only on real change.
 * Trims the value and caps at _MAX_NAME_LEN. Empty/whitespace → "".
 * @param {string} v
 */
export function setPlanName(v) {
  const coerced = typeof v === "string" ? v.trim().slice(0, _MAX_NAME_LEN) : "";
  if (coerced === _name) return;
  _name = coerced;
  for (const cb of _subs) cb(_name);
}

/**
 * Subscribe to name changes.
 * @param {(name: string) => void} cb
 */
export function onChange(cb) {
  _subs.push(cb);
}
