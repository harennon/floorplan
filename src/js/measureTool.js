/**
 * measureTool.js — Measure tool interaction controller (LLD 93)
 *
 * Owns: two-click placement, endpoint snap resolution, draft state,
 * selection/delete integration, and snap-tag management for Measure mode.
 *
 * NOTE: placement commits on pointer-UP (tap-release), matching the draw-mode
 * pattern in interactions.js (_onPointerEnd → onClick). A down+drag-beyond-
 * threshold pans the canvas; no point is placed.
 *
 * History is injected (setHistoryCommit) to avoid circular imports.
 */

import { screenToWorld, worldToScreen, pxPerM } from "./view.js";
import { gridSnap, allVertices, closestEndpoint, wallSegments } from "./walls.js";
import { snapStep } from "./grid.js";
import { gridSnap as prefsGridSnap } from "./prefs.js";
import { model as symbolsModel, corners, aabb } from "./symbols.js";
import { isCoarsePointer } from "./pointerEnv.js";
import {
  model as measurementsModel,
  createMeasurement, addMeasurement, removeMeasurement, pickMeasurement,
} from "./measurements.js";
import { scheduleRender } from "./surface.js";
import { palette } from "./theme.js";

// ── Constants ──────────────────────────────────────────────────────────────────

/** Snap radius for wall vertex / object corner / center, screen px. */
const SNAP_PT_PX = isCoarsePointer ? 22 : 15;

/** Minimum second-point distance in screen pixels. Below this, discard. */
const MIN_LEN_PX = 8;

/** Hit radius for line pick (tolWorld derived at call time). */
const MIN_HIT_PX = isCoarsePointer ? 44 : 12;

// ── Injected deps ──────────────────────────────────────────────────────────────

let _historyCommit = null;
let _showToastFn   = null;
let _historyUndo   = null;
let _historyDepth  = null;

/** Inject history.commit (avoids circular imports). */
export function setHistoryCommit(fn) {
  _historyCommit = fn;
}

/** Inject history + showToast. */
export function setHistoryAndToast(history, showToast) {
  _historyCommit = history.commit;
  _historyUndo   = history.undo;
  _historyDepth  = history.depth;
  _showToastFn   = showToast;
}

// Injected from main.js so selecting a measurement clears symbol+room
let _clearSymbolSelection = null;
let _clearRoomSelection   = null;

export function setClearSymbolSelection(fn) { _clearSymbolSelection = fn; }
export function setClearRoomSelection(fn)   { _clearRoomSelection   = fn; }

// ── Tool bridge (wallTool) ────────────────────────────────────────────────────

let _setTool      = null;
let _isMeasureMode = null;

/**
 * Inject { setTool, isMeasureMode } from wallTool.
 * @param {{ setTool:(t:string)=>void, isMeasureMode:()=>boolean }} fns
 */
