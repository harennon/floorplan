/**
 * measureTool.js — measure-mode interaction controller (LLD 92)
 *
 * Owns measure mode, two-click placement, in-progress endpoint, Alt state,
 * snapping, select/delete hooks. Mirrors wallTool.js + roomTool.js.
 * Imported only by main.js.
 *
 * Snapping precedence (_resolvePoint):
 *   1. Object corner / center (symbols)
 *   2. Wall vertex (closestEndpoint)
 *   3. Wall edge foot-point (re-derived point-to-segment projection)
 *   4. Grid (gridSnap) — if snap toggle on and not Alt held
 *   5. Free (raw world point) — if Alt held OR snap toggle off
 *
 * The persistent grid-snap toggle gates only grid snapping (step 4).
 * Object/vertex/edge snapping is always on (matches wall/symbol snapping).
 * Alt is the universal "free, no snap at all" override.
 */

import { screenToWorld, worldToScreen } from "./view.js";
import { snapStep } from "./grid.js";
import { gridSnap as doGridSnap, closestEndpoint, allVertices, wallSegments, MIN_SEG_M, SNAP_PT_PX } from "./walls.js";
import { model as symbolsModel, corners, aabb } from "./symbols.js";
import { add, remove, getById, length, nearestMeasurement, model as measurementsModel } from "./measurements.js";
import { scheduleRender } from "./surface.js";
import { isOpen as isHelpOpen } from "./help.js";
import { gridSnap as prefsGridSnap } from "./prefs.js";

// ── Injected dependencies (avoid circular imports) ─────────────────────────────

let _historyCommit = null;
let _clearOtherSelections = null;

/**
 * Inject history.commit.
 * @param {()=>void} fn
 */
export function setHistoryCommit(fn) {
  _historyCommit = fn;
}

/**
 * Inject a callback that clears symbol + room selection (mutex).
 * @param {()=>void} fn
 */
export function setClearOtherSelections(fn) {
  _clearOtherSelections = fn;
}

// ── State ─────────────────────────────────────────────────────────────────────

/** Measure mode active. */
let _active = false;

/** First placed endpoint during a two-click placement; null when idle. */
let _pendingA = null;

/** Live rubber-band endpoint (updated on move). */
let _cursorPt = null;

/** Snap type string for the live endpoint. */
let _snapType = "free";

/** Current selection. */
let _selectedMeasurementId = null;

/** Alt held → free snap. */
let _altHeld = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────

let _btnMeasure = null;
let _btnSelect  = null;
let _btnWall    = null;
let _snapTagEl  = null;
let _stage      = null;

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Bind DOM references and wire keyboard.
 * @param {{ stage:Element, btnMeasure:Element, btnSelect:Element, btnWall:Element, snapTag:Element }} refs
 */
export function init(refs) {
  _btnMeasure = refs.btnMeasure;
  _btnSelect  = refs.btnSelect;
  _btnWall    = refs.btnWall;
  _snapTagEl  = refs.snapTag;
  _stage      = refs.stage;

  window.addEventListener("keydown", _onKeyDown);
  window.addEventListener("keyup",   _onKeyUp);
  window.addEventListener("blur",    _onWindowBlur);
}

// ── Mode ──────────────────────────────────────────────────────────────────────

/** True when measure mode is active. */
export function isActive() {
  return _active;
}

/** Enter measure mode. main.js also calls wallTool.setTool("select") to exit draw mode. */
export function activate() {
  _active = true;
  _pendingA = null;
  _cursorPt = null;
  _updateRail();
}

/**
 * Leave measure mode. Cancels any in-progress placement without committing.
 */
export function deactivate() {
  _active = false;
  _pendingA = null;
  _cursorPt = null;
  _updateRail();
}

// ── Placement hooks (called from interactions.js via setMeasureHooks) ─────────

/**
 * Handle a single-pointer tap in measure mode.
 * First tap → places A; second tap → commits B (or rejects if zero-length).
 * @param {number} sx screen x
 * @param {number} sy screen y
 * @returns {boolean} always true (consumed)
 */
