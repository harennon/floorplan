/**
 * shortcuts.js — global keyboard chords + cheat-sheet modal + help button (LLD 20)
 *
 * Owns: Ctrl/Cmd+Z/Y/Shift+Z (undo/redo), Ctrl/Cmd+D (duplicate),
 * ? (toggle modal), Esc (close modal).
 *
 * Existing non-chord keys (V/W/Esc/Enter/Backspace/Alt/Delete/R) stay in
 * wallTool.js / symbolTool.js; this module only handles ctrl/meta chords.
 */

// ── Platform detection ────────────────────────────────────────────────────────

/** True on macOS/iPadOS/iOS — drives ⌘ vs Ctrl label text. */
export const IS_MAC = /Mac|iPod|iPhone|iPad/.test(
  (typeof navigator !== "undefined" ? navigator.platform : "") || ""
);

// ── State ─────────────────────────────────────────────────────────────────────

let _modal   = null;
let _btnHelp = null;

let _undoFn      = () => {};
let _redoFn      = () => {};
let _duplicateFn = () => {};
let _isDragging  = () => false;

let _modalOpen = false;

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   undo:      () => void,
 *   redo:      () => void,
 *   duplicate: () => void,
 *   modal:     HTMLElement,
 *   btnHelp:   HTMLElement,
 *   isDragging?: () => boolean,
 * }} refs
 */
export function init(refs) {
  _undoFn      = refs.undo;
  _redoFn      = refs.redo;
  _duplicateFn = refs.duplicate;
  _modal       = refs.modal;
  _btnHelp     = refs.btnHelp;
  _modalOpen   = false;   // reset open state on re-init
  if (refs.isDragging) _isDragging = refs.isDragging;
  else _isDragging = () => false;

  // Help button: toggle modal
  if (_btnHelp) {
    _btnHelp.addEventListener("click", () => _toggleModal());
  }

  // Close button inside modal
  const closeBtn = _modal && _modal.querySelector("[data-action='close-shortcuts']");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => _closeModal());
  }

  // Backdrop click: close modal
  if (_modal) {
    _modal.addEventListener("click", (e) => {
      // Only close when clicking the backdrop itself, not its content
      if (e.target === _modal) _closeModal();
    });
  }

  // Global keydown (remove any previous registration first so re-init is clean)
  window.removeEventListener("keydown", _onKeyDown);
  window.addEventListener("keydown", _onKeyDown);
}

/** True while the cheat-sheet modal is open (other shortcuts suppressed). */
export function isModalOpen() {
  return _modalOpen;
}

// ── Private ───────────────────────────────────────────────────────────────────

function _onKeyDown(e) {
  const tag = document.activeElement && document.activeElement.tagName;
  const inField = (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT");
  const ctrl = e.ctrlKey || e.metaKey;

  // Esc closes the modal from anywhere (even inside a field is fine, but
  // text fields own Esc so only handle when modal is open and focus is inside).
  if (e.key === "Escape") {
    if (_modalOpen) {
      e.preventDefault();
      _closeModal();
    }
    return;
  }

  // Focus trap: Tab/Shift+Tab while the modal is open must stay within it.
  // Prevents keyboard focus from leaving the dialog into the background UI.
  if (_modalOpen && _modal && e.key === "Tab") {
    const focusable = Array.from(_modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ));
    if (focusable.length > 0) {
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    return;
  }

  // ? opens/closes the modal
  if (e.key === "?" && !ctrl && !inField) {
    e.preventDefault();
    _toggleModal();
    return;
  }

  // All other shortcuts suppressed when modal is open or focus is in a field
  if (_modalOpen || inField) return;

  // Drag guard: suppress undo/redo/duplicate during an active drag
  const dragging = _isDragging();

  if (ctrl) {
    const shift = e.shiftKey;
    // Use toLowerCase() so the chord matches regardless of whether Shift is held:
    // when Shift is held e.key is the uppercase letter (e.g. "Z"), not "z".
    const lkey  = e.key.toLowerCase();

    if (lkey === "z" && !shift) {
      // Undo
      e.preventDefault();
      if (!dragging) _undoFn();
      return;
    }

    if ((lkey === "z" && shift) || lkey === "y") {
      // Redo: Ctrl/Cmd+Shift+Z (key="Z" when Shift held) or Ctrl/Cmd+Y
      e.preventDefault();
      if (!dragging) _redoFn();
      return;
    }

    if (lkey === "d") {
      // Duplicate
      e.preventDefault();
      if (!dragging) _duplicateFn();
      return;
    }
  }
}

function _toggleModal() {
  if (_modalOpen) {
    _closeModal();
  } else {
    _openModal();
  }
}

function _openModal() {
  if (!_modal) return;
  _modalOpen = true;
  _modal.removeAttribute("hidden");
  _modal.setAttribute("aria-hidden", "false");
  // Focus the close button for keyboard accessibility
  const closeBtn = _modal.querySelector("[data-action='close-shortcuts']");
  if (closeBtn) {
    // Use setTimeout so the hidden removal is rendered before focus
    setTimeout(() => closeBtn.focus(), 0);
  }
}

function _closeModal() {
  if (!_modal) return;
  _modalOpen = false;
  _modal.setAttribute("hidden", "");
  _modal.setAttribute("aria-hidden", "true");
  // Return focus to the help button
  if (_btnHelp) _btnHelp.focus();
}
