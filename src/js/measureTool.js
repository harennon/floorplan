/**
 * measureTool.js — Measure tool interaction controller (LLD 91)
 *
 * Handles:
 *  - Two-click placement of distance annotations (A → B)
 *  - Snap resolver compositing existing helpers (grid, room vertex/edge,
 *    symbol corner/center) in precedence order
 *  - Selection + deletion of committed measurements via the select dispatcher
 *
 * Works alongside wallTool.js (which owns the tool mode enum).
 * History + toast are injected from main.js to avoid circular imports.
 *
 * @typedef {"idle"|"awaitingB"} MeasureState
 * @typedef {{ x:number, y:number, type:"free"|"grid"|"vertex"|"edge"|"corner"|"center" }} MSnap
 */

import { screenToWorld, worldToScreen } from "./view.js";
import { model as measurementsModel, newId } from "./measurements.js";
import { model as wallsModel, allVertices, MIN_SEG_M, SNAP_PT_PX, edgeLength } from "./walls.js";
import { model as symbolsModel, corners, aabb as symAabb } from "./symbols.js";
import { gridSnap as prefsGridSnap } from "./prefs.js";
import { snapStep } from "./grid.js";
import { gridSnap } from "./walls.js";
import { scheduleRender } from "./surface.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Screen-px snap tolerance — matches SNAP_PT_PX from walls.js */
const SNAP_PX = SNAP_PT_PX;

/** Screen-px hit tolerance for segment selection */
const HIT_PX = 8;

// ── Injected dependencies ─────────────────────────────────────────────────────

let _historyCommit = null;
let _showToastFn   = null;
let _historyUndo   = null;
let _historyDepth  = null;

/**
 * Inject history + toast. Called from main.js.
 * @param {{ commit:()=>void, undo:()=>boolean, depth:()=>number }} history
 * @param {(msg:string, action?:{label:string,onClick:()=>void})=>void} showToast
 */
export function setHistoryAndToast(history, showToast) {
  _historyCommit = history.commit;
  _historyUndo   = history.undo;
  _historyDepth  = history.depth;
  _showToastFn   = showToast;
}

// Injected clear for the selection mutex (clears symbol + room selection when
// a measurement is selected). Mirrors roomTool.setClearSymbolSelection pattern.
let _clearOtherSelections = null;

/**
 * Inject the function to clear symbol + room selection on a measure hit.
 * @param {()=>void} fn
 */
export function setClearOtherSelections(fn) {
  _clearOtherSelections = fn;
}

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {MeasureState} */
let _state = "idle";

/** @type {{ x:number, y:number }|null} */
let _pendingA = null;

/** @type {MSnap|null} */
let _cursorSnap = null;

/** @type {string|null} */
let _selectedMeasureId = null;

/** Alt-key held (free-snap override). Tracked per keydown/keyup + blur reset. */
let _altHeld = false;

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Bind DOM/window listeners.
 * @param {{ stage:Element }} refs
 */
export function init(refs) {
  // Track Alt held for free-snap (mirrors wallTool/roomTool pattern)
  window.addEventListener("keydown", (e) => {
    if (e.code === "AltLeft" || e.code === "AltRight") {
      _altHeld = true;
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "AltLeft" || e.code === "AltRight") {
      _altHeld = false;
    }
  });
  window.addEventListener("blur", () => {
    if (_altHeld) _altHeld = false;
  });
}

// ── Snap resolver ─────────────────────────────────────────────────────────────

/**
 * Resolve snap for a screen position, compositing in precedence order:
 * 1. Alt held → free (raw world point)
 * 2. Symbol corner (nearest within SNAP_PX)
 * 3. Symbol center (nearest within SNAP_PX)
 * 4. Room vertex (nearest within SNAP_PX)
 * 5. Wall edge (projected point on nearest segment within SNAP_PX)
 * 6. Grid (if prefs.gridSnap() on and snapStep() non-null)
 * 7. Free (fallback)
 *
 * All distances are measured in screen-px (zoom-stable).
 * Returns a plain {x,y} world coordinate — no anchor stored.
 *
 * @param {number} sx
 * @param {number} sy
 * @returns {MSnap}
 */
