/**
 * roomTool.js — room selection + whole-room move-drag controller (LLD 63)
 *
 * Mirrors symbolTool.js for rooms. Owns:
 *  - _selectedRoomId (session-only room selection)
 *  - Select-mode hooks: onSelectDown / onSelectMove / onSelectUp / onTapEmpty
 *  - Whole-room rigid translate (moveRoom) following the pointer, grid-snapped on
 *    the reference vertex (verts[0]), obeying the persistent snap toggle (Alt = free)
 *  - Carried furniture: symbols whose center is inside the room at drag start are
 *    translated by the same (dx, dy) — snapshotted once at onSelectDown
 *  - One history commit per drag on onSelectUp
 *  - The room↔symbol selection mutex (clears symbol selection on a room hit via
 *    an injected clearSymbolSelection)
 *
 * Pure geometry lives in walls.js (moveRoom); this module is the DOM/interaction
 * layer and is imported only by main.js (never by mcp/).
 *
 * NOTE (LLD 21/63): this module registers NO editing-shortcut keydown of its own
 * (Delete/nudge/duplicate are owned by main.js). It does track the Alt modifier
 * for free-snap, exactly like symbolTool.
 */

import { screenToWorld } from "./view.js";
import { model as wallsModel, moveRoom, gridSnap, pointNearRoomWall, WALL_M } from "./walls.js";
import { pointInRoom } from "./clearance.js";
import { model as symbolsModel, getSymbol, moveSymbol, CATALOG } from "./symbols.js";
import { gridSnap as prefsGridSnap } from "./prefs.js";
import { snapStep } from "./grid.js";
import { scheduleRender } from "./surface.js";

// history and clearSymbolSelection are injected from main.js to avoid circular imports
let _historyCommit = null;
let _showToastFn   = null;
let _clearSymbolSelection = null;

// ── Nudge debounce state (LLD 96) ─────────────────────────────────────────────

/** Debounce window for coalescing a burst of nudges into one undo step.
 *  Same value as symbolTool.NUDGE_COMMIT_MS (LLD 54). Module-private. */
const NUDGE_COMMIT_MS = 400;

/** @type {ReturnType<typeof setTimeout>|null} */
let _nudgeTimer = null;

// ── State ──────────────────────────────────────────────────────────────────────

/** @type {string|null} id of the currently selected room */
let _selectedRoomId = null;

/** Whether a move-drag is in progress. */
let _dragging = false;

/** Pointer offset from the reference vertex (verts[0]) at drag start, world metres. */
let _dragOffsetX = 0;
let _dragOffsetY = 0;

/** Ids of symbols whose center was inside the room at drag start (carried furniture). */
let _carriedSymbolIds = [];

/** Whether Alt is held (forces free snap). */
let _altHeld = false;

// ── DOM refs ─────────────────────────────────────────────────────────────────

let _stage = null;

// ── Init ─────────────────────────────────────────────────────────────────────

/**
 * @param {{ stage: Element }} refs
 */
export function init(refs) {
  _stage = refs.stage;

  // Alt held for free snap (mirrors symbolTool; not an editing shortcut)
  window.addEventListener("keydown", _onAltDown);
  window.addEventListener("keyup",   _onAltUp);
  window.addEventListener("blur",    _onWindowBlur);
}

/**
 * Inject history.commit + showToast from main.js (avoids circular import),
 * same pattern as symbolTool.setHistoryAndToast.
 * @param {{ commit:()=>void }} history
 * @param {(msg:string, action?:{label:string,onClick:()=>void})=>void} showToast
 */
export function setHistoryAndToast(history, showToast) {
  _historyCommit = history.commit;
  _showToastFn   = showToast;
}

/**
 * Injected from main.js: clears the SYMBOL selection. Called on roomTool's own
 * onSelectDown success path to enforce the room↔symbol selection mutex without
 * roomTool importing symbolTool (avoids a cycle; mirrors the history injection).
 * @param {()=>void} fn
 */
