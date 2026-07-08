/**
 * symbolTool.js — palette, placement, selection controller, inspector
 *
 * Handles:
 *  - Dock drag-placement (self-contained pointer capture from the dock)
 *  - Select-mode hooks: onSelectDown / onSelectMove / onSelectUp / onTapEmpty
 *  - Inspector actions: rotate 90°, duplicate, delete, lock-aspect
 *  - Integrates with wallTool.setTool to switch to select mode on dock drag
 *
 * NOTE (LLD-21): Delete/Backspace keyboard handling has been removed from this
 * module. Symbol delete via keyboard is now owned solely by the main.js global
 * editing-shortcut handler, which calls the committing deleteSelected().
 */

import { screenToWorld, worldToScreen, pxPerM } from "./view.js";
import { gridSnap, wallSegments, WALL_M } from "./walls.js";
import { snapStep } from "./grid.js";
import {
  model, CATALOG,
  createSymbol, addSymbol, removeSymbol, duplicateSymbol,
  getSymbol, pickSymbol, moveSymbol, rotateSymbol, resizeSymbol, corners,
  WALL_FLUSH_PX, PARALLEL_TOL_DEG, nearestWallFlush,
} from "./symbols.js";
import { gridSnap as prefsGridSnap } from "./prefs.js";
import { scheduleRender } from "./surface.js";
import { getRotateHandleScreen } from "./symbolRender.js";
import { beginEdit as beginDimEdit, cancel as cancelDimEdit, isEditing as isDimEditing } from "./symbolDimEntry.js";

// history and showToast are injected to avoid circular dependencies at init time
let _historyCommit = null;
let _showToastFn   = null;
let _historyUndo   = null;
let _historyDepth  = null;

/**
 * Inject history / toast functions from main.js.
 * @param {{ commit:()=>void, undo:()=>boolean, depth:()=>number }} history
 * @param {(msg:string, action?:{label:string,onClick:()=>void})=>void} showToast
 */
export function setHistoryAndToast(history, showToast) {
  _historyCommit = history.commit;
  _historyUndo   = history.undo;
  _historyDepth  = history.depth;
  _showToastFn   = showToast;
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

/**
 * Current flush-guide candidate during an active symbol gesture.
 * Null when no flush snap is active.
 * @type {import("./symbols.js").FlushCandidate|null}
 */
let _flushGuide = null;

// ── DOM refs ───────────────────────────────────────────────────────────────────

let _stage         = null;
let _dock          = null;
let _inspector     = null;
let _snapTagEl     = null;   // .snap-tag (shared with wallTool; symbol path owns it during gestures)
let _gSymOverlay   = null;   // #symbol-overlay SVG group (for flush guide line)
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
 *   snapTag?: Element,
 *   symOverlay?: SVGGElement,
 * }} refs
 */
export function init(refs) {
  _stage        = refs.stage;
  _dock         = refs.dock;
  _inspector    = refs.inspector;
  _snapTagEl    = refs.snapTag  || null;
  _gSymOverlay  = refs.symOverlay || null;
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
  }

  // NOTE (LLD-21): _onKeyDown (Delete/Backspace) is NOT registered here.
  // Symbol delete via keyboard is now owned solely by the main.js global handler.
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
    // The drag offset tells us where in the symbol's local frame the user
    // grabbed it. The desired world center is: raw pointer world - drag offset.
    const wp = screenToWorld(sx, sy);
    const rawCenterX = wp.x - _dragOffsetX;
    const rawCenterY = wp.y - _dragOffsetY;

    // Convert the desired center back to screen so _resolvePlacement can
    // convert it back to world (this round-trip is lossless).
    const scCenter = worldToScreen(rawCenterX, rawCenterY);
    const resolved = _resolvePlacement(scCenter.x, scCenter.y, _altHeld, sym);
    _updateSnapTag(sx, sy, resolved.snapType);
    _updateFlushGuide(resolved);

    moveSymbol(sym, resolved.x, resolved.y);
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
 * Finalize drag (move or rotate).
 * Commits to history; dirty-check in history.commit() handles the no-op case
 * (e.g. zero-distance drag or rotate returning to the same angle).
 */