function _resolveMeasureSnap(sx, sy) {
  const raw = screenToWorld(sx, sy);

  // 1. Alt held → free
  if (_altHeld) {
    return { x: raw.x, y: raw.y, type: "free" };
  }

  // 2. Symbol corners
  let bestDist = SNAP_PX;
  let bestPt = null;
  let bestType = "free";

  for (const sym of symbolsModel.symbols) {
    for (const c of corners(sym)) {
      const s = worldToScreen(c.x, c.y);
      const dist = Math.sqrt((s.x - sx) ** 2 + (s.y - sy) ** 2);
      if (dist < bestDist) {
        bestDist = dist;
        bestPt = { x: c.x, y: c.y };
        bestType = "corner";
      }
    }
  }
  if (bestPt) return { x: bestPt.x, y: bestPt.y, type: bestType };

  // 3. Symbol centers
  bestDist = SNAP_PX;
  for (const sym of symbolsModel.symbols) {
    const box = symAabb(sym);
    const s = worldToScreen(box.cx, box.cy);
    const dist = Math.sqrt((s.x - sx) ** 2 + (s.y - sy) ** 2);
    if (dist < bestDist) {
      bestDist = dist;
      bestPt = { x: box.cx, y: box.cy };
      bestType = "center";
    }
  }
  if (bestPt) return { x: bestPt.x, y: bestPt.y, type: "center" };

  // 4. Room vertices
  bestDist = SNAP_PX;
  const verts = allVertices();
  for (const v of verts) {
    const s = worldToScreen(v.x, v.y);
    const dist = Math.sqrt((s.x - sx) ** 2 + (s.y - sy) ** 2);
    if (dist < bestDist) {
      bestDist = dist;
      bestPt = { x: v.x, y: v.y };
    }
  }
  if (bestPt) return { x: bestPt.x, y: bestPt.y, type: "vertex" };

  // 5. Wall edge (segment projection)
  bestDist = SNAP_PX;
  let edgePt = null;
  for (const room of wallsModel.rooms) {
    const rv = room.verts;
    const n = rv.length;
    if (n < 2) continue;
    const last = room.closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = rv[i];
      const b = rv[(i + 1) % n];
      const proj = _projectOnSegment(raw.x, raw.y, a, b);
      const s = worldToScreen(proj.x, proj.y);
      const dist = Math.sqrt((s.x - sx) ** 2 + (s.y - sy) ** 2);
      if (dist < bestDist) {
        bestDist = dist;
        edgePt = proj;
      }
    }
  }
  if (edgePt) return { x: edgePt.x, y: edgePt.y, type: "edge" };

  // 6. Grid
  const step = snapStep();
  if (prefsGridSnap() && step != null) {
    const snapped = gridSnap(raw, step);
    return { x: snapped.x, y: snapped.y, type: "grid" };
  }

  // 7. Free fallback
  return { x: raw.x, y: raw.y, type: "free" };
}

/**
 * Project world point (px, py) onto segment (a, b), returning the clamped
 * closest point on the segment (world metres).
 * @param {number} px
 * @param {number} py
 * @param {{ x:number, y:number }} a
 * @param {{ x:number, y:number }} b
 * @returns {{ x:number, y:number }}
 */
function _projectOnSegment(px, py, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) return { x: a.x, y: a.y };
  let t = ((px - a.x) * abx + (py - a.y) * aby) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: a.x + t * abx, y: a.y + t * aby };
}

// ── Placement hooks ───────────────────────────────────────────────────────────

/**
 * Update cursor snap for rubber-band preview.
 * @param {number} sx
 * @param {number} sy
 * @param {string} [_pointerType]
 */
export function onHover(sx, sy, _pointerType) {
  _cursorSnap = _resolveMeasureSnap(sx, sy);
  scheduleRender();
}

/**
 * Handle click: first click sets A, second click (non-degenerate) creates measurement.
 * @param {number} sx
 * @param {number} sy
 */
export function onClick(sx, sy) {
  const snap = _resolveMeasureSnap(sx, sy);

  if (_state === "idle") {
    // First click → set point A
    _pendingA = { x: snap.x, y: snap.y };
    _cursorSnap = snap;
    _state = "awaitingB";
    scheduleRender();
    return;
  }

  // awaitingB → check for degenerate
  const B = { x: snap.x, y: snap.y };
  if (edgeLength(_pendingA, B) < MIN_SEG_M) {
    // Degenerate: ignore, stay in awaitingB
    return;
  }

  // Create measurement
  const m = {
    id: newId(),
    a: { x: _pendingA.x, y: _pendingA.y },
    b: { x: B.x, y: B.y },
  };
  measurementsModel.measurements.push(m);

  // Commit to history
  if (_historyCommit) _historyCommit();

  // Reset state
  _pendingA = null;
  _cursorSnap = null;
  _state = "idle";
  scheduleRender();
}

