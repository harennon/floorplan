/**
 * history.js — undo/redo core, keyboard shortcuts, cheat-sheet overlay
 *
 * Snapshot-based history: a deep-clone of { walls, symbols } (no view/unit)
 * is pushed after each committed gesture via commit(). undo()/redo() restore
 * snapshots in place via the existing hydrate functions.
 *
 * A single window keydown listener handles ⌘/Ctrl+Z (undo), ⌘⇧Z/Ctrl+Y/Ctrl+Shift+Z
 * (redo), and ? (cheat-sheet toggle). Ignores events when an editable element is focused.
 */

import { model as wallsModel, hydrate as hydrateWalls } from "./walls.js";
import { model as symbolsModel, hydrate as hydrateSymbols } from "./symbols.js";
import { scheduleRender } from "./surface.js";
import { dismissToast } from "./actions.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const HISTORY_CAP = 100;

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * A document snapshot: walls + symbols only. No view, no unit.
 * @typedef {{ walls:{rooms:object[],chain:object[]}, symbols:{symbols:object[]} }} DocSnap
 */

// ── State ──────────────────────────────────────────────────────────────────────

/** @type {DocSnap[]} — _undo[_undo.length-1] === current doc snapshot */
let _undo = [];

/** @type {DocSnap[]} */
let _redo = [];

// ── DOM refs ──────────────────────────────────────────────────────────────────

let _btnUndo       = null;
let _btnRedo       = null;
let _btnHelp       = null;
let _sheet         = null;
let _sheetClose    = null;
/** @type {(()=>void)|null} */
let _onAfterRestore = null;
let _sheetOpen     = false;
/** @type {Element|null} */
let _sheetTrigger  = null;

// ── Platform helpers ──────────────────────────────────────────────────────────

/** True on Apple platforms → use ⌘ in tooltips / treat metaKey as accelerator. */
export function isMac() {
  return /Mac|iPhone|iPad|iPod/.test(
    (typeof navigator !== "undefined" ? (navigator.platform || navigator.userAgent) : "")
  );
}