export function onSelectUp(sx, sy) {
  _dragMode = null;
  _flushGuide = null;
  _hideSnapTag();
  _clearFlushGuideLine();
  // Commit move/rotate to history (dirty-check handles no-op)
  if (_historyCommit) _historyCommit();
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

  // Seed ghost at current pointer position (use a temp box matching catalog dims)
  const seedBox = { type, x: 0, y: 0, w: cat.w, h: cat.h, rot: 0 };
  const wp = _resolvePlacement(e.clientX, e.clientY, false, seedBox);
  _ghost = {
    type,
    x: wp.x,
    y: wp.y,
    w: cat.w,
    h: cat.h,
    rot: 0,
  };
  _updateSnapTag(e.clientX, e.clientY, wp.snapType);

  // Mark dock item active
  _updateDockActive(type);

  _dock.setPointerCapture(e.pointerId);

  const _onMove = (ev) => {
    if (_dockDragType === null) return;
    const cat2 = CATALOG[_dockDragType];
    const ghostBox = _ghost || { type: _dockDragType, x: 0, y: 0, w: cat2.w, h: cat2.h, rot: 0 };
    const wp2 = _resolvePlacement(ev.clientX, ev.clientY, ev.altKey, ghostBox);
    _ghost = {
      type: _dockDragType,
      x: wp2.x,
      y: wp2.y,
      w: cat2.w,
      h: cat2.h,
      rot: 0,
    };
    _updateSnapTag(ev.clientX, ev.clientY, wp2.snapType);
    _updateFlushGuide(wp2);
    scheduleRender();
  };

  const _onUp = (ev) => {
    _dock.removeEventListener("pointermove", _onMove);
    _dock.removeEventListener("pointerup",   _onUp);
    _dock.removeEventListener("pointercancel", _onUp);

    const typeWas = _dockDragType;
    _dockDragType = null;
    _ghost = null;
    _flushGuide = null;
    _hideSnapTag();
    _clearFlushGuideLine();
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
    const dropBox = { type: typeWas, x: 0, y: 0, w: cat2.w, h: cat2.h, rot: 0 };
    const wp2 = _resolvePlacement(ev.clientX, ev.clientY, ev.altKey, dropBox);
    const sym = createSymbol(typeWas, wp2.x, wp2.y);
    addSymbol(sym);
    selectSymbol(sym.id);
    // Commit gesture to history
    if (_historyCommit) _historyCommit();
    scheduleRender();
  };

  _dock.addEventListener("pointermove", _onMove);
  _dock.addEventListener("pointerup",   _onUp);
  _dock.addEventListener("pointercancel", _onUp);

  scheduleRender();
}

/**
 * Resolve a symbol's placement point for a given raw screen pointer.
 *
 * Precedence:
 *   1. Alt held → raw world point (transient bypass; independent of grid toggle)
 *   2. Wall-flush → if a wall face is within threshold, seat the near edge flush.
 *      - Perpendicular axis: flush-snapped.
 *      - Parallel axis: grid-snapped when gridSnap is on, otherwise raw.
 *   3. Grid → if prefs.gridSnap() on and snapStep() non-null, gridSnap(raw, step).
 *   4. Raw → else the raw world point.
 *
 * @param {number} sx  screen x
 * @param {number} sy  screen y
 * @param {boolean} altHeld
 * @param {{ type:string, x:number, y:number, w:number, h:number, rot:number }} boxLike
 *   ghost or live symbol (for flush geometry)
 * @returns {{ x:number, y:number, snapType:"flush"|"grid"|"free" }}
 */
