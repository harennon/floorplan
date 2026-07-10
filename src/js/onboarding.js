/**
 * onboarding.js — first-run coach-mark controller (LLD-60)
 *
 * Shows two anchored coach-marks on an empty first run:
 *   1. Wall-tool tip   — anchored to #tool-wall (left rail)
 *   2. Template tip    — anchored to #empty-cta (empty-state CTA)
 *
 * Never blocks the canvas. Dismisses permanently on the first meaningful
 * interaction. Persists a seen-flag inside the existing floorplan:prefs:v1
 * object via prefs.js.
 *
 * Mirrors the help.js / templates.js controller pattern.
 * Exports: init, maybeShow, dismiss, isShown
 */

import { onboardingSeen, setOnboardingSeen } from "./prefs.js";

// ── State ─────────────────────────────────────────────────────────────────────

let _shown = false;

/** @type {Element|null} */
let _container   = null;
/** @type {Element|null} */
let _wallTip     = null;
/** @type {Element|null} */
let _templateTip = null;
/** @type {Element|null} */
let _dismissBtn  = null;
/** @type {Element|null} */
let _stage       = null;
/** @type {Element|null} */
let _wallBtn     = null;
/** @type {Element|null} */
let _emptyCta    = null;
/** @type {(() => boolean)|null} */
let _isEmpty = null;

/** rAF id for throttled reposition */
let _rafId = null;

// One-shot listeners — kept so they can be removed on dismiss.
let _stageListener    = null;
let _wallBtnListener  = null;
let _emptyCtaListener = null;
let _keyListener      = null;
let _resizeListener   = null;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Wire anchors + injected callbacks; register dismissal & reposition listeners.
 * Does NOT show anything — call maybeShow() when appropriate.
 *
 * @param {{
 *   container:   Element,
 *   wallTip:     Element,
 *   templateTip: Element,
 *   dismissBtn:  Element,
 *   stage:       Element,
 *   wallBtn:     Element,
 *   emptyCta?:   Element,
 *   isEmpty:     () => boolean,
 * }} refs
 */
export function init(refs) {
  _container   = refs.container;
  _wallTip     = refs.wallTip;
  _templateTip = refs.templateTip;
  _dismissBtn  = refs.dismissBtn;
  _stage       = refs.stage;
  _wallBtn     = refs.wallBtn;
  _emptyCta    = refs.emptyCta || null;
  _isEmpty  = refs.isEmpty;

  // Dismiss-button click
  if (_dismissBtn) {
    _dismissBtn.addEventListener("click", dismiss);
  }
}

/**
 * Show the coach-marks iff: not seen before AND isEmpty() AND at least one
 * anchor is visible & on-screen. Suppresses individual tips whose anchor is
 * unavailable. If no tip can be shown, shows nothing and does NOT set the
 * seen flag.
 * @returns {boolean} true if at least one tip was shown.
 */
export function maybeShow() {
  // Gate 1: already seen
  if (onboardingSeen()) return false;
  // Gate 2: plan is non-empty
  if (_isEmpty && !_isEmpty()) return false;
  // Gate 3: container or tips not wired
  if (!_container || !_wallTip || !_templateTip) return false;

  // Check individual anchor visibility
  const wallVisible     = _wallBtn  ? _isAnchorVisible(_wallBtn)  : false;
  const templateVisible = _emptyCta ? _isAnchorVisible(_emptyCta) : false;

  // If neither tip can show, bail without setting the seen flag
  if (!wallVisible && !templateVisible) return false;

  // Show container (holds both tips + dismiss button)
  _container.hidden = false;

  // Position and show the wall tip
  if (wallVisible) {
    _positionWallTip();
    _wallTip.hidden = false;
  } else {
    _wallTip.hidden = true;
  }

  // Position and show the template tip
  if (templateVisible) {
    _positionTemplateTip();
    _templateTip.hidden = false;
  } else {
    _templateTip.hidden = true;
  }

  // Position the dismiss button
  _positionDismissBtn();

  _shown = true;

  // Register one-shot dismissal listeners
  _registerListeners();

  return true;
}

/**
 * Hide all coach-marks and persist setOnboardingSeen(true). Idempotent.
 */
export function dismiss() {
  if (!_shown && (!_container || _container.hidden)) return;
  _shown = false;
  if (_container) _container.hidden = true;
  setOnboardingSeen(true);
  _removeListeners();
}

