/**
 * dimensions.js — dimension-edit interaction controller (LLD 10)
 *
 * Handles click/keyboard activation of `.dim-chip` elements rendered into
 * the `.dim-layer` overlay. Opens a floating inline <input> for numeric
 * dimension entry, commits on Enter/blur, cancels on Esc.
 *
 * Uses delegated event listeners on dimLayer so per-chip listener churn is
 * avoided (chips are rebuilt every render).
 *
 * Dependencies: parseLen (units.js), findRoom / setEdgeLength (walls.js),
 *               fmtLen / unitLabel (units.js), view.onChange (view.js).
 */

import { parseLen, fmtLen, unitLabel } from "./units.js";
import { findRoom, setEdgeLength, edgeEndpoints } from "./walls.js";
import { worldToScreen, onChange as onViewChange } from "./view.js";

// ── Module state ──────────────────────────────────────────────────────────────

/** @type {HTMLElement|null} */
let _dimLayer = null;
/** @type {HTMLElement|null} */
let _stage    = null;
/** @type {(() => void)|null} */
let _onCommit = null;

/**
 * Currently-open edit target.
 * @type {{ roomId: string, edgeIndex: number, input: HTMLInputElement } | null}
 */
let _editing  = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Bind the dimension-edit interaction.
 * @param {{ dimLayer: HTMLElement, stage: HTMLElement, onCommit: () => void }} refs
 */
export function init(refs) {
  _dimLayer = refs.dimLayer;
  _stage    = refs.stage;
  _onCommit = refs.onCommit;

  // Delegated click on .dim-layer catches all .dim-chip activations
  _dimLayer.addEventListener("click", _onLayerClick);

  // Keyboard (Enter/Space) on the layer — for a11y chip activation
  _dimLayer.addEventListener("keydown", _onLayerKeyDown);

  // Reposition open input on view changes (pan/zoom)
  onViewChange(_repositionInput);
}

/** Is an edit input currently open? */
export function isEditing() {
  return _editing !== null;
}

// ── Private: chip activation ──────────────────────────────────────────────────

function _onLayerClick(e) {
  const chip = /** @type {HTMLElement} */ (e.target.closest(".dim-chip"));
  if (!chip) return;
  _openEdit(chip);
}

function _onLayerKeyDown(e) {
  const chip = /** @type {HTMLElement} */ (e.target.closest(".dim-chip"));
  if (!chip) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    _openEdit(chip);
  }
}

// ── Private: open / close edit ────────────────────────────────────────────────

/**
 * Open the inline edit input positioned at the given chip's screen location.
 * @param {HTMLElement} chip
 */
function _openEdit(chip) {
  // Already editing — commit current and open new
  if (_editing) {
    _commitEdit();
  }

  const roomId    = chip.dataset.roomId;
  const edgeIndex = parseInt(chip.dataset.edgeIndex, 10);

  const room = findRoom(roomId);
  if (!room) return;

  // Get current edge length in metres
  const [a, b] = edgeEndpoints(room, edgeIndex);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenM = Math.sqrt(dx * dx + dy * dy);

  // Pre-fill with current length in the active unit, bare number
  const prefill = fmtLen(lenM);

  // Create the floating input
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.className = "dim-input";
  input.value = prefill;
  input.setAttribute("aria-label", "Edit wall length");

  // Position input at chip's screen position
  const chipRect = chip.getBoundingClientRect();
  const stageRect = _stage.getBoundingClientRect();
  input.style.left = (chipRect.left - stageRect.left + chipRect.width / 2) + "px";
  input.style.top  = (chipRect.top  - stageRect.top  + chipRect.height / 2) + "px";

  _stage.appendChild(input);
  input.select();
  input.focus();

  _editing = { roomId, edgeIndex, input };

  // Commit on blur
  input.addEventListener("blur", _onInputBlur);
  // Enter commits, Esc cancels
  input.addEventListener("keydown", _onInputKeyDown);
}

function _onInputKeyDown(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    _commitEdit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    _cancelEdit();
  }
}

function _onInputBlur() {
  // Only commit if still open (Esc may have already cancelled)
  if (_editing) {
    _commitEdit();
  }
}

function _commitEdit() {
  if (!_editing) return;
  const { roomId, edgeIndex, input } = _editing;
  _editing = null;   // clear first so blur re-entry is safe

  // Remove input from DOM
  if (input.parentNode) {
    input.removeEventListener("blur", _onInputBlur);
    input.removeEventListener("keydown", _onInputKeyDown);
    input.parentNode.removeChild(input);
  }

  const metres = parseLen(input.value);
  if (metres === null) return; // invalid or empty — no geometry change

  const room = findRoom(roomId);
  if (!room) return; // room was removed mid-edit

  const changed = setEdgeLength(room, edgeIndex, metres);
  if (changed && _onCommit) {
    _onCommit();
  }
}

function _cancelEdit() {
  if (!_editing) return;
  const { input } = _editing;
  _editing = null;

  if (input.parentNode) {
    input.removeEventListener("blur", _onInputBlur);
    input.removeEventListener("keydown", _onInputKeyDown);
    input.parentNode.removeChild(input);
  }
}

// ── Private: reposition input on view change ──────────────────────────────────

function _repositionInput() {
  if (!_editing) return;
  const { roomId, edgeIndex, input } = _editing;

  const room = findRoom(roomId);
  if (!room) {
    _cancelEdit();
    return;
  }

  const [a, b] = edgeEndpoints(room, edgeIndex);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const s = worldToScreen(mx, my);

  input.style.left = s.x + "px";
  input.style.top  = s.y + "px";
}