export function onMeasureDown(sx, sy) {
  const pt = _resolvePoint(sx, sy);

  if (_pendingA === null) {
    // First click: place A
    _pendingA = pt;
    _cursorPt = pt;
    scheduleRender();
    return true;
  }

  // Second click: commit B
  const b = pt;
  const len = length({ a: _pendingA, b });
  if (len < MIN_SEG_M) {
    // Zero/near-zero — reject, keep _pendingA so user can click a real B
    scheduleRender();
    return true;
  }

  add(_pendingA, b);
  if (_historyCommit) _historyCommit();
  _pendingA = null;
  _cursorPt = null;
  scheduleRender();
  return true;
}

/**
 * Update rubber-band endpoint for preview rendering.
 * @param {number} sx
 * @param {number} sy
 */
export function onMeasureMove(sx, sy) {
  if (!_active) return;
  const pt = _resolvePoint(sx, sy);
  _cursorPt = pt;
  scheduleRender();
}

/** Clear rubber-band snap glyph when cursor leaves canvas. */
export function onMeasureLeave() {
  _cursorPt = null;
  scheduleRender();
}

// ── Preview state readers (for measureRender) ─────────────────────────────────

/**
 * Returns the in-progress draft state for rendering, or null if no draft.
 * @returns {{ a:{x:number,y:number}, b:{x:number,y:number}, snapType:string }|null}
 */
export function getDraft() {
  if (_pendingA === null || _cursorPt === null) return null;
  return { a: _pendingA, b: _cursorPt, snapType: _snapType };
}

/**
 * Returns the currently selected measurement id, or null if the id is no longer
 * in the model (dangling id guard, as required by the undo/redo spec).
 * @returns {string|null}
 */
export function getSelectedMeasurementId() {
  if (_selectedMeasurementId === null) return null;
  // Dangling id guard: validate on read
  if (getById(_selectedMeasurementId) === null) {
    _selectedMeasurementId = null;
  }
  return _selectedMeasurementId;
}

// ── Selection (LLD 63 dispatcher, lowest priority) ────────────────────────────

/**
 * Hit-test the nearest measurement line. On hit, sets selection and clears other
 * selections (mutex). Only valid in Select mode (caller gates on !isActive()).
 * @param {number} sx
 * @param {number} sy
 * @returns {boolean} true if a measurement was hit
 */
export function onSelectDown(sx, sy) {
  const m = nearestMeasurement(sx, sy, SNAP_PT_PX);
  if (!m) return false;
  _selectedMeasurementId = m.id;
  if (_clearOtherSelections) _clearOtherSelections();
  return true;
}

/** No-op this phase (measurements are not movable). */
export function onSelectMove(_sx, _sy) {}

/** No-op this phase. */
export function onSelectUp(_sx, _sy) {}

/** Clear selection (no render — caller schedules render). */
export function clearSelection() {
  _selectedMeasurementId = null;
}

/** True if a measurement is currently selected. */
export function hasSelection() {
  return getSelectedMeasurementId() !== null;
}

/**
 * Remove the selected measurement + history.commit + scheduleRender.
 * No-op if nothing selected or id no longer in model.
 */
export function deleteSelected() {
  const id = getSelectedMeasurementId();
  if (id === null) return;
  remove(id);
  _selectedMeasurementId = null;
  if (_historyCommit) _historyCommit();
  scheduleRender();
}

/**
 * Clear measurement selection and schedule render (used by dispatcher's empty-tap).
 */
export function onTapEmpty() {
  _selectedMeasurementId = null;
  scheduleRender();
}

// ── Snap resolution ───────────────────────────────────────────────────────────

/**
 * Resolve the world-coordinate snap point for a screen position.
 * Precedence (closest-wins by screen-pixel distance):
 *   1. Symbol corners (4) and AABB center per symbol
 *   2. Wall vertex (closestEndpoint over allVertices())
 *   3. Wall edge foot-point (point-to-segment projection)
 *   4. Grid (when snap toggle on and not Alt held)
 *   5. Free (raw world point)
 *
 * Alt held OR persistent grid toggle off → skips step 4 (grid);
 * Alt held → skips ALL snap steps (fully free).
 * @param {number} sx screen x
 * @param {number} sy screen y
 * @returns {{ x:number, y:number }}
 */
