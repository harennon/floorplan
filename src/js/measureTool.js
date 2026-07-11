/**
 * measureTool.js — point-to-point distance annotation controller (LLD 85)
 *
 * Manages:
 *  - Two-tap placement of Measurement annotations (pendingA → B → commit)
 *  - Snap resolution reusing walls.js/symbols.js infrastructure
 *  - Selection and deletion via the LLD 63 select dispatcher
 *  - Escape to cancel in-progress placement (bubble-phase keydown)
 *
 * This module is DOM/interaction-only — no rendering (see measureRender.js).
 * Injected dependencies: history.commit, showToast, mutex-clear hooks.
 *
 * @typedef {import("./walls.js").Snap} Snap
 * @typedef {import("./measurements.js").Measurement} Measurement
 */

import { screenToWorld, worldToScreen, pxPerM } from "./view.js";
import { snapStep } from "./grid.js";
import {
  allVertices, closestEndpoint, gridSnap, wallSegments,
  SNAP_PT_PX, MIN_SEG_M,
} from "./walls.js";
import { model as symbolsModel, corners as symCorners, aabb as symAabb } from "./symbols.js";
import { model as measurementsModel, newId } from "./measurements.js";
import { scheduleRender } from "./surface.js";
import { isOpen as isHelpOpen } from "./help.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Line hit-test tolerance in screen px. */
const MEASURE_HIT_PX_MOUSE = 8;
const MEASURE_HIT_PX_TOUCH = 44;

// ── Injected dependencies ─────────────────────────────────────────────────────

let _historyCommit = null;
let _showToastFn   = null;
let _historyUndo   = null;
let _historyDepth  = null;

/** @type {()=>void|null} */
let _clearRoomSelection = null;
/** @type {()=>void|null} */
let _clearSymbolSelection = null;

/** isMeasureMode() injected from wallTool to avoid circular import. */
let _isMeasureModeFn = null;

/**
 * Inject history.commit. Called from main.js.
 * @param {()=>void} fn
 */
export function setHistoryCommit(fn) {
  _historyCommit = fn;
}

/**
 * Inject toast + history for scoped-undo delete toast.
 * @param {(msg:string, action?:{label:string,onClick:()=>void})=>void} showToast
 * @param {{ undo:()=>boolean, depth:()=>number }} history
 */
export function setToastAndHistory(showToast, history) {
  _showToastFn  = showToast;
  _historyUndo  = history.undo;
  _historyDepth = history.depth;
}

/** Inject room-selection clear callback (mutex). */
export function setClearRoomSelection(fn) {
  _clearRoomSelection = fn;
}

/** Inject symbol-selection clear callback (mutex). */
export function setClearSymbolSelection(fn) {
  _clearSymbolSelection = fn;
}

/** Inject isMeasureMode() from wallTool (avoid cycle). */
export function setIsMeasureMode(fn) {
  _isMeasureModeFn = fn;
}

// ── State ─────────────────────────────────────────────────────────────────────

/** First point placed; waiting for B. */
let _pendingA = null;

/** Current preview snap (drives rubber-band + snap tag). */
let _snap = null;

/** Whether Alt is held (free snap). */
let _altHeld = false;

/** Currently selected measurement id. */
let _selectedId = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────

let _snapTagEl = null;
let _stage     = null;

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Bind DOM references and register keyboard listener for Escape cancel.
 * @param {{ stage:Element, snapTag?:Element }} refs
 */
export function init(refs) {
  _stage     = refs.stage || null;
  _snapTagEl = refs.snapTag || null;

  // Bubble-phase keydown: Escape cancels in-progress placement; Alt tracks free-snap.
  window.addEventListener("keydown", _onKeyDown);
  window.addEventListener("keyup",   _onKeyUp);
  window.addEventListener("blur",    _onWindowBlur);
}

// ── Tool-mode participation ───────────────────────────────────────────────────

/**
 * Called when the tool changes; false → cancel any pending placement.
 * @param {boolean} active
 */
export function setActive(active) {
  if (!active) cancel();
}

/** Cancel in-progress placement (clear pendingA + snap). No history commit. */
export function cancel() {
  _pendingA = null;
  _snap = null;
  _hideSnapTag();
  scheduleRender();
}