/**
 * Clear cursor snap when cursor leaves the canvas.
 * Does NOT drop pending A (Edge Case 5).
 */
export function onLeave() {
  _cursorSnap = null;
  scheduleRender();
}

/**
 * Cancel an in-progress measurement (Esc, pinch cancel, or tool switch).
 * Drops pending A, returns to idle. No commit.
 */
export function cancel() {
  _pendingA = null;
  _cursorSnap = null;
  _state = "idle";
  scheduleRender();
}

// ── Selection hooks ───────────────────────────────────────────────────────────

/**
 * Hit-test screen position against all committed measurement segments.
 * Last-match-wins (topmost/last in array). Clears other selections on hit.
 * @param {number} sx
 * @param {number} sy
 * @returns {boolean} true if a measurement was selected
 */
export function selectDown(sx, sy) {
  let hit = null;

  for (const m of measurementsModel.measurements) {
    const dist = _screenDistToSegment(sx, sy, m.a, m.b);
    if (dist <= HIT_PX) {
      hit = m.id; // last-match-wins
    }
  }

  if (hit !== null) {
    _selectedMeasureId = hit;
    if (_clearOtherSelections) _clearOtherSelections();
    scheduleRender();
    return true;
  }
  return false;
}

/**
 * Clear measurement selection (session-only). Does not call scheduleRender —
 * the caller owns render scheduling (mutex management).
 */
export function clearSelection() {
  _selectedMeasureId = null;
}

/** @returns {boolean} */
export function hasSelection() {
  return _selectedMeasureId !== null;
}

/** @returns {string|null} */
export function getSelectedId() {
  return _selectedMeasureId;
}

/**
 * Delete the selected measurement, commit, show toast with scoped Undo.
 */
export function deleteSelected() {
  if (_selectedMeasureId === null) return;

  const idx = measurementsModel.measurements.findIndex(m => m.id === _selectedMeasureId);
  if (idx === -1) { _selectedMeasureId = null; return; }

  measurementsModel.measurements.splice(idx, 1);
  _selectedMeasureId = null;

  if (_historyCommit) _historyCommit();

  // Scoped undo toast: capture the depth after commit
  if (_showToastFn && _historyUndo && _historyDepth) {
    const depthAtDelete = _historyDepth();
    _showToastFn("Deleted", {
      label: "Undo",
      onClick: () => {
        // Only undo if we're at the same depth (scoped one-tap undo)
        if (_historyDepth() === depthAtDelete) {
          if (_historyUndo()) scheduleRender();
        }
      },
    });
  }

  scheduleRender();
}

// ── State getter for measureRender ────────────────────────────────────────────

/**
 * Transient draft state consumed by measureRender each frame.
 * @returns {{ pendingA:{ x:number, y:number }|null, cursorSnap:MSnap|null }}
 */
export function getDraftState() {
  return {
    pendingA:   _pendingA   ? { x: _pendingA.x,   y: _pendingA.y   } : null,
    cursorSnap: _cursorSnap ? { x: _cursorSnap.x, y: _cursorSnap.y, type: _cursorSnap.type } : null,
  };
}

// ── Private: screen-space distance from (sx, sy) to a world segment a→b ──────

/**
 * Screen-px distance from screen point (sx, sy) to the screen projection of
 * the world segment a→b (clamped to segment endpoints).
 * @param {number} sx
 * @param {number} sy
 * @param {{ x:number, y:number }} a  world
 * @param {{ x:number, y:number }} b  world
 * @returns {number}
 */
function _screenDistToSegment(sx, sy, a, b) {
  const sa = worldToScreen(a.x, a.y);
  const sb = worldToScreen(b.x, b.y);

  const abx = sb.x - sa.x;
  const aby = sb.y - sa.y;
  const len2 = abx * abx + aby * aby;

  let t;
  if (len2 < 1e-6) {
    // Degenerate segment (zero screen length): distance to endpoint
    t = 0;
  } else {
    t = ((sx - sa.x) * abx + (sy - sa.y) * aby) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }

  const cx = sa.x + t * abx;
  const cy = sa.y + t * aby;
  return Math.sqrt((sx - cx) ** 2 + (sy - cy) ** 2);
}