function _resolvePlacement(sx, sy, altHeld, boxLike) {
  const raw = screenToWorld(sx, sy);

  // 1. Alt held → raw
  if (altHeld) {
    _flushGuide = null;
    return { x: raw.x, y: raw.y, snapType: "free" };
  }

  // Compute symbol corners at the raw position (for flush geometry)
  const tempSym = { ...boxLike, x: raw.x, y: raw.y };
  const symCorners = corners(tempSym);

  // 2. Wall-flush
  const thresholdM = WALL_FLUSH_PX / pxPerM();
  const segs = wallSegments();
  const flush = nearestWallFlush(symCorners, segs, WALL_M, thresholdM, PARALLEL_TOL_DEG);

  if (flush !== null) {
    _flushGuide = flush;

    // flush.dx/dy is the perpendicular correction from raw to seat the near edge flush.
    // The flushed center is (raw.x + flush.dx, raw.y + flush.dy).
    // We must NOT re-snap the perpendicular axis — only the parallel axis is grid-snapped.
    // Strategy:
    //   1. Compute the flush result: flushedX = raw.x + flush.dx, flushedY = raw.y + flush.dy
    //   2. If grid is on, decompose flushedX/Y into (t, n) components relative to the wall
    //      that produced the flush candidate, grid-snap the t component, leave n untouched.
    //
    // We recover the wall direction from flush.guide: guide.a and guide.b are world points
    // on the wall face, so t = normalize(guide.b - guide.a).

    const flushedX = raw.x + flush.dx;
    const flushedY = raw.y + flush.dy;

    if (prefsGridSnap()) {
      const step = snapStep();
      if (step != null) {
        // Recover wall direction t and normal n from the guide segment
        const gDx = flush.guide.b.x - flush.guide.a.x;
        const gDy = flush.guide.b.y - flush.guide.a.y;
        const gLen = Math.sqrt(gDx * gDx + gDy * gDy);
        if (gLen > 1e-9) {
          const tx = gDx / gLen;
          const ty = gDy / gLen;
          // nx/ny are the normal (perpendicular to wall)
          const nx = ty;
          const ny = -tx;

          // Project flushed center onto t and n
          const tComp = flushedX * tx + flushedY * ty;
          const nComp = flushedX * nx + flushedY * ny;

          // Grid-snap only the t component
          const tSnapped = Math.round(tComp / step) * step;

          // Reconstruct: keep n component exact (flush), snap t component
          return {
            x: tSnapped * tx + nComp * nx,
            y: tSnapped * ty + nComp * ny,
            snapType: "flush",
          };
        }
      }
    }

    return { x: flushedX, y: flushedY, snapType: "flush" };
  }

  _flushGuide = null;

  // 3. Grid
  if (prefsGridSnap()) {
    const step = snapStep();
    if (step != null) {
      const snapped = gridSnap(raw, step);
      return { x: snapped.x, y: snapped.y, snapType: "grid" };
    }
  }

  // 4. Raw
  return { x: raw.x, y: raw.y, snapType: "free" };
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
  if (_historyCommit) _historyCommit();
  scheduleRender();
}

function _onDuplicate() {
  duplicateSelected();
}