// ── isMeasureMode (for interactions.js hook) ─────────────────────────────────

/**
 * Returns true when measure mode is currently active.
 * Reads from injected wallTool.isMeasureMode().
 * @returns {boolean}
 */
export function isMeasureMode() {
  return _isMeasureModeFn ? _isMeasureModeFn() : false;
}

// ── Tap-place hooks (for interactions.js via setMeasureHooks) ────────────────

/**
 * Update preview snap on hover.
 * @param {number} sx
 * @param {number} sy
 * @param {string} [pointerType]
 */
export function onHover(sx, sy, pointerType) {
  _snap = resolveMeasureSnap(sx, sy);
  _positionSnapTag(sx, sy);
  scheduleRender();
}

/**
 * Tap handler: first tap sets pendingA; second tap commits measurement.
 * @param {number} sx
 * @param {number} sy
 */
export function onClick(sx, sy) {
  const snap = resolveMeasureSnap(sx, sy);
  _snap = snap;

  if (_pendingA === null) {
    // First tap: set point A
    _pendingA = { x: snap.x, y: snap.y };
    scheduleRender();
    return;
  }

  // Second tap: set point B, check degenerate
  const b = { x: snap.x, y: snap.y };
  const dx = b.x - _pendingA.x;
  const dy = b.y - _pendingA.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < MIN_SEG_M) {
    // Degenerate — keep pendingA, let user tap a different B
    return;
  }

  // Commit measurement
  const m = { id: newId(), a: { ..._pendingA }, b };
  measurementsModel.measurements.push(m);
  _pendingA = null;
  _snap = null;
  _hideSnapTag();
  if (_historyCommit) _historyCommit();
  scheduleRender();
}

/** Clear preview snap when cursor leaves. */
export function onLeave() {
  _snap = null;
  _hideSnapTag();
  scheduleRender();
}

// ── Render getters ────────────────────────────────────────────────────────────

/** @returns {{ x:number, y:number }|null} */
export function getPendingA() {
  return _pendingA;
}

/** @returns {Snap|null} */
export function getPreviewSnap() {
  return _snap;
}

/** @returns {string|null} */
export function getSelectedId() {
  return _selectedId;
}

// ── Select-dispatcher API (LLD 63) ────────────────────────────────────────────

/**
 * Hit-test: find if the click is near a measurement line.
 * Last-drawn wins (iterate in reverse).
 * @param {number} sx
 * @param {number} sy
 * @returns {boolean}
 */
export function onSelectDown(sx, sy) {
  const isCoarse = window.matchMedia("(pointer: coarse)").matches;
  const hitPx = isCoarse ? MEASURE_HIT_PX_TOUCH : MEASURE_HIT_PX_MOUSE;

  // Iterate in reverse (last-drawn wins)
  for (let i = measurementsModel.measurements.length - 1; i >= 0; i--) {
    const m = measurementsModel.measurements[i];
    const sa = worldToScreen(m.a.x, m.a.y);
    const sb = worldToScreen(m.b.x, m.b.y);
    const dist = _pointToSegmentDist(sx, sy, sa.x, sa.y, sb.x, sb.y);
    if (dist <= hitPx) {
      _selectedId = m.id;
      return true;
    }
  }
  return false;
}

/** Clear measurement selection. No render scheduled. */
export function clearSelection() {
  _selectedId = null;
}

/** @returns {boolean} */
export function hasSelection() {
  return _selectedId !== null;
}

/**
 * Delete the selected measurement. Shows "Deleted" toast with one-tap Undo.
 * No-op when nothing selected.
 */
export function deleteSelected() {
  if (!_selectedId) return;
  const idx = measurementsModel.measurements.findIndex(m => m.id === _selectedId);
  if (idx !== -1) {
    measurementsModel.measurements.splice(idx, 1);
  }
  _selectedId = null;
  if (_historyCommit) _historyCommit();
  if (_showToastFn && _historyDepth && _historyUndo) {
    const atDepth = _historyDepth();
    _showToastFn("Deleted", {
      label: "Undo",
      onClick() {
        if (_historyDepth() === atDepth) {
          _historyUndo();
          scheduleRender();
        }
      },
    });
  }
  scheduleRender();
}

// ── Snap resolution ────────────────────────────────────────────────────────────

