/**
 * symbolTool.js — palette, placement, selection controller, inspector
 *
 * Handles:
 *  - Dock drag-placement (self-contained pointer capture from the dock)
 *  - Select-mode hooks: onSelectDown / onSelectMove / onSelectUp / onTapEmpty
 *  - Inspector actions: rotate 90°, duplicate, delete, lock-aspect
 *  - Keyboard: Delete/Backspace for selected symbol
 *  - Integrates with wallTool.setTool to switch to select mode on dock drag
 */

import { screenToWorld, worldToScreen, pxPerM } from "./view.js";
import { gridSnap } from "./walls.js";
import { chooseGridStep } from "./grid.js";
import {
  model, CATALOG,
  createSymbol, addSymbol, removeSymbol, duplicateSymbol,
  getSymbol, pickSymbol, moveSymbol, rotateSymbol, resizeSymbol, corners,
} from "./symbols.js";
import { scheduleRender } from "./surface.js";
import { getRotateHandleScreen } from "./symbolRender.js";
import { beginEdit as beginDimEdit, cancel as cancelDimEdit, isEditing as isDimEditing } from "./symbolDimEntry.js";
import { commit as historyCommit, undo as historyUndo } from "./history.js";
import { isModalOpen, IS_MAC } from "./shortcuts.js";

/** Callback injected from main.js — avoids circular dependency with actions.js. */
let _showToast = null;

/**
 * Inject the toast function. Called once from main.js after both modules are init'd.
 * @param {(msg: string, opts?: object) => void} fn
 */
export function setToastFn(fn) {
  _showToast = fn;
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Minimum hit target on screen, pixels (Edge Case 14). */
const MIN_HIT_PX = 12;

/** Snap increment for free rotate (degrees). */
const ROTATE_SNAP_DEG = 15;

/** Rotate handle hit radius (screen px). */
const ROTATE_HIT_R = 14;

// ── State ──────────────────────────────────────────────────────────────────────

/** @type {string|null} */
let _selectedId = null;

/** @type {{ type:string, x:number, y:number, w:number, h:number, rot:number }|null} */
let _ghost = null;

/** @type {"move"|"rotate"|null} */
let _dragMode = null;

/** Pointer offset from symbol center at drag start (world metres). */
let _dragOffsetX = 0;
let _dragOffsetY = 0;

/** For rotate drag: starting angle between pointer and center (radians). */
let _rotateStartAngle = 0;
/** For rotate drag: symbol rotation at drag start (degrees). */
let _rotateStartRot = 0;

/** Lock-aspect state (per session). */
let _lockAspect = false;

/** Whether alt is held (free snap). */
let _altHeld = false;

/** Type being dragged from the dock. */
let _dockDragType = null;

// ── DOM refs ───────────────────────────────────────────────────────────────────

let _stage         = null;
let _dock          = null;
let _inspector     = null;
let _setToolFn     = null;  // wallTool.setTool injected reference
let _isDrawModeFn  = null;  // wallTool.isDrawMode

// ── Init ───────────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   stage: Element,
 *   dock: Element,
 *   inspector: Element,
 *   setTool: (t:string)=>void,
 *   isDrawMode: ()=>boolean,
 * }} refs
 */
export function init(refs) {
  _stage        = refs.stage;
  _dock         = refs.dock;
  _inspector    = refs.inspector;
  _setToolFn    = refs.setTool;
  _isDrawModeFn = refs.isDrawMode;

  // Wire dock item drag-start
  if (_dock) {
    _dock.addEventListener("pointerdown", _onDockPointerDown);
  }

  // Inspector buttons
  if (_inspector) {
    const btnRotate90  = _inspector.querySelector("[data-action='rotate90']");
    const btnDuplicate = _inspector.querySelector("[data-action='duplicate']");
    const btnDelete    = _inspector.querySelector("[data-action='delete']");
    const btnLock      = _inspector.querySelector("[data-action='lock-aspect']");

    if (btnRotate90)  btnRotate90.addEventListener("click",  _onRotate90);
    if (btnDuplicate) btnDuplicate.addEventListener("click", _onDuplicate);
    if (btnDelete)    btnDelete.addEventListener("click",    _onDelete);
    if (btnLock)      btnLock.addEventListener("click",      _onToggleLockAspect);

    // Apply platform-correct chord text for the duplicate button (Edge Case 13)
    if (btnDuplicate) {
      const dupLabel = IS_MAC ? "Duplicate symbol (⌘D)" : "Duplicate symbol (Ctrl+D)";
      const dupTitle = IS_MAC ? "Duplicate (⌘D)"        : "Duplicate (Ctrl+D)";
      btnDuplicate.setAttribute("aria-label", dupLabel);
      btnDuplicate.setAttribute("title",      dupTitle);
    }
  }

  // Keyboard: Delete/Backspace for selected symbol
  window.addEventListener("keydown", _onKeyDown);
  // Alt held for free snap
  window.addEventListener("keydown", _onAltDown);
  window.addEventListener("keyup",   _onAltUp);
  window.addEventListener("blur",    _onWindowBlur);
}

