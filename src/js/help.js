/**
 * help.js — shortcuts cheat-sheet overlay controller
 *
 * Handles toggle on `?` key + help button, dismiss on Esc / outside click.
 * Registers a capture-phase window keydown listener so its Esc handling
 * pre-empts the bubble-phase wall/symbol tool listeners (Edge Case 15 /
 * GAP-3 resolution).
 *
 * Exports: init, toggle, isOpen
 */

// ── State ─────────────────────────────────────────────────────────────────────

let _open       = false;
/** @type {Element|null} */
let _overlayEl  = null;
/** @type {Element|null} */
let _buttonEl   = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Wire DOM refs and register listeners.
 * @param {{ button: Element, overlay: Element }} refs
 */
export function init(refs) {
  _buttonEl  = refs.button;
  _overlayEl = refs.overlay;

  // Button click toggles overlay
  if (_buttonEl) {
    _buttonEl.addEventListener("click", toggle);
  }

  // Capture-phase keydown on window: Esc closes overlay before bubble phase
  // reaches wallTool / symbolTool (GAP-3 resolution, Edge Case 15).
  window.addEventListener("keydown", _onKey, true /* capture */);

  // Outside-click dismissal (bubble phase on document)
  document.addEventListener("click", _onDocumentClick);
}

/** Show or hide the cheat sheet. */
export function toggle() {
  if (_open) {
    _close();
  } else {
    _openOverlay();
  }
}

/** True while the overlay is visible. Consumed by wallTool's Esc guard. */
export function isOpen() {
  return _open;
}

// ── Private ────────────────────────────────────────────────────────────────────

function _openOverlay() {
  _open = true;
  if (_overlayEl) {
    _overlayEl.classList.add("help-overlay--visible");
  }
  if (_buttonEl) {
    _buttonEl.setAttribute("aria-pressed", "true");
  }
}

function _close() {
  _open = false;
  if (_overlayEl) {
    _overlayEl.classList.remove("help-overlay--visible");
  }
  if (_buttonEl) {
    _buttonEl.setAttribute("aria-pressed", "false");
  }
}

/**
 * Capture-phase keydown handler.
 * - `?` (Shift+/) toggles the overlay (unless focus is in a text field).
 * - `Esc` closes the overlay and stops propagation so the event never reaches
 *   the bubble-phase wallTool Esc listener (finishChain).
 */
function _onKey(e) {
  // Skip when focus is in an editable element (preserve native text editing)
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
    e.stopPropagation();
    toggle();
    return;
  }

  if (e.key === "Escape" && _open) {
    // Stop propagation + preventDefault so this Esc never reaches the
    // bubble-phase wallTool._onKeyDown (which would call finishChain).
    e.stopPropagation();
    e.preventDefault();
    _close();
  }
}

/**
 * Document-level click handler: close the overlay when the user clicks outside
 * of it (but not when clicking the help button itself — button has its own
 * listener).
 */
function _onDocumentClick(e) {
  if (!_open) return;
  if (_overlayEl && _overlayEl.contains(/** @type {Node} */ (e.target))) return;
  if (_buttonEl  && _buttonEl.contains(/** @type {Node} */ (e.target))) return;
  _close();
}
