/**
 * history.js — undo/redo history stack for geometry edits (LLD 20)
 *
 * Snapshot-based: stores serialized GeometrySnapshot strings.
 * commit() diffs vs baseline — no-op if unchanged, so double-calls and
 * no-op gestures are free.
 * Stack is in-memory only; not persisted to localStorage, share hash, or
 * JSON export.
 */

import { snapshotGeometry, serializeGeometry, restoreGeometry } from "./plan.js";
import { scheduleRender } from "./surface.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_STEPS = 100;

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {string|null} Serialized baseline — current committed geometry. */
let _baseline = null;

/** @type {string[]} Undo stack, oldest→newest (each entry is a serialized snapshot). */
const _undo = [];

/** @type {string[]} Redo stack, oldest→newest. */
const _redo = [];

// ── DOM refs ──────────────────────────────────────────────────────────────────

let _btnUndo   = null;
let _btnRedo   = null;
let _onRestore = null;    // () => void — called after any model restore
let _isDragging = null;   // () => boolean — guard for rail button clicks

// ── Platform detection ────────────────────────────────────────────────────────

const IS_MAC = /Mac|iPod|iPhone|iPad/.test(
  (typeof navigator !== "undefined" ? navigator.platform : "") || ""
);

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Wire rail buttons and establish initial baseline.
 * @param {{
 *   btnUndo: HTMLButtonElement,
 *   btnRedo: HTMLButtonElement,
 *   onRestore?: () => void,
 *   isDragging?: () => boolean,
 * }} refs
 */
export function init(refs) {
  _btnUndo    = refs.btnUndo;
  _btnRedo    = refs.btnRedo;
  _onRestore  = refs.onRestore  || null;
  _isDragging = refs.isDragging || (() => false);

  // Set platform-correct aria-label / title
  const undoLabel = IS_MAC ? "Undo (⌘Z)" : "Undo (Ctrl+Z)";
  const redoLabel = IS_MAC ? "Redo (⌘⇧Z)" : "Redo (Ctrl+Shift+Z)";
  if (_btnUndo) {
    _btnUndo.setAttribute("aria-label", undoLabel);
    _btnUndo.setAttribute("title",      undoLabel);
  }
  if (_btnRedo) {
    _btnRedo.setAttribute("aria-label", redoLabel);
    _btnRedo.setAttribute("title",      redoLabel);
  }

  // Wire clicks (drag-guarded)
  _btnUndo?.addEventListener("click", () => { if (!_isDragging()) undo(); });
  _btnRedo?.addEventListener("click", () => { if (!_isDragging()) redo(); });

  // Establish initial baseline
  _baseline = serializeGeometry(snapshotGeometry());
  _updateButtons();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Capture current geometry; push a history step only if it differs from baseline.
 * No-op when geometry is unchanged (handles double-calls and no-op gestures).
 */
export function commit() {
  // Safety: if init() has not been called, establish baseline and return.
  if (_baseline === null) {
    _baseline = serializeGeometry(snapshotGeometry());
    return;
  }
  const now = serializeGeometry(snapshotGeometry());
  if (now === _baseline) return;
  _undo.push(_baseline);
  if (_undo.length > MAX_STEPS) _undo.shift();
  _redo.length = 0;
  _baseline = now;
  _updateButtons();
}

/**
 * Restore the previous snapshot. No-op (returns false) when undo stack is empty.
 * @returns {boolean} true if a step was applied
 */
export function undo() {
  if (_undo.length === 0) return false;
  _redo.push(_baseline);
  _baseline = _undo.pop();
  _applyBaseline();
  _updateButtons();
  return true;
}

/**
 * Restore the next snapshot. No-op (returns false) when redo stack is empty.
 * @returns {boolean} true if a step was applied
 */
export function redo() {
  if (_redo.length === 0) return false;
  _undo.push(_baseline);
  _baseline = _redo.pop();
  _applyBaseline();
  _updateButtons();
  return true;
}

/**
 * Clear both stacks and re-baseline from current live geometry.
 * Call after any wholesale model swap (boot restore, import, share-open, reset).
 */
export function reset() {
  _undo.length = 0;
  _redo.length = 0;
  _baseline = serializeGeometry(snapshotGeometry());
  _updateButtons();
}

/** True when the undo stack has entries. */
export function canUndo() { return _undo.length > 0; }

/** True when the redo stack has entries. */
export function canRedo() { return _redo.length > 0; }

// ── Private ───────────────────────────────────────────────────────────────────

function _applyBaseline() {
  restoreGeometry(JSON.parse(_baseline));
  if (_onRestore) _onRestore();
  scheduleRender();
}

function _updateButtons() {
  if (_btnUndo) _btnUndo.disabled = _undo.length === 0;
  if (_btnRedo) _btnRedo.disabled = _redo.length === 0;
}