export function setClearSymbolSelection(fn) {
  _clearSymbolSelection = fn;
}

// ── Public API (for the main.js select dispatcher) ─────────────────────────────

/**
 * Select-hook: returns true if a CLOSED room interior was hit (consume the gesture),
 * else false (let pan / symbol path proceed). Called by the main.js dispatcher AFTER
 * symbolTool.onSelectDown returns false. On success: sets _selectedRoomId, calls the
 * injected clearSymbolSelection() (mutex), and snapshots carried-symbol ids.
 * @param {number} sx screen x
 * @param {number} sy screen y
 * @returns {boolean}
 */
export function onSelectDown(sx, sy) {
  const wp = screenToWorld(sx, sy);

  // Hit-test closed-room interiors; last match wins (topmost draw order),
  // mirroring pickSymbol's last-wins rule (Edge Case 3).
  let hitRoom = null;
  for (const room of wallsModel.rooms) {
    if (!room.closed || room.verts.length < 3) continue;
    if (pointInRoom(room, wp.x, wp.y)) hitRoom = room;
  }
  if (!hitRoom) return false;

  // Mutex: picking a room drops any symbol selection.
  if (_clearSymbolSelection) _clearSymbolSelection();

  _selectedRoomId = hitRoom.id;
  _dragging = true;

  // Grabbed anchor is the reference vertex (verts[0]).
  const ref = hitRoom.verts[0];
  _dragOffsetX = wp.x - ref.x;
  _dragOffsetY = wp.y - ref.y;

  // Snapshot carried symbols at drag start (computed once — a symbol that starts
  // attached stays attached the whole drag, unlike nudge which recomputes per step).
  _carriedSymbolIds = _carriedSymbolsFor(hitRoom);

  scheduleRender();
  return true;
}

/**
 * Drag: translate the selected room (+ carried symbols) to follow the pointer,
 * grid-snapped on the reference vertex (honours prefs.gridSnap() + snapStep();
 * Alt forces free).
 * @param {number} sx
 * @param {number} sy
 */
export function onSelectMove(sx, sy) {
  if (!_dragging || !_selectedRoomId) return;
  const room = wallsModel.rooms.find(r => r.id === _selectedRoomId);
  if (!room || room.verts.length === 0) return;

  const wp = screenToWorld(sx, sy);
  let refX = wp.x - _dragOffsetX;
  let refY = wp.y - _dragOffsetY;

  // Grid snap the reference vertex (unless Alt held or snapping off).
  if (!_altHeld && prefsGridSnap()) {
    const step = snapStep();
    if (step != null) {
      const snapped = gridSnap({ x: refX, y: refY }, step);
      refX = snapped.x;
      refY = snapped.y;
    }
  }

  // Absolute positioning: delta from the reference vertex's CURRENT position to
  // its target. moveRoom translates all verts by the delta; carried symbols move
  // by the same delta so they stay attached.
  const ref = room.verts[0];
  const dx = refX - ref.x;
  const dy = refY - ref.y;
  if (dx === 0 && dy === 0) return;

  moveRoom(room, dx, dy);
  for (const id of _carriedSymbolIds) {
    const sym = getSymbol(id);
    if (sym) moveSymbol(sym, sym.x + dx, sym.y + dy);
  }
  scheduleRender();
}

/**
 * Finalize the move-drag. Commits to history (dirty-check no-ops a zero-distance
 * drag). Selection persists (mirrors symbolTool).
 */
export function onSelectUp(sx, sy) {
  _dragging = false;
  _carriedSymbolIds = [];
  if (_historyCommit) _historyCommit();
}

/**
 * Clear room selection WITHOUT touching symbol selection. Called by the dispatcher
 * on a symbol hit (mutex: picking a symbol drops the room), and internally by
 * onTapEmpty / onDrawModeEnter. Idempotent; no-op when nothing selected. Does not
 * schedule a render (the caller owns render scheduling).
 * Flushes any pending nudge first so a pending nudge commits before the room is
 * dropped (LLD 96 Edge Case 6).
 */
