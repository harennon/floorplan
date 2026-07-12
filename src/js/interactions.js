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
import { effectiveDrawPoint, dragThreshold } from "./pointerEnv.js";

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

// ─── Select hooks (injected by main.js; no static symbol import) ─────────────

/**
 * @type {{ onDown:(sx:number,sy:number)=>boolean,
 *          onMove:(sx:number,sy:number)=>void,
 *          onUp:(sx:number,sy:number)=>void,
 *          onTapEmpty:()=>void } | null}
 */
let _selectHooks = null;

/**
 * Inject select-mode hooks. Called once by main.js after symbolTool is initialised.
 * In select mode a single-pointer pointerdown calls selectHooks.onDown(sx,sy).
 * If it returns true, subsequent moves route to onMove and the release to onUp
 * (pan is suppressed). If it returns false, pan proceeds; a release under
 * DRAG_THRESHOLD calls onTapEmpty().
 */
export function setSelectHooks(h) {
  _selectHooks = h;
}

// ─── Measure hooks (injected by main.js; no static measureTool import) ────────

/**
 * @type {{ isActive:()=>boolean,
 *          onDown:(sx:number,sy:number)=>boolean,
 *          onMove:(sx:number,sy:number)=>void,
 *          onLeave:()=>void } | null}
 */
let _measureHooks = null;

/**
 * Inject measure-mode hooks. Called once by main.js after measureTool is initialised.
 * When isActive() and a single-pointer tap is detected, onDown is called.
 * Hover moves call onMove. Pointer-leave calls onLeave.
 * A drag (pointer travels beyond DRAG_THRESHOLD before lifting) falls through
 * to pan — the same tap-vs-drag logic as draw mode.
 */
export function setMeasureHooks(h) {
  _measureHooks = h;
}

// DRAG_THRESHOLD is now per-gesture (touch=10, mouse/pen=6); see dragThreshold() in pointerEnv.js.

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

/**
 * pointerType of the primary pointer that started the current gesture.
 * Used to select the correct drag threshold and loupe offset.
 * @type {"touch"|"mouse"|"pen"|string}
 */
let _downPointerType = "mouse";

/**
 * True after a second finger cancels an in-flight one-finger gesture (draw or
 * select-move). Blocks trailing onClick / onUp / onTapEmpty in _onPointerEnd
 * so no stray vertex is committed and no spurious history commit occurs.
 * Cleared when all pointers lift (_pointers.size === 0).
 */
let _gestureCancelled = false;

/**
 * Select-mode symbol drag state.
 * true  = select hooks consumed the down; route moves/up to them, suppress pan.
 * false = no symbol hit; pan proceeds.
 */