// ── Public API (for interactions.js select hooks) ──────────────────────────────

/**
 * Returns true if a symbol/handle was hit (consume pointer; suppress pan).
 * @param {number} sx  screen x
 * @param {number} sy  screen y
 * @returns {boolean}
 */
export function onSelectDown(sx, sy) {
  // Cancel any open dim edit when clicking canvas (chip isolation handles its own)
  // (We do NOT cancel here — chip clicks are isolated by symbolDimEntry)

  // World point + tolerance for minimum hit target
  const tolWorld = (MIN_HIT_PX / 2) / pxPerM();
  const wp = screenToWorld(sx, sy);

  // 1. Check rotate handle for selected symbol
  if (_selectedId) {
    const sym = getSymbol(_selectedId);
    if (sym) {
      const handlePos = getRotateHandleScreen(sym);
      const hdx = sx - handlePos.x;
      const hdy = sy - handlePos.y;
      if (Math.sqrt(hdx * hdx + hdy * hdy) <= ROTATE_HIT_R) {
        // Start rotate drag
        _dragMode = "rotate";
        _rotateStartRot = sym.rot;
        _rotateStartAngle = Math.atan2(sy - worldToScreen(sym.x, sym.y).y,
                                       sx - worldToScreen(sym.x, sym.y).x);
        return true;
      }
    }
  }

  // 2. Hit-test symbols (topmost wins)
  const hit = pickSymbol(wp.x, wp.y, tolWorld);
  if (hit) {
    // Start move drag
    _selectedId = hit.id;
    _dragMode = "move";
    _dragOffsetX = wp.x - hit.x;
    _dragOffsetY = wp.y - hit.y;
    _showInspector(hit);
    scheduleRender();
    return true;
  }

  return false;
}

/**
 * Handle move or rotate drag.
 * @param {number} sx
 * @param {number} sy
 */
