/**
 * history.js — snapshot-based undo/redo stack for committed geometry operations
 *
 * DOM-free and tool-free. Imports only the two geometry models it snapshots.
 * Granularity: one entry per committed gesture (room close, symbol drop, drag
 * end, rotate, resize, delete, duplicate). Dirty-checks against the current
 * baseline — no push when geometry is unchanged.
 *
 * Exports: init, reset, commit, undo, redo, canUndo, canRedo, depth, onChange
 */

import { model as wallsModel,   hydrate as hydrateWalls   } from "./walls.js";
import { model as symbolsModel, hydrate as hydrateSymbols } from "./symbols.js";
import { model as measurementsModel, hydrate as hydrateMeasurements } from "./measurements.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ rooms: import("./walls.js").Room[],
 *             symbols: import("./symbols.js").Sym[],
 *             measurements: import("./measurements.js").Measurement[] }} GeomSnapshot
 */

// ── Internal state ────────────────────────────────────────────────────────────

/** @type {GeomSnapshot[]} prior states, oldest→newest */
let _past    = [];
/** @type {GeomSnapshot|null} current baseline */
let _present = null;
/** @type {GeomSnapshot[]} redo stack */
let _future  = [];

/** Maximum undo stack depth; drop oldest past entry beyond this. */
const MAX_DEPTH = 100;

/** @type {(()=>void)[]} registered onChange listeners */
const _listeners = [];

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Deep-clone rooms + symbols + measurements into a snapshot.
 * Intentionally excludes model.chain so undo/redo never disturbs the live
 * in-progress polyline (Edge Case 1).
 * @returns {GeomSnapshot}
 */
function _capture() {
  return {
    rooms:        JSON.parse(JSON.stringify(wallsModel.rooms)),
    symbols:      JSON.parse(JSON.stringify(symbolsModel.symbols)),
    measurements: JSON.parse(JSON.stringify(measurementsModel.measurements)),
  };
}

/**
 * Apply a snapshot to the live models. Preserves the current in-progress chain.
 * Never calls render() — the caller is responsible for scheduleRender().
 *
 * Deep-clones the snapshot before handing it to the hydrate functions so that
 * the live model objects never share identity with the stored snapshot objects.
 * Without this, an in-place mutation of a live element (move, rotate, resize)
 * would silently mutate _present too, causing commit()'s stringify dirty-check
 * to treat the edit as a no-op and leaving _future un-cleared (silent data loss
 * on subsequent redo).
 *
 * @param {GeomSnapshot} snap
 */
function _apply(snap) {
  // Deep-clone so the live models never share object refs with the snapshot.
  const cloned = JSON.parse(JSON.stringify(snap));
  // Preserve the live in-progress chain (Edge Case 1)
  hydrateWalls({ rooms: cloned.rooms, chain: [...wallsModel.chain] });
  hydrateSymbols({ symbols: cloned.symbols });
  hydrateMeasurements({ measurements: cloned.measurements || [] });
  // history NEVER calls render(); the main.js caller triggers scheduleRender()
}

/** Fire all registered onChange listeners. */
function _notify() {
  for (const cb of _listeners) cb();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Seed the baseline from current live geometry and notify listeners.
 * Called once at app startup from main.js.
 */
export function init() {
  _past    = [];
  _future  = [];
  _present = _capture();
  _notify();
}

/**
 * Reset the stack and reseed the baseline from current live geometry.
 * Called after boot-restore and after Reset-plan so undo can't cross those
 * boundaries.
 */
export function reset() {
  _past    = [];
  _future  = [];
  _present = _capture();
  _notify();
}

/**
 * Capture current live geometry. If it is identical (stable-stringify) to
 * the current baseline, this is a no-op. Otherwise push the prior baseline
 * onto `_past`, make the new capture the baseline, and clear `_future`.
 * Notifies onChange.
 */
export function commit() {
  const next = _capture();
  const nextStr    = JSON.stringify(next);
  const presentStr = _present ? JSON.stringify(_present) : null;

  // Dirty-check: no-op when geometry hasn't changed
  if (nextStr === presentStr) return;

  if (_present !== null) {
    _past.push(_present);
    // Cap stack depth: drop oldest entry when over MAX_DEPTH
    if (_past.length > MAX_DEPTH) _past.shift();
  }
  _present = next;
  _future  = []; // any new commit invalidates the redo stack
  _notify();
}

/**
 * Revert to the previous committed snapshot.
 * No-op when canUndo() is false. Returns true when applied, false otherwise.
 * The caller must call scheduleRender() after a truthy return.
 * @returns {boolean}
 */
export function undo() {
  if (_past.length === 0) return false;
  _future.push(_present);
  _present = /** @type {GeomSnapshot} */ (_past.pop());
  _apply(_present);
  _notify();
  return true;
}

/**
 * Re-apply the next snapshot.
 * No-op when canRedo() is false. Returns true when applied, false otherwise.
 * The caller must call scheduleRender() after a truthy return.
 * @returns {boolean}
 */
export function redo() {
  if (_future.length === 0) return false;
  _past.push(_present);
  _present = /** @type {GeomSnapshot} */ (_future.pop());
  _apply(_present);
  _notify();
  return true;
}

/** True when there is at least one step to undo. */
export function canUndo() {
  return _past.length > 0;
}

/** True when there is at least one step to redo. */
export function canRedo() {
  return _future.length > 0;
}

/**
 * Current undo depth (`_past.length`). Used by the delete toast to scope its
 * one-tap Undo to the step it created (Edge Case 14).
 * @returns {number}
 */
export function depth() {
  return _past.length;
}

/**
 * Register a listener fired after any stack change (commit / undo / redo /
 * reset). Used to refresh rail button disabled state.
 * @param {()=>void} cb
 */
export function onChange(cb) {
  _listeners.push(cb);
}
