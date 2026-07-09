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
  ALIGN_PX, aabb as symAabb, nearestObjectAlignment,
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

/**
 * Active transient guides for the current gesture (wall-flush + alignment).
 * Each entry: { color:string, label:string, guide:{a,b} }
 * Rebuilt on each pointer move; cleared on gesture end.
 * @type {{ color:string, label:string, guide:{a:{x,y},b:{x,y}} }[]}
 */
let _activeGuides = [];

/**
 * Candidate AABBs for the current gesture (all symbols except the dragged one).
 * Rebuilt at gesture start; refreshed lazily per-move only for the dragged AABB.
 * @type {{ minX:number, maxX:number, cx:number, minY:number, maxY:number, cy:number }[]}
 */
let _candidateAABBs = [];

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
    // Build candidate AABB list once at drag start (excluding the dragged symbol)
    _candidateAABBs = model.symbols
      .filter(s => s.id !== hit.id)
      .map(s => symAabb(s));
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
    _updateSnapTag(sx, sy, resolved.snapType, { x: resolved._alignX, y: resolved._alignY });
    _updateGuides(resolved);

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
  _activeGuides = [];
  _candidateAABBs = [];
  _hideSnapTag();
  _clearGuides();
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

  // Build candidate AABB list at drag start — the ghost isn't in the model yet
  // so nothing is excluded (LLD-34 Edge Case 9 / Interfaces ~line 224).
  _candidateAABBs = model.symbols.map(s => symAabb(s));

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
  _updateSnapTag(e.clientX, e.clientY, wp.snapType, { x: wp._alignX, y: wp._alignY });

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
    _updateSnapTag(ev.clientX, ev.clientY, wp2.snapType, { x: wp2._alignX, y: wp2._alignY });
    _updateGuides(wp2);
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
    _activeGuides = [];
    _candidateAABBs = [];
    _hideSnapTag();
    _clearGuides();
    _updateDockActive(null);

    // Check if the release was over the canvas (not the dock)
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const overDock = _dock.contains(target);
    if (overDock || !_stage.contains(target)) {
      // Released off-canvas or back on dock: cancel (Edge Case 1)
      scheduleRender();
      return;
    }

    // Drop the symbol — rebuild candidates for the final snap resolve (they were
    // cleared above; ghost isn't in the model yet so exclude nothing).
    _candidateAABBs = model.symbols.map(s => symAabb(s));
    const cat2 = CATALOG[typeWas];
    const dropBox = { type: typeWas, x: 0, y: 0, w: cat2.w, h: cat2.h, rot: 0 };
    const wp2 = _resolvePlacement(ev.clientX, ev.clientY, ev.altKey, dropBox);
    _candidateAABBs = [];
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
 * Per-axis precedence: Alt bypass > wall-flush > object alignment > grid > raw.
 *
 * Wall-flush is exempt from the gridSnap toggle (it is the hero "seat against wall"
 * behavior). Object alignment and grid both obey prefs.gridSnap().
 *
 * @param {number} sx  screen x
 * @param {number} sy  screen y
 * @param {boolean} altHeld
 * @param {{ type:string, x:number, y:number, w:number, h:number, rot:number }} boxLike
 *   ghost or live symbol (for flush geometry)
 * @returns {{ x:number, y:number, snapType:"flush"|"align"|"grid"|"free", _flushActive:boolean, _alignX:import("./symbols.js").AlignAxisMatch|null, _alignY:import("./symbols.js").AlignAxisMatch|null }}
 */