export function setToolBridge(fns) {
  _setTool       = fns.setTool;
  _isMeasureMode = fns.isMeasureMode;
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

let _snapTagEl = null;

// ── State ──────────────────────────────────────────────────────────────────────

/**
 * In-progress draft: { a:{x,y}, cursor:{x,y}, snapType } or null.
 * Set after first tap; cleared after second tap or Escape.
 */
let _draft = null;

/** Currently selected measurement id, or null. */
let _selectedId = null;

/** Alt modifier: force raw/free snap. */
let _altHeld = false;

// ── Init ───────────────────────────────────────────────────────────────────────

/**
 * Bind DOM refs and wire keyboard.
 * @param {{ stage:Element, btnMeasure:Element, snapTag:Element }} refs
 */
export function init(refs) {
  _snapTagEl = refs.snapTag;

  window.addEventListener("keydown", _onKeyDown);
  window.addEventListener("keyup",   _onKeyUp);
  window.addEventListener("blur",    _onWindowBlur);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Called by interactions.js on tap-release in measure mode. */
export function onMeasureTap(sx, sy) {
  const snapped = resolveEndpointSnap(sx, sy, _altHeld);

  if (_draft === null) {
    // First tap: place point A
    _draft = { a: { x: snapped.x, y: snapped.y }, cursor: { x: snapped.x, y: snapped.y }, snapType: snapped.type };
  } else {
    // Second tap: commit or discard
    const a = _draft.a;
    const b = { x: snapped.x, y: snapped.y };
    const minLenM = MIN_LEN_PX / pxPerM();
    const dist = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    if (dist < minLenM) {
      // Too short — discard, keep draft cleared (edge case 2)
      _draft = null;
      scheduleRender();
      return;
    }
    const m = createMeasurement(a, b);
    addMeasurement(m);
    if (_historyCommit) _historyCommit();
    _draft = null;
    scheduleRender();
  }
}

/** Called on hover/move in measure mode to update rubber-band and snap tag. */
export function onMeasureMove(sx, sy) {
  const snapped = resolveEndpointSnap(sx, sy, _altHeld);
  if (_draft !== null) {
    _draft.cursor  = { x: snapped.x, y: snapped.y };
    _draft.snapType = snapped.type;
  }
  _positionSnapTag(sx, sy, snapped.type);
  scheduleRender();
}

/** Called when cursor leaves the canvas in measure mode. */
export function onMeasureLeave() {
  _hideSnapTag();
  // Do NOT clear _draft — A is already placed
  scheduleRender();
}

// ── Selection integration ──────────────────────────────────────────────────────

/**
 * Called by the main.js Select dispatcher on pointerdown.
 * Returns true if a measurement was hit (consumes the event).
 * @param {number} sx  screen x
 * @param {number} sy  screen y
 * @returns {boolean}
 */
export function onSelectDown(sx, sy) {
  const w = screenToWorld(sx, sy);
  const tolWorld = (MIN_HIT_PX / 2) / pxPerM();
  const hit = pickMeasurement(w.x, w.y, tolWorld);
  if (!hit) return false;

  _selectedId = hit.id;
  if (_clearSymbolSelection) _clearSymbolSelection();
  if (_clearRoomSelection)   _clearRoomSelection();
  scheduleRender();
  return true;
}

/** Drop measurement selection (mutex with symbol/room). */
export function clearSelection() {
  if (_selectedId !== null) {
    _selectedId = null;
    scheduleRender();
  }
}

/** True when a measurement is selected. */
export function hasSelection() {
  return _selectedId !== null;
}

/**
 * Remove selected measurement, commit, show toast with Undo.
 * Each delete is one commit (per LLD spec).
 */
export function deleteSelected() {
  if (_selectedId === null) return;
  const id = _selectedId;
  removeMeasurement(id);
  _selectedId = null;
  if (_historyCommit) _historyCommit();
  if (_showToastFn && _historyUndo && _historyDepth) {
    const targetDepth = _historyDepth();
    _showToastFn("Measurement deleted", {
      label: "Undo",
      onClick: () => {
        if (_historyDepth() === targetDepth) {
          if (_historyUndo()) scheduleRender();
        }
      },
    });
  }
  scheduleRender();
}

/** Clear selection + cancel draft on mode switch (called when entering Wall mode etc.). */
export function onDrawModeEnter() {
  clearSelection();
  _draft = null;
}

/**
 * Discard any open placement draft without clearing selection.
 * Called by wallTool.setTool when leaving measure mode (LLD 93 Edge Case 7).
 * Ensures the rubber-band preview is removed when the user switches to Select
 * via V key or the Select rail button — paths that bypass onDrawModeEnter.
 */
export function discardDraft() {
  if (_draft !== null) {
    _draft = null;
    scheduleRender();
  }
}

/** Get the currently selected measurement id. */
export function getSelectedId() {
  return _selectedId;
}

/** Get the current draft (for measureRender). */
export function getDraft() {
  return _draft;
}

// ── Snap resolution ────────────────────────────────────────────────────────────

/**
 * Resolve the snap target for an endpoint at screen (sx, sy).
 * Returns { x, y, type } where type ∈ "corner"|"center"|"vertex"|"edge"|"grid"|"free".
 *
 * Precedence (highest first):
 *  1. Alt held → raw free (bypasses all snap)
 *  2. Snap toggle OFF → raw free (entire stack gated, consistent w/ symbolTool)
 *  3. Object corner — symbol corners within SNAP_PT_PX
 *  4. Object center — symbol AABB center within SNAP_PT_PX
 *  5. Wall vertex — allVertices() within SNAP_PT_PX
 *  6. Wall edge — closest point on any segment within SNAP_PT_PX
 *  7. Grid snap — when snapStep() != null
 *  8. Free — raw world
 *
 * @param {number} sx
 * @param {number} sy
 * @param {boolean} altHeld
 * @returns {{ x:number, y:number, type:string }}
 */
export function resolveEndpointSnap(sx, sy, altHeld) {
  const raw = screenToWorld(sx, sy);

  // 1. Alt → always free
  if (altHeld) {
    return { x: raw.x, y: raw.y, type: "free" };
  }

  // 2. Snap toggle OFF → raw
  if (!prefsGridSnap()) {
    return { x: raw.x, y: raw.y, type: "free" };
  }

  const tolPx = SNAP_PT_PX;

  // 3. Object corners (symbol corners)
  for (let i = symbolsModel.symbols.length - 1; i >= 0; i--) {
    const sym = symbolsModel.symbols[i];
    const cs = corners(sym);
    for (const c of cs) {
      const s = worldToScreen(c.x, c.y);
      const dx = s.x - sx;
      const dy = s.y - sy;
      if (Math.sqrt(dx * dx + dy * dy) <= tolPx) {
        return { x: c.x, y: c.y, type: "corner" };
      }
    }
  }

  // 4. Object centers (symbol AABB centers)
  for (let i = symbolsModel.symbols.length - 1; i >= 0; i--) {
    const sym = symbolsModel.symbols[i];
    const a = aabb(sym);
    const s = worldToScreen(a.cx, a.cy);
    const dx = s.x - sx;
    const dy = s.y - sy;
    if (Math.sqrt(dx * dx + dy * dy) <= tolPx) {
      return { x: a.cx, y: a.cy, type: "center" };
    }
  }

  // 5. Wall vertex
  const allVerts = allVertices();
  const nearestVert = closestEndpoint(sx, sy, allVerts, null, tolPx);
  if (nearestVert !== null) {
    return { x: nearestVert.x, y: nearestVert.y, type: "vertex" };
  }

  // 6. Wall edge
  const segs = wallSegments();
  let bestEdgeDist = tolPx;
  let bestEdgePt = null;
  for (const seg of segs) {
    const pt = _projectToSegment(raw.x, raw.y, seg.a, seg.b);
    const s = worldToScreen(pt.x, pt.y);
    const dx = s.x - sx;
    const dy = s.y - sy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= bestEdgeDist) {
      bestEdgeDist = d;
      bestEdgePt = pt;
    }
  }
  if (bestEdgePt !== null) {
    return { x: bestEdgePt.x, y: bestEdgePt.y, type: "edge" };
  }

  // 7. Grid snap
  const step = snapStep();
  if (step != null) {
    const snapped = gridSnap(raw, step);
    return { x: snapped.x, y: snapped.y, type: "grid" };
  }

  // 8. Free
  return { x: raw.x, y: raw.y, type: "free" };
}

/**
 * Thin test wrapper around resolveEndpointSnap.
 *
 * Allows unit tests to call the resolver with injected view state
 * (zoom/pan) and model state, since resolveEndpointSnap reads the live
 * prefs/view/model globals. Tests set up those globals directly (same pattern
 * as other tests.html unit tests) and call this.
 *
 * This is the measureTool analogue of symbolTool.resolvePlacementForTest.
 *
 * @param {number} sx
 * @param {number} sy
 * @param {boolean} altHeld
 * @returns {{ x:number, y:number, type:string }}
 */
export function resolveEndpointSnapForTest(sx, sy, altHeld) {
  return resolveEndpointSnap(sx, sy, altHeld);
}

/**
 * Project world point (px, py) onto segment [a, b] and return the closest
 * point on the segment (clamped to endpoints).
 * @param {number} px
 * @param {number} py
 * @param {{ x:number, y:number }} a
 * @param {{ x:number, y:number }} b
 * @returns {{ x:number, y:number }}
 */
function _projectToSegment(px, py, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return { x: a.x, y: a.y };
  let t = ((px - a.x) * abx + (py - a.y) * aby) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: a.x + t * abx, y: a.y + t * aby };
}