/**
 * True while any coach-mark is visible.
 * @returns {boolean}
 */
export function isShown() {
  return _shown;
}

// ── Private: anchor visibility ────────────────────────────────────────────────

/**
 * Returns true if the element is rendered, has non-zero dimensions, and its
 * center lies within the viewport.
 * @param {Element} el
 * @returns {boolean}
 */
function _isAnchorVisible(el) {
  // Must have an offsetParent (not display:none / collapsed ancestor)
  if (el.offsetParent === null) return false;
  const rect = el.getBoundingClientRect();
  // Must have non-zero size
  if (rect.width === 0 && rect.height === 0) return false;
  // Center must be within the viewport
  const cx = rect.left + rect.width / 2;
  const cy = rect.top  + rect.height / 2;
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
  return true;
}

// ── Private: positioning ─────────────────────────────────────────────────────

const _GAP    = 10; // px gap between anchor edge and tip
const _MARGIN = 8;  // px viewport margin to keep tips on-screen

/**
 * Clamp a coordinate so the element [start, start+size] stays within
 * [margin, viewportSize - margin].
 */
function _clamp(start, size, viewportSize) {
  const lo = _MARGIN;
  const hi = viewportSize - size - _MARGIN;
  return Math.max(lo, Math.min(hi, start));
}

/**
 * Position the wall tip to the right of #tool-wall, vertically centred.
 * If there's not enough room to the right, fall back to the left.
 */
function _positionWallTip() {
  if (!_wallTip || !_wallBtn) return;
  const rect    = _wallBtn.getBoundingClientRect();
  const tipRect = _wallTip.getBoundingClientRect();
  const tipW    = tipRect.width  || 240; // approximate if not laid-out yet
  const tipH    = tipRect.height || 48;

  // Prefer right side; fall back to left
  let left = rect.right + _GAP;
  let side = "left"; // arrow points left (tip is to the right of the anchor)
  if (left + tipW + _MARGIN > window.innerWidth) {
    left = rect.left - tipW - _GAP;
    side = "right"; // arrow points right (tip is to the left of the anchor)
  }

  // Vertically centre on button
  const top = rect.top + rect.height / 2 - tipH / 2;

  _wallTip.style.left = _clamp(left, tipW, window.innerWidth) + "px";
  _wallTip.style.top  = _clamp(top,  tipH, window.innerHeight) + "px";

  // Set arrow side so CSS can rotate it
  const arrow = _wallTip.querySelector(".coach-arrow");
  if (arrow) arrow.dataset.side = side;
}

/**
 * Position the template tip above #empty-cta, horizontally centred.
 * If there's not enough room above, show below.
 */
function _positionTemplateTip() {
  if (!_templateTip || !_emptyCta) return;
  const rect    = _emptyCta.getBoundingClientRect();
  const tipRect = _templateTip.getBoundingClientRect();
  const tipW    = tipRect.width  || 240;
  const tipH    = tipRect.height || 48;

  // Prefer above; fall back to below
  let top  = rect.top - tipH - _GAP;
  let side = "bottom"; // arrow points down (tip is above the anchor)
  if (top - _MARGIN < 0) {
    top  = rect.bottom + _GAP;
    side = "top"; // arrow points up (tip is below the anchor)
  }

  // Horizontally centre on CTA
  const left = rect.left + rect.width / 2 - tipW / 2;

  _templateTip.style.left = _clamp(left, tipW, window.innerWidth) + "px";
  _templateTip.style.top  = _clamp(top,  tipH, window.innerHeight) + "px";

  const arrow = _templateTip.querySelector(".coach-arrow");
  if (arrow) arrow.dataset.side = side;
}

/**
 * Position the dismiss button below the lower visible tip.
 * Falls back to top-center (beneath any title bar area) if no tip rect is
 * available, avoiding the #symbol-dock at the bottom.
 */
