/**
 * interactions.js — pointer, wheel, keyboard event handling
 *
 * Manages:
 *  - Mouse/touch drag-to-pan (grab empty space or Space+drag)
 *  - Wheel zoom (zoom about cursor)
 *  - Touch pinch zoom (zoom about pinch midpoint)
 *  - Keyboard: Space held → pan mode
 *  - +/−/RESET zoom buttons
 *  - Hint dismissal on first interaction
 *  - Cursor state classes on stage
 *  - Mode-aware draw hooks injected from main.js (no static wall import)
 */

import { view, zoomAbout, resetView, clampZoom, screenToWorld, BASE_PX_PER_M } from "./view.js";
import { setCursorScreen } from "./hud.js";
import { scheduleRender, W, H } from "./surface.js";

// ─── Draw hooks (injected by main.js; no static wall import) ─────────────────

/**
 * @type {{ isDrawMode:()=>boolean, onHover:(sx:number,sy:number)=>void,
 *          onClick:(sx:number,sy:number)=>void, onLeave:()=>void } | null}
 */
let _drawHooks = null;

/**
 * Inject draw-mode hooks. Called once by main.js after wallTool is initialised.
 * interactions.js has no static import of wall modules (avoids cycles).
 */
export function setDrawHooks(h) {
  _drawHooks = h;
}

/** Click-vs-drag threshold in screen pixels. */
const DRAG_THRESHOLD = 6;

// ─── Transient state ────────────────────────────────────────────────────────

let _dragging = false;
let _lastX = 0;
let _lastY = 0;
let _spaceHeld = false;
let _hintDismissed = false;

/** Pending draw-mode tap state. */
let _drawPending = false;
let _drawDownX = 0;
let _drawDownY = 0;

/** Map<pointerId, PointerEvent> for multi-touch tracking. */
const _pointers = new Map();

/**
 * Pinch state. Null means "not in pinch".
 * We store the world point under the midpoint and the zoom at pinch-start
 * so we can recompute without drift on every move.
 */
let _pinchStartDist = null;
let _pinchStartZoom = null;
let _pinchWorldMidX = null;
let _pinchWorldMidY = null;

// ─── DOM refs ────────────────────────────────────────────────────────────────

let _stage = null;
let _hint = null;

// ─── Init ────────────────────────────────────────────────────────────────────

/**
 * Wire all event listeners. Called once from main.js.
 */
export function init(stage, hint, btnZoomIn, btnZoomOut, btnReset) {
  _stage = stage;
  _hint = hint;

  // Pointer events (pan + pinch).
  stage.addEventListener("pointerdown",  _onPointerDown);
  stage.addEventListener("pointermove",  _onPointerMove);
  stage.addEventListener("pointerup",    _onPointerEnd);
  stage.addEventListener("pointercancel", _onPointerEnd);
  stage.addEventListener("pointerleave", _onPointerLeave);

  // Wheel zoom.
  stage.addEventListener("wheel", _onWheel, { passive: false });

  // Keyboard: Space.
  window.addEventListener("keydown", _onKeyDown);
  window.addEventListener("keyup", _onKeyUp);

  // Zoom buttons.
  btnZoomIn.addEventListener("click", () => _stepZoom(1.25));
  btnZoomOut.addEventListener("click", () => _stepZoom(1 / 1.25));
  btnReset.addEventListener("click", _onReset);
}

// ─── Pointer handlers ────────────────────────────────────────────────────────

function _onPointerDown(e) {
  _pointers.set(e.pointerId, e);
  _stage.setPointerCapture(e.pointerId);
  _dismissHint();

  if (_pointers.size === 2) {
    // Second finger: cancel any in-flight single-pointer pan, seed pinch.
    _dragging = false;
    _drawPending = false;
    _seedPinch();
    _updateCursor();
    return;
  }

  if (_pointers.size === 1) {
    // Draw mode: record down position; defer pan start until drag threshold exceeded.
    if (_drawHooks && _drawHooks.isDrawMode() && !_spaceHeld) {
      _drawPending = true;
      _drawDownX = e.clientX;
      _drawDownY = e.clientY;
      _dragging = false;
      _lastX = e.clientX;
      _lastY = e.clientY;
      _updateCursor();
      return;
    }
    _dragging = true;
    _drawPending = false;
    _lastX = e.clientX;
    _lastY = e.clientY;
    _updateCursor();
  }
}