// ── Keyboard ───────────────────────────────────────────────────────────────────

function _onKeyDown(e) {
  if (e.ctrlKey || e.metaKey) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  if (e.code === "AltLeft" || e.code === "AltRight") {
    _altHeld = true;
    scheduleRender();
    return;
  }

  // Escape: cancel in-progress draft (only in measure mode)
  if (e.key === "Escape" && _isMeasureMode && _isMeasureMode()) {
    if (_draft !== null) {
      _draft = null;
      e.stopPropagation(); // prevent main.js Escape from also acting
      scheduleRender();
    }
    // If no draft, Escape is a no-op (does not exit the tool)
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

// ── Snap-tag helpers ──────────────────────────────────────────────────────────

const SNAP_LABELS = {
  corner: "corner",
  center: "center",
  vertex: "point",
  edge:   "edge",
  grid:   "grid",
  free:   "free",
};

function _snapColors(type) {
  const p = palette();
  switch (type) {
    case "corner": return p.snapPoint;
    case "center": return p.alignCenter;
    case "vertex": return p.snapPoint;
    case "edge":   return p.snapTeal;
    case "grid":   return p.snapGrid;
    default:       return p.muted;
  }
}

function _positionSnapTag(sx, sy, type) {
  if (!_snapTagEl) return;
  const label = SNAP_LABELS[type] || type;
  const color  = _snapColors(type);
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
