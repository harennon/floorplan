/**
 * help.js — shortcuts cheat-sheet overlay controller
 *
 * Handles toggle on `?` key + help button, dismiss on Esc / outside click.
 * Registers a capture-phase window keydown listener so its Esc handling
 * pre-empts the bubble-phase wall/symbol tool listeners (Edge Case 15 /
 * GAP-3 resolution).
 *
 * Exports: init, toggle, isOpen, SHORTCUTS
 */

// ── Platform detection ────────────────────────────────────────────────────────

const _isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

// ── Shortcuts data ────────────────────────────────────────────────────────────

/**
 * Single source of truth for the overlay.
 * `mac`/`other` are display chord strings shown per-platform.
 * `group` is used for section header rows.
 * @type {{ group:string, action:string, mac:string, other:string }[]}
 */
export const SHORTCUTS = [
  // Edit
  { group: "Edit",    action: "Undo",                       mac: "⌘Z",         other: "Ctrl+Z" },
  { group: "Edit",    action: "Redo",                       mac: "⇧⌘Z",        other: "Ctrl+Shift+Z / Ctrl+Y" },
  { group: "Edit",    action: "Delete selected",            mac: "Del / ⌫",    other: "Del / Backspace" },
  { group: "Edit",    action: "Duplicate selected",         mac: "⌘D",         other: "Ctrl+D" },
  // Object
  { group: "Object",  action: "Nudge selected",             mac: "↑ ↓ ← →",   other: "↑ ↓ ← →" },
  { group: "Object",  action: "Coarse nudge",               mac: "⇧↑↓←→",     other: "Shift+↑↓←→" },
  { group: "Object",  action: "Rotate 90° CW",              mac: "R",          other: "R" },
  { group: "Object",  action: "Rotate 90° CCW",             mac: "⇧R",         other: "Shift+R" },
  // Tools
  { group: "Tools",   action: "Draw wall",                  mac: "W",          other: "W" },
  { group: "Tools",   action: "Select",                     mac: "V",          other: "V" },
  { group: "Tools",   action: "Measure (distance)",         mac: "M",          other: "M" },
  // View
  { group: "View",    action: "Zoom in",                    mac: "+ / =",      other: "+ / =" },
  { group: "View",    action: "Zoom out",                   mac: "− / _",      other: "− / _" },
  { group: "View",    action: "Reset zoom",                 mac: "0",          other: "0" },
  { group: "View",    action: "Zoom to fit content",        mac: "⇧1",         other: "Shift+1" },
  // Snap
  { group: "Snap",    action: "Toggle snapping",            mac: "S",          other: "S" },
  { group: "Snap",    action: "Free snap (momentary)",      mac: "⌥ hold",     other: "Alt hold" },
  // Drawing
  { group: "Drawing", action: "Finish chain",               mac: "Enter",      other: "Enter" },
  { group: "Drawing", action: "Remove last point (drawing)", mac: "⌫",         other: "Backspace" },
  // General
  { group: "General", action: "Toggle shortcuts overlay",   mac: "?",          other: "?" },
  { group: "General", action: "Deselect / cancel",          mac: "Esc",        other: "Esc" },
];

// ── State ─────────────────────────────────────────────────────────────────────

let _open       = false;
/** @type {Element|null} */
let _overlayEl  = null;
/** @type {Element|null} */
let _buttonEl   = null;

// ── Private: render table ─────────────────────────────────────────────────────

/**
 * Build <tr> rows into #help-table-body, choosing mac/non-mac chords.
 * Group header rows are injected before each group's first entry.
 * @param {boolean} isMac
 */
function _renderTable(isMac) {
  const tbody = document.getElementById("help-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  let lastGroup = null;
  for (const entry of SHORTCUTS) {
    // Inject a group header row when the group changes
    if (entry.group !== lastGroup) {
      lastGroup = entry.group;
      const headerRow = document.createElement("tr");
      headerRow.setAttribute("aria-hidden", "true");
      const headerTd = document.createElement("td");
      headerTd.colSpan = 2;
      headerTd.style.cssText = "padding-top:0.6rem; padding-bottom:0.15rem; color:var(--muted); font-size:0.6rem; letter-spacing:0.08em; text-transform:uppercase; opacity:0.7;";
      headerTd.textContent = entry.group;
      headerRow.appendChild(headerTd);
      tbody.appendChild(headerRow);
    }

    const chord = isMac ? entry.mac : entry.other;
    const tr = document.createElement("tr");

    const tdKey = document.createElement("td");
    tdKey.className = "help-key";
    // Split compound chords like "⌘Z" or "Ctrl+Shift+Z / Ctrl+Y" into <kbd> elements
    const parts = chord.split(" / ");
    parts.forEach((part, i) => {
      const kbd = document.createElement("kbd");
      kbd.textContent = part;
      tdKey.appendChild(kbd);
      if (i < parts.length - 1) {
        tdKey.appendChild(document.createTextNode(" / "));
      }
    });

    const tdAction = document.createElement("td");
    tdAction.textContent = entry.action;

    tr.appendChild(tdKey);
    tr.appendChild(tdAction);
    tbody.appendChild(tr);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Wire DOM refs and register listeners.
 * @param {{ button: Element, overlay: Element }} refs
 */
export function init(refs) {
  _buttonEl  = refs.button;
  _overlayEl = refs.overlay;

  // Populate the shortcuts table from the SHORTCUTS data array
  _renderTable(_isMac);

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

// ── Internal render helper (exported for tests) ───────────────────────────────

/** @internal — exposed for unit tests; renders the table with the given platform flag. */
export function renderTableForTest(isMac) {
  _renderTable(isMac);
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