/**
 * Resolve snap for a measure endpoint.
 * Precedence:
 *   1. Alt held → free (raw world)
 *   2. Point snap: wall vertices + symbol corners/centers within SNAP_PT_PX
 *   3. Wall-edge snap: closest projection on any wall segment within SNAP_PT_PX
 *   4. Grid snap: if snapStep() is non-null
 *   5. Free: otherwise
 *
 * @param {number} sx  screen x
 * @param {number} sy  screen y
 * @returns {Snap}
 */
export function resolveMeasureSnap(sx, sy) {
  const raw = screenToWorld(sx, sy);

  // 1. Alt held → free
  if (_altHeld) {
    return { x: raw.x, y: raw.y, type: "free" };
  }

  // 2. Point snap: wall vertices + symbol corners/centers
  const candidates = _buildSnapCandidates();
  const nearest = closestEndpoint(sx, sy, candidates, null, SNAP_PT_PX);
  if (nearest !== null) {
    return { x: nearest.x, y: nearest.y, type: "point" };
  }

  // 3. Wall-edge snap: project cursor onto each wall segment
  const segs = wallSegments();
  let bestEdgeDist = SNAP_PT_PX;
  let bestEdgePt = null;
  for (const seg of segs) {
    const pt = _closestPointOnSegment(raw, seg.a, seg.b);
    const s = worldToScreen(pt.x, pt.y);
    const dx = s.x - sx;
    const dy = s.y - sy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestEdgeDist) {
      bestEdgeDist = dist;
      bestEdgePt = pt;
    }
  }
  if (bestEdgePt !== null) {
    return { x: bestEdgePt.x, y: bestEdgePt.y, type: "point" };
  }

  // 4. Grid snap (only when snap toggle ON)
  const step = snapStep();
  if (step != null) {
    const snapped = gridSnap(raw, step);
    return { x: snapped.x, y: snapped.y, type: "grid" };
  }

  // 5. Free
  return { x: raw.x, y: raw.y, type: "free" };
}

// ── Private helpers ────────────────────────────────────────────────────────────

/**
 * Collect all point-snap candidates: wall vertices + symbol corners + symbol centers.
 * @returns {{ x:number, y:number }[]}
 */
function _buildSnapCandidates() {
  const pts = allVertices();
  for (const sym of symbolsModel.symbols) {
    for (const c of symCorners(sym)) {
      pts.push(c);
    }
    const box = symAabb(sym);
    pts.push({ x: box.cx, y: box.cy });
  }
  return pts;
}

/**
 * Closest point on segment [a, b] to point p. All in world space.
 * @param {{ x:number, y:number }} p
 * @param {{ x:number, y:number }} a
 * @param {{ x:number, y:number }} b
 * @returns {{ x:number, y:number }}
 */
function _closestPointOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return { x: a.x, y: a.y };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/**
 * Distance from screen point (px, py) to screen segment [(ax,ay),(bx,by)].
 * @returns {number}
 */
function _pointToSegmentDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) {
    const ex = px - ax, ey = py - ay;
    return Math.sqrt(ex * ex + ey * ey);
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return Math.sqrt(cx * cx + cy * cy);
}

// ── Snap tag ──────────────────────────────────────────────────────────────────

const _SNAP_LABELS = { grid: "grid", point: "point", free: "free" };
const _SNAP_COLORS = { grid: "#7fd0c8", point: "#e0b64f", free: "#8f8a78" };

function _positionSnapTag(sx, sy) {
  if (!_snapTagEl || !isMeasureMode() || _snap === null) {
    _hideSnapTag();
    return;
  }
  const label = _SNAP_LABELS[_snap.type] || _snap.type;
  const color  = _SNAP_COLORS[_snap.type] || "#8f8a78";
  _snapTagEl.textContent = label;
  _snapTagEl.style.color = color;
  _snapTagEl.style.display = "block";

  const offset = 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = _snapTagEl.offsetWidth  || 60;
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

  if (e.key === "Escape") {
    if (isHelpOpen()) return;
    if (isMeasureMode() && _pendingA !== null) {
      cancel();
      // Do not stopPropagation — let main.js global Esc branch run too
      // (it handles deselect, which is a no-op when _pendingA was set)
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