/** The accelerator modifier for the current platform on a keyboard event. */
export function accel(e) {
  return isMac() ? e.metaKey : e.ctrlKey;
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

/**
 * Bind rail buttons + cheat-sheet DOM; wire the global keydown handler.
 * @param {{
 *   btnUndo:   Element,
 *   btnRedo:   Element,
 *   btnHelp:   Element,
 *   sheet:     Element,
 *   sheetClose: Element,
 *   onAfterRestore?: () => void,
 * }} refs
 */
export function init(refs) {
  _btnUndo        = refs.btnUndo    || null;
  _btnRedo        = refs.btnRedo    || null;
  _btnHelp        = refs.btnHelp    || null;
  _sheet          = refs.sheet      || null;
  _sheetClose     = refs.sheetClose || null;
  _onAfterRestore = refs.onAfterRestore || null;

  // Rail global undo/redo buttons
  if (_btnUndo) _btnUndo.addEventListener("click", () => undo());
  if (_btnRedo) _btnRedo.addEventListener("click", () => redo());

  // "?" help button near zoom cluster
  if (_btnHelp) {
    _btnHelp.addEventListener("click", () => _openSheet(_btnHelp));
  }

  // Cheat sheet close button
  if (_sheetClose) {
    _sheetClose.addEventListener("click", _closeSheet);
  }

  // Cheat sheet: close on outside-click (clicking the backdrop)
  if (_sheet) {
    _sheet.addEventListener("click", (e) => {
      if (e.target === _sheet) _closeSheet();
    });
  }

  // Global keyboard handler (undo/redo/cheat-sheet)
  window.addEventListener("keydown", _onGlobalKeyDown);

  // Initialise button disabled state
  _updateButtons();
}

/**
 * Seed baseline snapshot from current live model. Clears both stacks.
 * Called at boot AND after any wholesale document replacement
 * (applyPlan / reset / import / conflict-choice).
 */
export function reset() {
  _undo = [snapshotDoc()];
  _redo = [];
  _updateButtons();
}

/**
 * Capture current document; if it differs from the stack top, push it and
 * clear the redo stack. This is the ONE chokepoint every gesture calls.
 */
export function commit() {
  const snap = snapshotDoc();
  if (_undo.length > 0) {
    const top = _undo[_undo.length - 1];
    if (JSON.stringify(snap) === JSON.stringify(top)) {
      // No net change — don't add a dead step
      return;
    }
  }
  _undo.push(snap);
  _redo = [];
  // Enforce cap: drop oldest snapshot
  if (_undo.length > HISTORY_CAP) {
    _undo.shift();
  }
  _updateButtons();
}

/**
 * Restore the previous snapshot. No-op when at baseline.
 * Returns true if it moved.
 */
export function undo() {
  if (_undo.length <= 1) return false;
  // Dismiss any stale delete toast so its restore closure can no longer fire
  // after the document has been restored here (prevents duplicate-id corruption).
  dismissToast();
  const current = _undo.pop();
  _redo.push(current);
  const prev = _undo[_undo.length - 1];
  restoreDoc(prev);
  _updateButtons();
  if (_onAfterRestore) _onAfterRestore();
  scheduleRender();
  return true;
}

/**
 * Re-apply an undone snapshot. No-op when redo stack is empty.
 * Returns true if it moved.
 */
export function redo() {
  if (_redo.length === 0) return false;
  // Dismiss any stale delete toast (mirrors undo() — redo also restores state).
  dismissToast();
  const next = _redo.pop();
  _undo.push(next);
  if (_undo.length > HISTORY_CAP) _undo.shift();
  restoreDoc(next);
  _updateButtons();
  if (_onAfterRestore) _onAfterRestore();
  scheduleRender();
  return true;
}

/** True when the undo stack has a prior snapshot (something to undo). */
export function canUndo() {
  return _undo.length > 1;
}

/** True when the redo stack is non-empty. */
export function canRedo() {
  return _redo.length > 0;
}

// ── Snapshot helpers (pure, testable without DOM) ────────────────────────────

/**
 * Deep clone of live walls+symbols. Deliberately excludes view and unit.
 * @returns {DocSnap}
 */
export function snapshotDoc() {
  return JSON.parse(JSON.stringify({
    walls:   { rooms: wallsModel.rooms, chain: wallsModel.chain },
    symbols: { symbols: symbolsModel.symbols },
  }));
}

/**
 * Hydrate walls+symbols in place from a snapshot.
 * Uses the existing id-counter-safe hydrate functions.
 * @param {DocSnap} snap
 */
export function restoreDoc(snap) {
  hydrateWalls(snap.walls);
  hydrateSymbols(snap.symbols);
}

// ── Private helpers ──────────────────────────────────────────────────────────

function _updateButtons() {
  const mac = isMac();
  if (_btnUndo) {
    _btnUndo.disabled = !canUndo();
    const label = mac ? "Undo (⌘Z)" : "Undo (Ctrl+Z)";
    _btnUndo.setAttribute("aria-label", label);
    _btnUndo.title = label;
  }
  if (_btnRedo) {
    _btnRedo.disabled = !canRedo();
    const label = mac ? "Redo (⌘⇧Z)" : "Redo (Ctrl+Y)";
    _btnRedo.setAttribute("aria-label", label);
    _btnRedo.title = label;
  }
}

function _onGlobalKeyDown(e) {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  const mac    = isMac();
  const isAccel = mac ? e.metaKey : e.ctrlKey;

  // ── Redo: ⌘⇧Z (mac), Ctrl+Y, Ctrl+Shift+Z (others) ──────────────────────
  if (isAccel) {
    const isRedoMac = mac && e.shiftKey && (e.key === "Z" || e.key === "z");
    const isRedoWin = !mac && (
      e.key === "y" || e.key === "Y" ||
      (e.shiftKey && (e.key === "Z" || e.key === "z"))
    );
    if (isRedoMac || isRedoWin) {
      e.preventDefault();
      redo();
      return;
    }
    // ── Undo: ⌘Z / Ctrl+Z (no shift) ────────────────────────────────────────
    if (!e.shiftKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      undo();
      return;
    }
    return; // other accel combos — let them pass
  }

  // ── Cheat sheet toggle: ? (Shift+/) ─────────────────────────────────────
  if (e.key === "?") {
    if (_sheetOpen) {
      _closeSheet();
    } else {
      _openSheet(null);
    }
    return;
  }

  // ── Esc: close cheat sheet if open ──────────────────────────────────────
  if (e.key === "Escape" && _sheetOpen) {
    _closeSheet();
    // Note: does not stopImmediatePropagation — wallTool also sees Esc for chain-finish.
    // This is an acceptable v1 edge case per the LLD.
    return;
  }
}

function _openSheet(trigger) {
  if (!_sheet) return;
  _sheetOpen   = true;
  _sheetTrigger = trigger;
  _sheet.removeAttribute("aria-hidden");
  _sheet.classList.add("sheet--open");
  // Move focus into the dialog for accessibility
  const focusTarget = _sheetClose || _sheet.querySelector("button,[tabindex]");
  if (focusTarget) {
    // Defer focus so the element is visible in the next paint
    requestAnimationFrame(() => focusTarget.focus());
  }
}

function _closeSheet() {
  if (!_sheet) return;
  _sheetOpen = false;
  _sheet.setAttribute("aria-hidden", "true");
  _sheet.classList.remove("sheet--open");
  // Return focus to the button that opened the sheet.
  // When opened via the '?' key, _sheetTrigger is null; fall back to _btnHelp
  // so focus always returns to a known interactive element (LLD Accessibility).
  const focusTarget = _sheetTrigger || _btnHelp;
  if (focusTarget) {
    focusTarget.focus();
  }
  _sheetTrigger = null;
}