function _onDelete() {
  deleteSelected();
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

/** @returns {boolean} true when a symbol is currently selected */
export function hasSelection() {
  return _selectedId !== null;
}

/**
 * Delete the currently selected symbol. Shows "Deleted" toast with one-tap
 * Undo (scoped to the depth at delete time per Edge Case 14).
 * Called by the inspector Delete button and by the main.js global shortcut handler.
 */
export function deleteSelected() {
  if (!_selectedId) return;
  if (isDimEditing()) cancelDimEdit();
  removeSymbol(_selectedId);
  _clearSelection();
  if (_historyCommit) _historyCommit();
  // Show Undo-affordance toast scoped to this delete step (Edge Case 14)
  if (_showToastFn && _historyDepth && _historyUndo) {
    const atDepth = _historyDepth();
    _showToastFn("Deleted", {
      label: "Undo",
      onClick() {
        // Only undo if the delete is still the top of the undo stack
        if (_historyDepth() === atDepth) {
          _historyUndo();
          scheduleRender();
        }
      },
    });
  }
  scheduleRender();
}

/**
 * Duplicate the currently selected symbol. Shows "Duplicated" toast.
 * Called by the inspector Duplicate button and by the main.js global shortcut handler.
 */
export function duplicateSelected() {
  if (!_selectedId) return;
  const dup = duplicateSymbol(_selectedId);
  if (dup) {
    selectSymbol(dup.id);
    if (_historyCommit) _historyCommit();
    if (_showToastFn) _showToastFn("Duplicated");
  }
  scheduleRender();
}

/** Internal: raw delete without commit/toast (kept for legacy call sites that
 *  have been migrated to deleteSelected; now unused but retained for clarity). */
function _deleteSelected() {
  if (!_selectedId) return;
  if (isDimEditing()) cancelDimEdit();
  removeSymbol(_selectedId);
  _clearSelection();
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
// NOTE (LLD-21): _onKeyDown (Delete/Backspace) has been removed.
// Symbol delete via keyboard is now owned solely by the main.js global
// editing-shortcut handler, which calls the committing deleteSelected().
// The _onAltDown / _onAltUp / _onWindowBlur listeners remain unchanged.

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

// ── Snap-tag (cursor label) ───────────────────────────────────────────────────

const _SNAP_TAG_COLORS = {
  flush: "#9cd67a",
  grid:  "#7fd0c8",
  free:  "#8f8a78",
};

/**
 * Show the .snap-tag near (sx, sy) with the given snapType label.
 * Only active while a symbol gesture is in progress and we are NOT in draw mode.
 * @param {number} sx  screen x (cursor position)
 * @param {number} sy  screen y
 * @param {"flush"|"grid"|"free"} snapType
 */
function _updateSnapTag(sx, sy, snapType) {
  if (!_snapTagEl) return;
  // Guard: only show in select/placement mode; wallTool owns it in draw mode
  if (_isDrawModeFn && _isDrawModeFn()) return;

  const label = snapType;
  const color = _SNAP_TAG_COLORS[snapType] || "#8f8a78";
  _snapTagEl.textContent = label;
  _snapTagEl.style.color = color;
  _snapTagEl.style.display = "block";

  // Position near cursor; clamp to viewport (mirrors wallTool._positionSnapTag)
  const offset = 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = _snapTagEl.offsetWidth  || 50;
  const h = _snapTagEl.offsetHeight || 18;
  let lx = sx + offset;
  let ly = sy - offset;
  if (lx + w > vw - 8) lx = sx - w - offset;
  if (ly < 8) ly = sy + offset;
  if (ly + h > vh - 8) ly = vh - h - 8;
  _snapTagEl.style.left = lx + "px";
  _snapTagEl.style.top  = ly + "px";
}

function _hideSnapTag() {
  if (_snapTagEl) _snapTagEl.style.display = "none";
}

// ── Flush guide line ──────────────────────────────────────────────────────────

const NS_SVG = "http://www.w3.org/2000/svg";
let _flushGuideLine = null;  // lazily created <line> element in #symbol-overlay

/**
 * Update or clear the flush guide line in the symbol overlay.
 * @param {{ snapType:string, x:number, y:number }} resolved
 */
function _updateFlushGuide(resolved) {
  if (!_gSymOverlay) return;

  if (resolved.snapType !== "flush" || !_flushGuide) {
    _clearFlushGuideLine();
    return;
  }

  // Lazy-create the guide line element
  if (!_flushGuideLine) {
    _flushGuideLine = document.createElementNS(NS_SVG, "line");
    _flushGuideLine.setAttribute("class", "flush-guide");
    _flushGuideLine.setAttribute("stroke", "#9cd67a");
    _flushGuideLine.setAttribute("stroke-width", "1");
    _flushGuideLine.setAttribute("stroke-dasharray", "4 3");
    _flushGuideLine.setAttribute("opacity", "0.55");
    _gSymOverlay.appendChild(_flushGuideLine);
  }

  // Convert guide endpoints to screen coords
  const sa = worldToScreen(_flushGuide.guide.a.x, _flushGuide.guide.a.y);
  const sb = worldToScreen(_flushGuide.guide.b.x, _flushGuide.guide.b.y);
  _flushGuideLine.setAttribute("x1", String(sa.x));
  _flushGuideLine.setAttribute("y1", String(sa.y));
  _flushGuideLine.setAttribute("x2", String(sb.x));
  _flushGuideLine.setAttribute("y2", String(sb.y));

  // Ensure it is in the overlay (symbolRender clears overlay each frame, so we re-append)
  if (!_gSymOverlay.contains(_flushGuideLine)) {
    _gSymOverlay.appendChild(_flushGuideLine);
  }
}

function _clearFlushGuideLine() {
  if (_flushGuideLine && _flushGuideLine.parentNode) {
    _flushGuideLine.parentNode.removeChild(_flushGuideLine);
  }
  // Keep the element cached; just not in the DOM
}

/**
 * Re-append the flush guide line into the overlay after symbolRender clears it.
 * Registered as a post-render hook (after symbolRenderFn) so the line survives
 * the per-frame _clearGroup that symbolRender runs on #symbol-overlay.
 * Called every frame; no-ops when no guide is active.
 */
export function repositionFlushGuide() {
  if (!_gSymOverlay || !_flushGuideLine || !_flushGuide) return;
  // Only show during an active gesture in select/placement mode
  if (_isDrawModeFn && _isDrawModeFn()) return;
  if (!_flushGuideLine.parentNode) {
    _gSymOverlay.appendChild(_flushGuideLine);
  }
  // Recompute screen coords from world guide (view may have panned/zoomed)
  const sa = worldToScreen(_flushGuide.guide.a.x, _flushGuide.guide.a.y);
  const sb = worldToScreen(_flushGuide.guide.b.x, _flushGuide.guide.b.y);
  _flushGuideLine.setAttribute("x1", String(sa.x));
  _flushGuideLine.setAttribute("y1", String(sa.y));
  _flushGuideLine.setAttribute("x2", String(sb.x));
  _flushGuideLine.setAttribute("y2", String(sb.y));
}