function _positionDismissBtn() {
  if (!_dismissBtn) return;
  const btnRect = _dismissBtn.getBoundingClientRect();
  const btnW = btnRect.width  || 160;
  const btnH = btnRect.height || 36;

  // Collect the bottom edge of each visible tip AND its anchor.
  // The template tip is positioned above #empty-cta, so its bottom is above the
  // CTA. Without including the anchor we'd land inside the gap between the tip
  // and the CTA (dismiss button would visually appear between them and the arrow
  // would appear to point at the dismiss button rather than the CTA).
  let lowestBottom = 0;
  if (_wallTip && !_wallTip.hidden) {
    const r = _wallTip.getBoundingClientRect();
    if (r.bottom > lowestBottom) lowestBottom = r.bottom;
  }
  if (_templateTip && !_templateTip.hidden) {
    const r = _templateTip.getBoundingClientRect();
    if (r.bottom > lowestBottom) lowestBottom = r.bottom;
    // Also clear the anchor so the dismiss button sits below the CTA, not inside
    // the gap between the tip arrow and the CTA it points at.
    if (_emptyCta) {
      const ar = _emptyCta.getBoundingClientRect();
      if (ar.bottom > lowestBottom) lowestBottom = ar.bottom;
    }
  }

  let top;
  if (lowestBottom > 0) {
    // Place just below the lower of the two visible tips
    top = lowestBottom + _GAP;
  } else {
    // No tip rect available — place near top-quarter of viewport so it doesn't
    // collide with the bottom-center symbol dock.
    top = window.innerHeight * 0.25;
  }

  const left = window.innerWidth / 2 - btnW / 2;

  _dismissBtn.style.left = _clamp(left, btnW, window.innerWidth) + "px";
  _dismissBtn.style.top  = _clamp(top,  btnH, window.innerHeight) + "px";
}

// ── Private: reposition on resize ────────────────────────────────────────────

function _onResize() {
  if (_rafId) return; // already scheduled
  _rafId = requestAnimationFrame(() => {
    _rafId = null;
    if (!_shown) return;

    // Re-check anchor visibility; hide tips whose anchor moved off-screen
    const wallVisible     = _wallBtn  ? _isAnchorVisible(_wallBtn)  : false;
    const templateVisible = _emptyCta ? _isAnchorVisible(_emptyCta) : false;

    if (!wallVisible && !templateVisible) {
      // Both anchors gone — hide everything but keep seen-flag unset
      if (_container) _container.hidden = true;
      _shown = false;
      _removeListeners();
      return;
    }

    if (_wallTip) {
      if (wallVisible) { _positionWallTip();     _wallTip.hidden = false; }
      else               { _wallTip.hidden = true; }
    }
    if (_templateTip) {
      if (templateVisible) { _positionTemplateTip(); _templateTip.hidden = false; }
      else                   { _templateTip.hidden = true; }
    }
    _positionDismissBtn();
  });
}

// ── Private: listener management ────────────────────────────────────────────

function _registerListeners() {
  // First pointerdown on the stage
  _stageListener = () => dismiss();
  if (_stage) _stage.addEventListener("pointerdown", _stageListener);

  // Wall-tool click
  _wallBtnListener = () => dismiss();
  if (_wallBtn) _wallBtn.addEventListener("click", _wallBtnListener);

  // Empty CTA click
  _emptyCtaListener = () => dismiss();
  if (_emptyCta) _emptyCta.addEventListener("click", _emptyCtaListener);

  // Esc — bubble phase, no stopPropagation (Edge Case 4: wall chain Esc must still fire)
  _keyListener = (e) => {
    if (e.key === "Escape") dismiss();
  };
  window.addEventListener("keydown", _keyListener);

  // Resize / orientation change — rAF throttled
  _resizeListener = _onResize;
  window.addEventListener("resize", _resizeListener);
  window.addEventListener("orientationchange", _resizeListener);
}

function _removeListeners() {
  if (_stage && _stageListener) {
    _stage.removeEventListener("pointerdown", _stageListener);
    _stageListener = null;
  }
  if (_wallBtn && _wallBtnListener) {
    _wallBtn.removeEventListener("click", _wallBtnListener);
    _wallBtnListener = null;
  }
  if (_emptyCta && _emptyCtaListener) {
    _emptyCta.removeEventListener("click", _emptyCtaListener);
    _emptyCtaListener = null;
  }
  if (_keyListener) {
    window.removeEventListener("keydown", _keyListener);
    _keyListener = null;
  }
  if (_resizeListener) {
    window.removeEventListener("resize", _resizeListener);
    window.removeEventListener("orientationchange", _resizeListener);
    _resizeListener = null;
  }
  if (_rafId) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
}