export function onSelectMove(sx, sy) {
  if (!_dragMode || !_selectedId) return;
  const sym = getSymbol(_selectedId);
  if (!sym) return;

  if (_dragMode === "move") {
    const wp = screenToWorld(sx, sy);
    let newX = wp.x - _dragOffsetX;
    let newY = wp.y - _dragOffsetY;

    if (!_altHeld) {
      const step = chooseGridStep();
      const snapped = gridSnap({ x: newX, y: newY }, step);
      newX = snapped.x;
      newY = snapped.y;
    }

    moveSymbol(sym, newX, newY);
    scheduleRender();
  } else if (_dragMode === "rotate") {
    const sc = worldToScreen(sym.x, sym.y);
    const currentAngle = Math.atan2(sy - sc.y, sx - sc.x);
    let deltaDeg = ((currentAngle - _rotateStartAngle) * 180) / Math.PI;

    if (!_altHeld) {
      deltaDeg = Math.round(deltaDeg / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG;
    }

    rotateSymbol(sym, _rotateStartRot + deltaDeg);
    scheduleRender();
  }
}

/**
 * Finalize drag.
 */
export function onSelectUp(sx, sy) {
  if (_dragMode !== null) {
    // Commit the drag — history.commit() diffs vs baseline, so a no-op gesture
    // (symbol returned to origin) produces no history step.
    historyCommit();
  }
  _dragMode = null;
}

/**
 * Tap on empty canvas: clear selection, close inspector.
 */
export function onTapEmpty() {
  if (isDimEditing()) {
    // Let dim entry handle it; don't deselect while editing
    return;
  }
  _clearSelection();
  scheduleRender();
}

/** For symbolRender: current selected id. */
export function getSelectedId() {
  return _selectedId;
}

/** True when a symbol is currently selected. */
export function hasSelection() {
  return _selectedId !== null;
}

/** Duplicate the selected symbol (wraps _onDuplicate). No-op if nothing selected. */
export function duplicateSelected() {
  _onDuplicate();
}

/** Delete the selected symbol (wraps _deleteSelected). No-op if nothing selected. */
export function deleteSelected() {
  if (!_selectedId) return;
  _deleteSelectedWithToast();
}

/** Rotate the selected symbol 90° (wraps _onRotate90). No-op if nothing selected. */
export function rotateSelected() {
  _onRotate90();
}

/**
 * True when a symbol drag is in progress.
 * Used by history/shortcuts to guard undo/redo during active pointer drag.
 */
export function isDragging() {
  return _dragMode !== null;
}

/** For symbolRender: placement ghost, or null. */
export function getPlacementGhost() {
  return _ghost;
}

/**
 * Call when switching to draw mode (wallTool.setTool("wall")).
 * Clears symbol selection and hides inspector (Edge Case 12).
 */
export function onDrawModeEnter() {
  _clearSelection();
  scheduleRender();
}

/**
 * Called by history after a restore: if the currently selected symbol no longer
 * exists in the model, clear selection and hide inspector.
 */
export function clearSelectionIfStale() {
  if (_selectedId && !getSymbol(_selectedId)) {
    _clearSelection();
  }
}

/**
 * Select a symbol by id (e.g. after placement).
 */
export function selectSymbol(id) {
  _selectedId = id;
  const sym = getSymbol(id);
  if (sym) _showInspector(sym);
  scheduleRender();
}

// ── Dock drag-placement ────────────────────────────────────────────────────────

function _onDockPointerDown(e) {
  const btn = e.target.closest("[data-type]");
  if (!btn) return;
  const type = btn.getAttribute("data-type");
  if (!CATALOG[type]) return;

  // Switch to select mode if currently in draw mode
  if (_isDrawModeFn && _isDrawModeFn()) {
    _setToolFn && _setToolFn("select");
  }

  e.preventDefault();
  _dockDragType = type;

  // Capture pointer on window so we can track outside the dock
  const cat = CATALOG[type];

  // Seed ghost at current pointer position
  const wp = _snapToGrid(e.clientX, e.clientY, false);
  _ghost = {
    type,
    x: wp.x,
    y: wp.y,
    w: cat.w,
    h: cat.h,
    rot: 0,
  };

  // Mark dock item active
  _updateDockActive(type);

  _dock.setPointerCapture(e.pointerId);

  const _onMove = (ev) => {
    if (_dockDragType === null) return;
    const cat2 = CATALOG[_dockDragType];
    const wp2 = _snapToGrid(ev.clientX, ev.clientY, ev.altKey);
    _ghost = {
      type: _dockDragType,
      x: wp2.x,
      y: wp2.y,
      w: cat2.w,
      h: cat2.h,
      rot: 0,
    };
    scheduleRender();
  };

  const _onUp = (ev) => {
    _dock.removeEventListener("pointermove", _onMove);
    _dock.removeEventListener("pointerup",   _onUp);
    _dock.removeEventListener("pointercancel", _onUp);

    const typeWas = _dockDragType;
    _dockDragType = null;
    _ghost = null;
    _updateDockActive(null);

    // Check if the release was over the canvas (not the dock)
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const overDock = _dock.contains(target);
    if (overDock || !_stage.contains(target)) {
      // Released off-canvas or back on dock: cancel (Edge Case 1)
      scheduleRender();
      return;
    }

    // Drop the symbol
    const cat2 = CATALOG[typeWas];
    const wp2 = _snapToGrid(ev.clientX, ev.clientY, ev.altKey);
    const sym = createSymbol(typeWas, wp2.x, wp2.y);
    addSymbol(sym);
    selectSymbol(sym.id);
    historyCommit();
    scheduleRender();
  };

  _dock.addEventListener("pointermove", _onMove);
  _dock.addEventListener("pointerup",   _onUp);
  _dock.addEventListener("pointercancel", _onUp);

  scheduleRender();
}

function _snapToGrid(sx, sy, altHeld) {
  const wp = screenToWorld(sx, sy);
  if (altHeld) return wp;
  const step = chooseGridStep();
  return gridSnap(wp, step);
}

function _updateDockActive(type) {
  if (!_dock) return;
  for (const btn of _dock.querySelectorAll("[data-type]")) {
    btn.classList.toggle("dock-item--active", btn.getAttribute("data-type") === type);
  }
}

// ── Inspector actions ──────────────────────────────────────────────────────────

function _onRotate90() {
  if (!_selectedId) return;
  const sym = getSymbol(_selectedId);
  if (!sym) return;
  rotateSymbol(sym, sym.rot + 90);
  historyCommit();
  scheduleRender();
}

function _onDuplicate() {
  if (!_selectedId) return;
  const dup = duplicateSymbol(_selectedId);
  if (dup) {
    selectSymbol(dup.id);
    historyCommit();
    if (_showToast) _showToast("Duplicated");
  }
  scheduleRender();
}

function _onDelete() {
  if (!_selectedId) return;
  _deleteSelectedWithToast();
}

function _onToggleLockAspect() {
  _lockAspect = !_lockAspect;
  const btn = _inspector && _inspector.querySelector("[data-action='lock-aspect']");
  if (btn) {
    btn.setAttribute("aria-pressed", _lockAspect ? "true" : "false");
  }
}

/** Return the current lock-aspect state. Injected into symbolDimEntry so commit() can use it. */
export function getLockAspect() {
  return _lockAspect;
}

/**
 * surface.onRender hook — reposition the inspector every frame so it tracks
 * the selected symbol during pan, zoom, and move-drag (Edge Case 15).
 */
export function repositionInspector() {
  if (!_selectedId || !_inspector || !_inspector.classList.contains("visible")) return;
  const sym = getSymbol(_selectedId);
  if (sym) _positionInspector(sym);
}

/**
 * Delete selected symbol and show an "Undo" actionable toast.
 */
function _deleteSelectedWithToast() {
  if (!_selectedId) return;
  if (isDimEditing()) cancelDimEdit();
  removeSymbol(_selectedId);
  _clearSelection();
  historyCommit();
  if (_showToast) {
    _showToast("Deleted", {
      actionLabel: "Undo",
      onAction: () => historyUndo(),
    });
  }
  scheduleRender();
}

function _deleteSelected() {
  if (!_selectedId) return;
  if (isDimEditing()) cancelDimEdit();
  removeSymbol(_selectedId);
  _clearSelection();
  historyCommit();
  scheduleRender();
}

// ── Inspector visibility ───────────────────────────────────────────────────────

function _showInspector(sym) {
  if (!_inspector) return;
  _inspector.classList.add("visible");
  _positionInspector(sym);

  // Update lock-aspect button state
  const btnLock = _inspector.querySelector("[data-action='lock-aspect']");
  if (btnLock) {
    btnLock.setAttribute("aria-pressed", _lockAspect ? "true" : "false");
  }
}

function _hideInspector() {
  if (!_inspector) return;
  _inspector.classList.remove("visible");
}

function _positionInspector(sym) {
  if (!_inspector || !sym) return;

  // Place inspector near the selected symbol, clamped to viewport
  const sc = worldToScreen(sym.x, sym.y);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const iw = _inspector.offsetWidth  || 160;
  const ih = _inspector.offsetHeight || 44;

  // Try to place it above the symbol
  const ppm = pxPerM();
  const halfH = (sym.h / 2) * ppm + 16;
  let ix = sc.x - iw / 2;
  let iy = sc.y - halfH - ih - 4;

  // Clamp to viewport
  ix = Math.max(8, Math.min(vw - iw - 8, ix));
  iy = Math.max(8, Math.min(vh - ih - 8, iy));

  _inspector.style.left = ix + "px";
  _inspector.style.top  = iy + "px";
}

function _clearSelection() {
  _selectedId = null;
  _dragMode = null;
  if (isDimEditing()) cancelDimEdit();
  _hideInspector();
}

// ── Keyboard ───────────────────────────────────────────────────────────────────

function _onKeyDown(e) {
  if (e.ctrlKey || e.metaKey) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  // Guard: suppress all non-chord keys while the shortcuts modal is open.
  // shortcuts.js owns Esc (close modal) in that state; symbolTool must not also react.
  if (isModalOpen()) return;

  if ((e.key === "Delete" || e.key === "Backspace") && _selectedId) {
    // Only delete symbol if not in wall draw mode
    if (_isDrawModeFn && _isDrawModeFn()) return;
    e.preventDefault();
    _deleteSelectedWithToast();
    return;
  }

  // R key: rotate selected symbol 90° (select mode only)
  if (e.key === "r" || e.key === "R") {
    if (_isDrawModeFn && _isDrawModeFn()) return;
    if (_selectedId) {
      _onRotate90();
    }
    return;
  }

  // Esc: clear symbol selection in select mode (wallTool handles Esc for draw mode)
  if (e.key === "Escape") {
    if (_isDrawModeFn && _isDrawModeFn()) return; // wallTool owns Esc in draw mode
    if (_selectedId) {
      _clearSelection();
      scheduleRender();
    }
  }
}

function _onAltDown(e) {
  if (e.code === "AltLeft" || e.code === "AltRight") {
    _altHeld = true;
  }
}

function _onAltUp(e) {
  if (e.code === "AltLeft" || e.code === "AltRight") {
    _altHeld = false;
  }
}

function _onWindowBlur() {
  _altHeld = false;
}