function _onPointerMove(e) {
  _pointers.set(e.pointerId, e);

  // Update cursor for HUD.
  setCursorScreen(e.clientX, e.clientY);

  if (_pointers.size >= 2) {
    _handlePinch();
    return;
  }

  // Draw-mode: plain hover (no button) → update snap preview.
  if (_drawHooks && _drawHooks.isDrawMode() && e.buttons === 0) {
    _drawHooks.onHover(e.clientX, e.clientY);
    return;
  }

  // Draw-mode with button down: check for drag threshold.
  if (_drawPending && _drawHooks && _drawHooks.isDrawMode()) {
    const dx = e.clientX - _drawDownX;
    const dy = e.clientY - _drawDownY;
    if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
      // Crossed threshold → cancel pending click, start panning.
      _drawPending = false;
      _dragging = true;
      _lastX = e.clientX;
      _lastY = e.clientY;
    } else {
      // Still within threshold; update snap preview (touch feedback).
      _drawHooks.onHover(e.clientX, e.clientY);
    }
    _updateCursor();
  }

  if (_dragging) {
    const dx = e.clientX - _lastX;
    const dy = e.clientY - _lastY;
    view.panX += dx;
    view.panY += dy;
    _lastX = e.clientX;
    _lastY = e.clientY;
    scheduleRender();
  }
}

function _onPointerLeave() {
  if (_drawHooks) _drawHooks.onLeave();
  _drawPending = false;
}

function _onPointerEnd(e) {
  _pointers.delete(e.pointerId);

  // Fewer than 2 pointers → clear pinch state; next move will re-seed.
  if (_pointers.size < 2) {
    _pinchStartDist = null;
    _pinchStartZoom = null;
    _pinchWorldMidX = null;
    _pinchWorldMidY = null;
  }

  if (_pointers.size === 0) {
    // Draw mode tap: pending click → commit vertex.
    if (_drawPending && _drawHooks && _drawHooks.isDrawMode()) {
      _drawHooks.onClick(e.clientX, e.clientY);
    }
    _drawPending = false;
    _dragging = false;

    // If it was a cancel / leave, clear snap preview.
    if (e.type === "pointercancel" || e.type === "pointerleave") {
      if (_drawHooks) _drawHooks.onLeave();
    }
  }

  _updateCursor();
}

// ─── Pinch ───────────────────────────────────────────────────────────────────

function _seedPinch() {
  const [a, b] = [..._pointers.values()];
  _pinchStartDist = _dist(a, b);
  _pinchStartZoom = view.zoom;
  const midX = (a.clientX + b.clientX) / 2;
  const midY = (a.clientY + b.clientY) / 2;
  const w = screenToWorld(midX, midY);
  _pinchWorldMidX = w.x;
  _pinchWorldMidY = w.y;
}

function _handlePinch() {
  if (_pointers.size < 2) return;
  const [a, b] = [..._pointers.values()];
  const d = _dist(a, b);
  const midX = (a.clientX + b.clientX) / 2;
  const midY = (a.clientY + b.clientY) / 2;

  if (_pinchStartDist === null) {
    // Re-seed after losing a pointer.
    _seedPinch();
    return;
  }

  // Target zoom from pinch ratio (from start-of-pinch baseline, no drift).
  const targetZoom = clampZoom(_pinchStartZoom * (d / _pinchStartDist));

  // Place the fixed world point under the current midpoint.
  // screen = world * (zoom * BASE) + pan  →  pan = screen - world * newScale
  const newScale = targetZoom * BASE_PX_PER_M;
  view.zoom = targetZoom;
  view.panX = midX - _pinchWorldMidX * newScale;
  view.panY = midY - _pinchWorldMidY * newScale;

  scheduleRender();
}

function _dist(a, b) {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

// ─── Wheel ───────────────────────────────────────────────────────────────────

function _onWheel(e) {
  e.preventDefault();
  _dismissHint();

  // Normalize delta across browsers / trackpad / line / page modes.
  let delta = e.deltaY;
  if (e.deltaMode === 1) delta *= 20;
  if (e.deltaMode === 2) delta *= 300;

  const factor = Math.pow(0.999, delta);
  zoomAbout(e.clientX, e.clientY, factor);
  scheduleRender();
}

// ─── Keyboard ────────────────────────────────────────────────────────────────

function _onKeyDown(e) {
  if (e.code === "Space" && !e.repeat) {
    _spaceHeld = true;
    _updateCursor();
    e.preventDefault();
  }
}

function _onKeyUp(e) {
  if (e.code === "Space") {
    _spaceHeld = false;
    _updateCursor();
  }
}

// ─── Zoom buttons ─────────────────────────────────────────────────────────────

function _stepZoom(factor) {
  _dismissHint();
  // Zoom about viewport center.
  zoomAbout(W / 2, H / 2, factor);
  scheduleRender();
}

function _onReset() {
  _dismissHint();
  resetView(W, H);
  scheduleRender();
}

// ─── Hint ─────────────────────────────────────────────────────────────────────

function _dismissHint() {
  if (_hintDismissed || !_hint) return;
  _hintDismissed = true;
  _hint.classList.add("dismissed");
}

// ─── Cursor state ─────────────────────────────────────────────────────────────

function _updateCursor() {
  if (!_stage) return;
  _stage.classList.toggle("panning", _dragging);
  _stage.classList.toggle("space-ready", _spaceHeld && !_dragging);
}