let _selectConsumed = false;
let _selectDownX = 0;
let _selectDownY = 0;

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
    // Second finger: cancel any in-flight single-pointer gesture, seed pinch.

    // Cancel in-flight draw gesture.
    if (_drawPending && _drawHooks) {
      _drawHooks.onLeave();
    }
    _drawPending = false;

    // Cancel in-flight measure gesture tap (keep _pendingA — per spec Edge Case 4,
    // pinch cancels the current tap only, not the whole placement).
    if (_drawPending && _measureHooks) {
      _measureHooks.onLeave();
    }

    // Cancel in-flight select-move/rotate: finalize at pre-pinch position.
    if (_selectConsumed && _selectHooks) {
      _selectHooks.onUp(_lastX, _lastY);
      _selectConsumed = false;
    }

    _gestureCancelled = true;
    _dragging = false;
    _seedPinch();
    _updateCursor();
    return;
  }

  if (_pointers.size === 1) {
    // Record the pointer type for this gesture so we can select threshold/loupe.
    _downPointerType = e.pointerType || "mouse";
    _gestureCancelled = false;

    // Measure mode: record down position; defer commit until drag threshold (same
    // tap-vs-drag logic as draw mode so a drag still pans).
    if (_measureHooks && _measureHooks.isActive() && !_spaceHeld) {
      _drawPending = true;
      _drawDownX = e.clientX;
      _drawDownY = e.clientY;
      _dragging = false;
      _lastX = e.clientX;
      _lastY = e.clientY;
      _updateCursor();
      return;
    }

    // Draw mode: record down position; defer pan start until drag threshold exceeded.
    if (_drawHooks && _drawHooks.isDrawMode() && !_spaceHeld) {
      _drawPending = true;
      _drawDownX = e.clientX;
      _drawDownY = e.clientY;
      _dragging = false;
      _lastX = e.clientX;
      _lastY = e.clientY;
      // Touch: show the loupe immediately on finger-down so the user can see
      // where the tap will land before lifting.
      if (e.pointerType === "touch") {
        const hp = effectiveDrawPoint(e.pointerType, e.clientX, e.clientY);
        _drawHooks.onHover(hp.x, hp.y, e.pointerType);
      }
      _updateCursor();
      return;
    }

    // Select mode: let select hooks try to consume the down first.
    if (_selectHooks && !(_drawHooks && _drawHooks.isDrawMode()) && !_spaceHeld) {
      const consumed = _selectHooks.onDown(e.clientX, e.clientY);
      _selectConsumed = consumed;
      _selectDownX = e.clientX;
      _selectDownY = e.clientY;
      if (consumed) {
        // Hooks consumed — suppress pan, no _dragging
        _dragging = false;
        _drawPending = false;
        _lastX = e.clientX;
        _lastY = e.clientY;
        _updateCursor();
        return;
      }
      // Not consumed — fall through to pan start below
      _lastX = e.clientX;
      _lastY = e.clientY;
      _dragging = true;
      _drawPending = false;
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

  // Measure-mode: plain hover (no button) → update rubber-band preview.
  if (_measureHooks && _measureHooks.isActive() && e.buttons === 0) {
    _measureHooks.onMove(e.clientX, e.clientY);
    return;
  }

  // Measure-mode with button down: check for drag threshold (same tap-vs-drag logic).
  if (_drawPending && _measureHooks && _measureHooks.isActive()) {
    const dx = e.clientX - _drawDownX;
    const dy = e.clientY - _drawDownY;
    const threshold = dragThreshold(_downPointerType);
    if (Math.sqrt(dx * dx + dy * dy) > threshold) {
      // Crossed threshold → cancel pending click, start panning.
      _drawPending = false;
      _dragging = true;
      _lastX = e.clientX;
      _lastY = e.clientY;
      _measureHooks.onLeave();
    } else {
      // Still within threshold; update preview.
      _measureHooks.onMove(e.clientX, e.clientY);
    }
    _updateCursor();
    return;
  }

  // Draw-mode: plain hover (no button) → update snap preview.
  if (_drawHooks && _drawHooks.isDrawMode() && e.buttons === 0) {
    const hp = effectiveDrawPoint(e.pointerType, e.clientX, e.clientY);
    _drawHooks.onHover(hp.x, hp.y, e.pointerType);
    return;
  }

  // Draw-mode with button down: check for drag threshold.
  if (_drawPending && _drawHooks && _drawHooks.isDrawMode()) {
    const dx = e.clientX - _drawDownX;
    const dy = e.clientY - _drawDownY;
    const threshold = dragThreshold(_downPointerType);
    if (Math.sqrt(dx * dx + dy * dy) > threshold) {
      // Crossed threshold → cancel pending click, start panning; hide loupe.
      _drawPending = false;
      _dragging = true;
      _lastX = e.clientX;
      _lastY = e.clientY;
      // Hide loupe by calling onLeave (which hides loupe + snap tag)
      if (_drawHooks) _drawHooks.onLeave();
    } else {
      // Still within threshold; update snap preview (touch feedback).
      const hp = effectiveDrawPoint(e.pointerType, e.clientX, e.clientY);
      _drawHooks.onHover(hp.x, hp.y, e.pointerType);
    }
    _updateCursor();
  }

  // Select hooks consumed the down → route moves to them
  if (_selectConsumed && _selectHooks) {
    _selectHooks.onMove(e.clientX, e.clientY);
    return;
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
  if (_measureHooks) _measureHooks.onLeave();
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
    if (_gestureCancelled) {
      // Gesture was cancelled by a second finger: skip all commit/finalize logic.
      _gestureCancelled = false;
      _downPointerType = "mouse";
      _drawPending = false;
      _dragging = false;
      _selectConsumed = false;
      _updateCursor();
      return;
    }

    // Measure mode tap: pending click → commit point at loupe-offset position.
    if (_drawPending && _measureHooks && _measureHooks.isActive()) {
      const hp = effectiveDrawPoint(_downPointerType, e.clientX, e.clientY);
      _measureHooks.onDown(hp.x, hp.y);
    }

    // Draw mode tap: pending click → commit vertex at loupe-offset point.
    if (_drawPending && _drawHooks && _drawHooks.isDrawMode()) {
      const hp = effectiveDrawPoint(_downPointerType, e.clientX, e.clientY);
      _drawHooks.onClick(hp.x, hp.y);
    }

    // Select hooks: finalize
    if (_selectConsumed && _selectHooks) {
      _selectHooks.onUp(e.clientX, e.clientY);
      _selectConsumed = false;
    } else if (!_drawPending && !(_drawHooks && _drawHooks.isDrawMode()) && _selectHooks) {
      // Was panning (not consumed by select hooks): if pointer didn't exceed threshold,
      // it's a tap on empty canvas
      const dx = e.clientX - _selectDownX;
      const dy = e.clientY - _selectDownY;
      const threshold = dragThreshold(_downPointerType);
      if (Math.sqrt(dx * dx + dy * dy) <= threshold) {
        _selectHooks.onTapEmpty();
      }
      _selectConsumed = false;
    }

    _drawPending = false;
    _dragging = false;
    _downPointerType = "mouse";

    // If it was a cancel / leave, clear snap preview.
    if (e.type === "pointercancel" || e.type === "pointerleave") {
      if (_drawHooks) _drawHooks.onLeave();
      if (_measureHooks) _measureHooks.onLeave();
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

// ─── Keyboard zoom wrappers (thin exports for main.js global handler) ─────────

/** Zoom in by the standard step (1.25×), about viewport center. */
export function zoomInStep() {
  _stepZoom(1.25);
}

/** Zoom out by the standard step (÷1.25), about viewport center. */
export function zoomOutStep() {
  _stepZoom(1 / 1.25);
}

/** Reset zoom/pan to the default view (identical to the RESET rail button). */
export function zoomReset() {
  _onReset();
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