export function clearSelection() {
  flushNudge();
  _selectedRoomId = null;
  _dragging = false;
  _carriedSymbolIds = [];
}

/**
 * Tap on empty canvas: clear room selection (delegates to clearSelection).
 */
export function onTapEmpty() {
  clearSelection();
  scheduleRender();
}

/**
 * For wallRender selection outline: the currently selected room id, or null.
 * @returns {string|null}
 */
export function getSelectedRoomId() {
  return _selectedRoomId;
}

/** @returns {boolean} true when a room is currently selected */
export function hasSelection() {
  return _selectedRoomId !== null;
}

/**
 * Clear selection when switching to draw mode (parallels symbolTool.onDrawModeEnter).
 * clearSelection() flushes any pending nudge before dropping the room (LLD 96).
 */
export function onDrawModeEnter() {
  clearSelection();
  scheduleRender();
}

// ── Nudge / flush — keyboard action exports (LLD 96) ─────────────────────────

/**
 * Ids of symbols carried by `room`: furniture whose center is strictly inside
 * (pointInRoom), plus openings within WALL_M of one of the room's own wall segments
 * (pointNearRoomWall). Pure over the current model state. Used by onSelectDown
 * (snapshot at drag start) and nudgeSelected (recomputed per nudge).
 * @param {{ verts: {x:number,y:number}[], id: string }} room
 * @returns {string[]}
 */
function _carriedSymbolsFor(room) {
  const ids = [];
  for (const sym of symbolsModel.symbols) {
    const isOpening = !!CATALOG[sym.type]?.openings;
    const attached = isOpening
      ? pointNearRoomWall(room, sym.x, sym.y, WALL_M)
      : pointInRoom(room, sym.x, sym.y);
    if (attached) ids.push(sym.id);
  }
  return ids;
}

/**
 * Move the selected room by (dx, dy) world metres, carrying its furniture.
 * No-op if no room selected or the room has no verts. Applies the delta literally
 * (no grid snap resolve). Rigidly translates walls via moveRoom and every
 * currently-carried symbol via moveSymbol, then scheduleRender(). Schedules a
 * debounced history.commit() (NUDGE_COMMIT_MS) so a burst collapses to one undo step.
 * Mirrors symbolTool.nudgeSelected (LLD 54).
 * @param {number} dx  world metres
 * @param {number} dy  world metres
 */
export function nudgeSelected(dx, dy) {
  if (!_selectedRoomId) return;
  const room = wallsModel.rooms.find(r => r.id === _selectedRoomId);
  if (!room || room.verts.length === 0) return;
  // Compute carried set from the room's CURRENT position (before the move) so that
  // a symbol the room steps onto becomes carried on the *next* nudge, not this one —
  // matching the LLD's "nudged onto" language (Edge Case 8).
  const carried = _carriedSymbolsFor(room);
  moveRoom(room, dx, dy);
  for (const id of carried) {
    const sym = getSymbol(id);
    if (sym) moveSymbol(sym, sym.x + dx, sym.y + dy);
  }
  scheduleRender();
  clearTimeout(_nudgeTimer);
  _nudgeTimer = setTimeout(() => {
    _nudgeTimer = null;
    if (_historyCommit) _historyCommit();
  }, NUDGE_COMMIT_MS);
}

/**
 * If a nudge commit is pending, cancel the timer and commit now. No-op when none
 * pending. Called before any other committing action (undo/redo, deselect,
 * draw-mode enter) so undo-stack ordering stays correct. Mirrors symbolTool.flushNudge.
 */
export function flushNudge() {
  if (_nudgeTimer !== null) {
    clearTimeout(_nudgeTimer);
    _nudgeTimer = null;
    if (_historyCommit) _historyCommit();
  }
}

// ── Keyboard (Alt modifier only — no editing shortcuts) ────────────────────────

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