function _resolvePlacement(sx, sy, altHeld, boxLike) {
  const raw = screenToWorld(sx, sy);

  // 1. Alt held → raw on both axes; clear all guides
  if (altHeld) {
    _flushGuide = null;
    _activeGuides = [];
    return { x: raw.x, y: raw.y, snapType: "free", _flushActive: false, _alignX: null, _alignY: null };
  }

  // Compute symbol at the raw position (for flush and alignment geometry)
  const tempSym = { ...boxLike, x: raw.x, y: raw.y };
  const symCorners = corners(tempSym);

  // 2. Wall-flush (ungated — active regardless of gridSnap toggle)
  const flushThreshM = WALL_FLUSH_PX / pxPerM();
  const segs = wallSegments();
  const flush = nearestWallFlush(symCorners, segs, WALL_M, flushThreshM, PARALLEL_TOL_DEG);

  // Per-axis resolution state
  let resolvedX = raw.x;
  let resolvedY = raw.y;
  let xClaimed = false; // true when wall-flush owns this axis
  let yClaimed = false;
  let snapTypeX = "free";
  let snapTypeY = "free";
  let flushActive = false;
  let alignX = null;
  let alignY = null;

  if (flush !== null) {
    _flushGuide = flush;
    flushActive = true;

    const flushedX = raw.x + flush.dx;
    const flushedY = raw.y + flush.dy;

    // Determine which axis the wall is perpendicular to (axis-aligned wall check)
    // Guide direction gives us the wall's tangent vector; normal = flush normal
    const gDx = flush.guide.b.x - flush.guide.a.x;
    const gDy = flush.guide.b.y - flush.guide.a.y;
    const gLen = Math.sqrt(gDx * gDx + gDy * gDy);

    if (gLen > 1e-9) {
      const tx = gDx / gLen;
      const ty = gDy / gLen;
      // Normal: 90° CW of tangent
      const nx = ty;
      const ny = -tx;

      // Check if the wall is axis-aligned (normal is ≈ ±X or ≈ ±Y)
      const EPS = Math.sin((5 * Math.PI) / 180); // ~5° tolerance
      const nIsX = Math.abs(Math.abs(nx) - 1) < EPS; // normal ≈ ±X → flush corrects X
      const nIsY = Math.abs(Math.abs(ny) - 1) < EPS; // normal ≈ ±Y → flush corrects Y

      if (nIsX) {
        // Flush owns X; Y is free for alignment/grid
        resolvedX = flushedX;
        xClaimed = true;
        snapTypeX = "flush";
      } else if (nIsY) {
        // Flush owns Y; X is free for alignment/grid
        resolvedY = flushedY;
        yClaimed = true;
        snapTypeY = "flush";
      } else {
        // Angled wall: fall back to legacy (t, n) decomposition (Edge Case 8)
        // Grid-snap the t component; flush the n component. Skip alignment for this gesture.
        if (prefsGridSnap()) {
          const step = snapStep();
          if (step != null) {
            const tComp = flushedX * tx + flushedY * ty;
            const nComp = flushedX * nx + flushedY * ny;
            const tSnapped = Math.round(tComp / step) * step;
            return {
              x: tSnapped * tx + nComp * nx,
              y: tSnapped * ty + nComp * ny,
              snapType: "flush",
              _flushActive: true,
              _alignX: null,
              _alignY: null,
            };
          }
        }
        return {
          x: flushedX,
          y: flushedY,
          snapType: "flush",
          _flushActive: true,
          _alignX: null,
          _alignY: null,
        };
      }
    } else {
      // Degenerate guide — apply full flush delta
      resolvedX = flushedX;
      resolvedY = flushedY;
      xClaimed = true;
      yClaimed = true;
      snapTypeX = "flush";
      snapTypeY = "flush";
    }
  } else {
    _flushGuide = null;
  }

  // 3. Object alignment (gated by prefs.gridSnap())
  if (prefsGridSnap() && _candidateAABBs.length > 0) {
    const alignThreshM = ALIGN_PX / pxPerM();
    const dragAABBVal = symAabb(tempSym);
    const alignResult = nearestObjectAlignment(dragAABBVal, _candidateAABBs, alignThreshM);

    if (!xClaimed && alignResult.x !== null) {
      resolvedX = raw.x + alignResult.x.delta;
      xClaimed = true;
      snapTypeX = "align";
      alignX = alignResult.x;
    }

    if (!yClaimed && alignResult.y !== null) {
      resolvedY = raw.y + alignResult.y.delta;
      yClaimed = true;
      snapTypeY = "align";
      alignY = alignResult.y;
    }
  }

  // 4. Grid (gated by prefs.gridSnap() and snapStep() non-null)
  if (prefsGridSnap()) {
    const step = snapStep();
    if (step != null) {
      if (!xClaimed) {
        resolvedX = Math.round(raw.x / step) * step;
        snapTypeX = "grid";
      }
      if (!yClaimed) {
        resolvedY = Math.round(raw.y / step) * step;
        snapTypeY = "grid";
      }
    }
  }

  // Dominant snapType: flush > align > grid > free
  const PRIORITY = { flush: 3, align: 2, grid: 1, free: 0 };
  const snapType = PRIORITY[snapTypeX] >= PRIORITY[snapTypeY] ? snapTypeX : snapTypeY;

  return {
    x: resolvedX,
    y: resolvedY,
    snapType,
    _flushActive: flushActive,
    _alignX: alignX,
    _alignY: alignY,
  };
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
  align: "#b98bd9",   // violet — edge alignment dominant (may also be teal for center)
  grid:  "#7fd0c8",
  free:  "#8f8a78",
};