export function _resolvePoint(sx, sy) {
  const raw = screenToWorld(sx, sy);

  // Alt held → fully free (no snap at all)
  if (_altHeld) {
    _snapType = "free";
    return raw;
  }

  let bestDist = SNAP_PT_PX;
  let bestPt   = null;
  let bestType = "free";

  // 1. Symbol corners and centers
  for (const sym of symbolsModel.symbols) {
    const cs = corners(sym);
    const box = aabb(sym);
    const candidates = [...cs, { x: box.cx, y: box.cy }];
    for (const c of candidates) {
      const s = worldToScreen(c.x, c.y);
      const dx = s.x - sx;
      const dy = s.y - sy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= bestDist) {
        bestDist = dist;
        bestPt   = { x: c.x, y: c.y };
        bestType = "point";
      }
    }
  }

  // 2. Wall vertex
  const verts = allVertices();
  const nearVert = closestEndpoint(sx, sy, verts, null, SNAP_PT_PX);
  if (nearVert !== null) {
    const s = worldToScreen(nearVert.x, nearVert.y);
    const dx = s.x - sx;
    const dy = s.y - sy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= bestDist) {
      bestDist = dist;
      bestPt   = { x: nearVert.x, y: nearVert.y };
      bestType = "point";
    }
  }

  // 3. Wall edge foot-point (re-derived; pointNearRoomWall returns boolean only)
  for (const seg of wallSegments()) {
    const sa = worldToScreen(seg.a.x, seg.a.y);
    const sb = worldToScreen(seg.b.x, seg.b.y);
    const foot = _screenSegFoot(sx, sy, sa.x, sa.y, sb.x, sb.y);
    const fdx = foot.sx - sx;
    const fdy = foot.sy - sy;
    const dist = Math.sqrt(fdx * fdx + fdy * fdy);
    if (dist <= bestDist) {
      bestDist = dist;
      bestPt   = { x: foot.wx, y: foot.wy };
      bestType = "point";
    }
  }

  if (bestPt !== null) {
    _snapType = bestType;
    return bestPt;
  }

  // 4. Grid (when persistent snap toggle on)
  const step = snapStep();
  if (step !== null && prefsGridSnap()) {
    _snapType = "grid";
    return doGridSnap(raw, step);
  }

  // 5. Free
  _snapType = "free";
  return raw;
}

/**
 * Compute the foot-point of (px, py) projected onto the segment (ax,ay)→(bx,by)
 * in SCREEN space. Returns both the screen foot and the corresponding world point.
 * @returns {{ sx:number, sy:number, wx:number, wy:number }}
 */
function _screenSegFoot(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const footSx = ax + t * abx;
  const footSy = ay + t * aby;
  // Back-project foot to world using linear interpolation in world space
  // (avoids a screenToWorld call; equivalent since projection is linear)
  const worldFoot = screenToWorld(footSx, footSy);
  return { sx: footSx, sy: footSy, wx: worldFoot.x, wy: worldFoot.y };
}

// ── Rail ──────────────────────────────────────────────────────────────────────

function _updateRail() {
  if (_btnMeasure) {
    _btnMeasure.setAttribute("aria-pressed", _active ? "true" : "false");
  }
  if (_active) {
    // Clear select and wall pressed state (measure mode owns the UI)
    if (_btnSelect) _btnSelect.setAttribute("aria-pressed", "false");
    if (_btnWall)   _btnWall.setAttribute("aria-pressed",   "false");
  }
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

function _onKeyDown(e) {
  if (e.ctrlKey || e.metaKey) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  if (e.code === "AltLeft" || e.code === "AltRight") {
    _altHeld = true;
    scheduleRender();
    return;
  }

  // M key activates measure mode (handled externally in main.js; duplicate guard here)
  if ((e.key === "m" || e.key === "M") && !_active) return; // main.js handles

  // Escape: cancel in-progress placement
  if (e.key === "Escape" && _active) {
    if (isHelpOpen()) return;
    if (_pendingA !== null) {
      _pendingA = null;
      _cursorPt = null;
      scheduleRender();
    }
  }
}

function _onKeyUp(e) {
  if (e.code === "AltLeft" || e.code === "AltRight") {
    _altHeld = false;
    scheduleRender();
  }
}

function _onWindowBlur() {
  if (_altHeld) {
    _altHeld = false;
    scheduleRender();
  }
}