/**
 * Show the .snap-tag near (sx, sy) with the given snapType label.
 * Only active while a symbol gesture is in progress and we are NOT in draw mode.
 * @param {number} sx  screen x (cursor position)
 * @param {number} sy  screen y
 * @param {"flush"|"align"|"grid"|"free"} snapType
 * @param {{ x:import("./symbols.js").AlignAxisMatch|null, y:import("./symbols.js").AlignAxisMatch|null } | undefined} [alignMatches]
 */
function _updateSnapTag(sx, sy, snapType, alignMatches) {
  if (!_snapTagEl) return;
  // Guard: only show in select/placement mode; wallTool owns it in draw mode
  if (_isDrawModeFn && _isDrawModeFn()) return;

  let color = _SNAP_TAG_COLORS[snapType] || "#8f8a78";

  // For align snap: use teal if all active matches are center-kind, violet if any edge
  if (snapType === "align" && alignMatches) {
    const matches = [alignMatches.x, alignMatches.y].filter(Boolean);
    const allCenter = matches.length > 0 && matches.every(m => m.kind === "center");
    color = allCenter ? _COLOR_CENTER : _COLOR_EDGE;
  }

  const label = snapType;
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

// ── Guide lines (wall-flush + alignment) ─────────────────────────────────────

const NS_SVG = "http://www.w3.org/2000/svg";

// Colors
const _COLOR_FLUSH  = "#9cd67a";  // green  — wall-flush (LLD 26)
const _COLOR_EDGE   = "#b98bd9";  // violet — edge-to-edge alignment
const _COLOR_CENTER = "#7fd0c8";  // teal   — center-to-center alignment

/**
 * Cached SVG elements for guides: up to 1 flush + 2 alignment (X and Y).
 * Each element is a <g> containing a <line>, <rect>, and <text>.
 * Elements are lazily created; not in the DOM when no guide is active.
 */
let _flushGuideLine = null;     // legacy <line> for wall-flush (style: dashed)
let _alignGuideEls = [];        // up to 2 <g> elements for alignment guides

/**
 * Rebuild _activeGuides from the latest resolved placement result and
 * update the guide DOM elements accordingly.
 *
 * @param {{ snapType:string, _flushActive:boolean, _alignX:import("./symbols.js").AlignAxisMatch|null, _alignY:import("./symbols.js").AlignAxisMatch|null }} resolved
 */
function _updateGuides(resolved) {
  _activeGuides = [];

  if (!_gSymOverlay) return;

  // Wall-flush guide (unchanged from LLD 26 — dashed green line only, no label chip)
  if (resolved._flushActive && _flushGuide) {
    _activeGuides.push({
      kind: "flush",
      color: _COLOR_FLUSH,
      label: null,
      guide: _flushGuide.guide,
    });
  }

  // Alignment guides
  if (resolved._alignX !== null) {
    const color = resolved._alignX.kind === "center" ? _COLOR_CENTER : _COLOR_EDGE;
    _activeGuides.push({
      kind: "align",
      color,
      label: resolved._alignX.kind === "center" ? "centers" : "edges",
      guide: resolved._alignX.guide,
    });
  }
  if (resolved._alignY !== null) {
    const color = resolved._alignY.kind === "center" ? _COLOR_CENTER : _COLOR_EDGE;
    _activeGuides.push({
      kind: "align",
      color,
      label: resolved._alignY.kind === "center" ? "centers" : "edges",
      guide: resolved._alignY.guide,
    });
  }

  // Flush guide — legacy dashed <line> (no chip, as LLD 26)
  if (_activeGuides.some(g => g.kind === "flush")) {
    _ensureFlushLine();
  } else {
    _removeFlushLine();
  }

  // Alignment guide <g> elements — ensure we have the right count
  const alignGuides = _activeGuides.filter(g => g.kind === "align");
  // Grow pool if needed
  while (_alignGuideEls.length < alignGuides.length) {
    _alignGuideEls.push(null);
  }
  // Remove extras
  for (let i = alignGuides.length; i < _alignGuideEls.length; i++) {
    if (_alignGuideEls[i] && _alignGuideEls[i].parentNode) {
      _alignGuideEls[i].parentNode.removeChild(_alignGuideEls[i]);
    }
    _alignGuideEls[i] = null;
  }
  _alignGuideEls.length = alignGuides.length;
}

function _ensureFlushLine() {
  if (!_flushGuideLine) {
    _flushGuideLine = document.createElementNS(NS_SVG, "line");
    _flushGuideLine.setAttribute("class", "flush-guide");
    _flushGuideLine.setAttribute("stroke", _COLOR_FLUSH);
    _flushGuideLine.setAttribute("stroke-width", "1");
    _flushGuideLine.setAttribute("stroke-dasharray", "4 3");
    _flushGuideLine.setAttribute("opacity", "0.55");
  }
  if (!_flushGuideLine.parentNode) {
    _gSymOverlay.appendChild(_flushGuideLine);
  }
  // Recompute screen coords
  const guide = _flushGuide.guide;
  const sa = worldToScreen(guide.a.x, guide.a.y);
  const sb = worldToScreen(guide.b.x, guide.b.y);
  _flushGuideLine.setAttribute("x1", String(sa.x));
  _flushGuideLine.setAttribute("y1", String(sa.y));
  _flushGuideLine.setAttribute("x2", String(sb.x));
  _flushGuideLine.setAttribute("y2", String(sb.y));
}

function _removeFlushLine() {
  if (_flushGuideLine && _flushGuideLine.parentNode) {
    _flushGuideLine.parentNode.removeChild(_flushGuideLine);
  }
}

/**
 * Build or update a single alignment guide <g> element.
 * @param {number} idx  index into _alignGuideEls
 * @param {{ kind:string, color:string, label:string, guide:{a,b} }} guide
 */
function _syncAlignGuideEl(idx, guide) {
  let g = _alignGuideEls[idx];
  if (!g) {
    g = document.createElementNS(NS_SVG, "g");
    g.setAttribute("class", "align-guide");
    g.setAttribute("aria-hidden", "true");

    const line = document.createElementNS(NS_SVG, "line");
    line.setAttribute("class", "align-guide-line");
    line.setAttribute("stroke-width", "1.4");
    line.setAttribute("fill", "none");

    const rect = document.createElementNS(NS_SVG, "rect");
    rect.setAttribute("class", "align-guide-chip");
    rect.setAttribute("rx", "3");
    rect.setAttribute("ry", "3");
    rect.setAttribute("height", "14");

    const text = document.createElementNS(NS_SVG, "text");
    text.setAttribute("class", "align-guide-label");
    text.setAttribute("fill", "#14140f");
    text.setAttribute("font-size", "9");
    text.setAttribute("font-family", "var(--font-mono, monospace)");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");

    g.appendChild(line);
    g.appendChild(rect);
    g.appendChild(text);
    _alignGuideEls[idx] = g;
  }

  const line = g.querySelector(".align-guide-line");
  const rect = g.querySelector(".align-guide-chip");
  const text = g.querySelector(".align-guide-label");

  // Update color
  line.setAttribute("stroke", guide.color);
  rect.setAttribute("fill", guide.color);

  // Recompute screen coords
  const sa = worldToScreen(guide.guide.a.x, guide.guide.a.y);
  const sb = worldToScreen(guide.guide.b.x, guide.guide.b.y);
  line.setAttribute("x1", String(sa.x));
  line.setAttribute("y1", String(sa.y));
  line.setAttribute("x2", String(sb.x));
  line.setAttribute("y2", String(sb.y));

  // Label chip at midpoint
  const mx = (sa.x + sb.x) / 2;
  const my = (sa.y + sb.y) / 2;
  text.textContent = guide.label || "";
  const labelW = (guide.label ? guide.label.length * 5.5 + 8 : 20);
  rect.setAttribute("x", String(mx - labelW / 2));
  rect.setAttribute("y", String(my - 7));
  rect.setAttribute("width", String(labelW));
  text.setAttribute("x", String(mx));
  text.setAttribute("y", String(my));

  // Ensure in overlay
  if (!g.parentNode) {
    _gSymOverlay.appendChild(g);
  }
}

/**
 * Clear all guide elements from the DOM.
 */
function _clearGuides() {
  _removeFlushLine();
  for (let i = 0; i < _alignGuideEls.length; i++) {
    if (_alignGuideEls[i] && _alignGuideEls[i].parentNode) {
      _alignGuideEls[i].parentNode.removeChild(_alignGuideEls[i]);
    }
    _alignGuideEls[i] = null;
  }
  _alignGuideEls.length = 0;
  _activeGuides = [];
}

/**
 * Re-append and reposition all active guides after symbolRender clears the overlay.
 * Registered as a post-render hook (after symbolRenderFn).
 * Called every frame; no-ops when no guide is active.
 */
export function repositionGuides() {
  if (!_gSymOverlay) return;
  if (_isDrawModeFn && _isDrawModeFn()) return;

  // Flush guide
  const flushEntry = _activeGuides.find(g => g.kind === "flush");
  if (flushEntry && _flushGuide) {
    _ensureFlushLine();
  } else {
    _removeFlushLine();
  }

  // Alignment guides
  const alignGuides = _activeGuides.filter(g => g.kind === "align");
  for (let i = 0; i < alignGuides.length; i++) {
    _syncAlignGuideEl(i, alignGuides[i]);
  }
}

/**
 * Backward-compatible alias for repositionGuides.
 * main.js currently imports this name; either can be used.
 */
export { repositionGuides as repositionFlushGuide };

/**
 * Thin test wrapper around _resolvePlacement.
 *
 * Allows unit tests to call the resolver directly with injected candidate AABBs,
 * bypassing the module-private `_candidateAABBs` state — identical to how LLD-26
 * exposed `nearestWallFlush` as a pure export so it can be tested in isolation.
 *
 * The caller provides `candidateAABBs` explicitly (not via module state) so tests
 * are fully self-contained.
 *
 * @param {number} sx  screen x
 * @param {number} sy  screen y
 * @param {boolean} altHeld
 * @param {{ type:string, x:number, y:number, w:number, h:number, rot:number }} boxLike
 * @param {{ minX:number, maxX:number, cx:number, minY:number, maxY:number, cy:number }[]} candidateAABBs
 * @returns {{ x:number, y:number, snapType:"flush"|"align"|"grid"|"free", _flushActive:boolean, _alignX:import("./symbols.js").AlignAxisMatch|null, _alignY:import("./symbols.js").AlignAxisMatch|null }}
 */
export function resolvePlacementForTest(sx, sy, altHeld, boxLike, candidateAABBs) {
  const prev = _candidateAABBs;
  _candidateAABBs = candidateAABBs;
  try {
    return _resolvePlacement(sx, sy, altHeld, boxLike);
  } finally {
    _candidateAABBs = prev;
  }
}
