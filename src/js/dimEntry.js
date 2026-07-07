/**
 * dimEntry.js — inline numeric dimension-entry controller
 *
 * Owns a single floating <input class="dim-input"> appended to .stage.
 * Uses event delegation on dimLabels: a click on a .dim-chip reads
 * data-room-id / data-edge and calls beginEdit.
 *
 * Pointer isolation: binds pointerdown/pointerup/pointercancel listeners on
 * dimLabels and on the dim-input that call e.stopPropagation() when the
 * target is a .dim-chip or .dim-input. This prevents the draw handler on
 * .stage from firing (Edge Case 12).
 */

import { fmtLen, parseLen, onChange as onUnitChange } from "./units.js";
import { model, edgeLength, rescaleEdge, MIN_SEG_M } from "./walls.js";
import { scheduleRender } from "./surface.js";
import { worldToScreen } from "./view.js";

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {{ roomId:string, edgeIndex:number }|null} */
let _editing = null;

/** @type {HTMLInputElement|null} */
let _input = null;

/** @type {Element|null} */
let _stage = null;

/** @type {Element|null} */
let _dimLabels = null;

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * @param {{ stage:Element, dimLabels:Element }} refs
 */
export function init(refs) {
  _stage = refs.stage;
  _dimLabels = refs.dimLabels;

  // Event delegation: click on any .dim-chip inside dimLabels
  _dimLabels.addEventListener("click", (e) => {
    const chip = e.target.closest(".dim-chip");
    if (!chip) return;
    const roomId = chip.getAttribute("data-room-id");
    const edgeIndex = parseInt(chip.getAttribute("data-edge"), 10);
    beginEdit(roomId, edgeIndex);
  });

  // Pointer isolation on dimLabels (prevents bubbling to .stage's draw handler)
  _bindPointerIsolation(_dimLabels, ".dim-chip");

  // Cancel open edit on unit change (Edge Case 6)
  onUnitChange(() => {
    if (isEditing()) cancel();
  });
}

/**
 * Bind stopPropagation on pointer events for matching targets within element.
 * @param {Element} el
 * @param {string} selector
 */
function _bindPointerIsolation(el, selector) {
  const handler = (e) => {
    if (e.target.closest(selector)) {
      e.stopPropagation();
    }
  };
  el.addEventListener("pointerdown",  handler);
  el.addEventListener("pointerup",    handler);
  el.addEventListener("pointercancel", handler);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Whether an edit is currently open. */
export function isEditing() {
  return _editing !== null;
}

/** The currently-editing edge ref, or null. */
export function getEditingEdge() {
  return _editing;
}

/**
 * Open the inline input over edge (roomId, edgeIndex).
 * @param {string} roomId
 * @param {number} edgeIndex
 */
export function beginEdit(roomId, edgeIndex) {
  // Cancel any existing edit first
  if (_editing) cancel();

  const room = model.rooms.find(r => r.id === roomId);
  if (!room) return;
  const n = room.verts.length;
  const maxIndex = room.closed ? n - 1 : n - 2;
  if (edgeIndex < 0 || edgeIndex > maxIndex) return;

  _editing = { roomId, edgeIndex };

  // Lazily create the input element
  if (!_input) {
    _input = document.createElement("input");
    _input.className = "dim-input";
    _input.setAttribute("inputmode", "decimal");
    _input.setAttribute("autocomplete", "off");
    _input.setAttribute("aria-label", "Wall length — type a value and press Enter");
    _input.setAttribute("type", "text");
    _stage.appendChild(_input);

    // Pointer isolation on the input itself
    _bindPointerIsolation(_input, ".dim-input");

    _input.addEventListener("keydown", _onInputKeyDown);
    _input.addEventListener("blur", _onInputBlur);
  }

  // Prefill with current edge length in active unit
  const iA = edgeIndex;
  const iB = room.closed ? (edgeIndex + 1) % n : edgeIndex + 1;
  const len = edgeLength(room.verts[iA], room.verts[iB]);
  _input.value = fmtLen(len);
  _input.removeAttribute("aria-invalid");
  _input.style.borderColor = "";

  // Position and show
  _positionInput(room, edgeIndex);
  _input.style.display = "block";
  _input.select();
  _input.focus();

  // Trigger a render so the chip for this edge is skipped
  scheduleRender();
}

/**
 * Parse the input value → rescaleEdge → close → scheduleRender.
 * On invalid parse: flags error and stays open.
 */
export function commit() {
  if (!_editing || !_input) return;

  const valueStr = _input.value;
  const targetM = parseLen(valueStr);

  if (targetM === null) {
    // Invalid input: flag error, stay open
    _input.setAttribute("aria-invalid", "true");
    _input.style.borderColor = "var(--error, #e57373)";
    return;
  }

  const room = model.rooms.find(r => r.id === _editing.roomId);
  if (!room) { cancel(); return; }

  // No-op if the value is within display precision (lossless round-trip, Edge Case 3)
  const n = room.verts.length;
  const iA = _editing.edgeIndex;
  const iB = room.closed ? (iA + 1) % n : iA + 1;
  const currentLen = edgeLength(room.verts[iA], room.verts[iB]);
  const epsilon = MIN_SEG_M;

  if (Math.abs(targetM - currentLen) < epsilon) {
    // No meaningful change — just close the editor
    _closeInput();
    scheduleRender();
    return;
  }

  const ok = rescaleEdge(room, _editing.edgeIndex, targetM);
  if (!ok) {
    // Too-small target or degenerate edge
    _input.setAttribute("aria-invalid", "true");
    _input.style.borderColor = "var(--error, #e57373)";
    return;
  }

  _closeInput();
  scheduleRender();
}

/** Discard and close the input without changing geometry. */
export function cancel() {
  if (!_editing) return;
  _closeInput();
  scheduleRender();
}

/**
 * Post-render hook: reposition the open input to the current screen midpoint
 * of the edited edge so it tracks pan/zoom.
 */
export function reposition() {
  if (!_editing || !_input || _input.style.display === "none") return;

  const room = model.rooms.find(r => r.id === _editing.roomId);
  if (!room) return;

  _positionInput(room, _editing.edgeIndex);
}

// ── Private ───────────────────────────────────────────────────────────────────

function _positionInput(room, edgeIndex) {
  if (!_input) return;
  const n = room.verts.length;
  const iA = edgeIndex;
  const iB = room.closed ? (edgeIndex + 1) % n : edgeIndex + 1;
  const a = room.verts[iA];
  const b = room.verts[iB];
  const pa = worldToScreen(a.x, a.y);
  const pb = worldToScreen(b.x, b.y);
  const mx = (pa.x + pb.x) / 2;
  const my = (pa.y + pb.y) / 2;
  _input.style.left = mx + "px";
  _input.style.top  = my + "px";
}

function _closeInput() {
  _editing = null;
  if (_input) {
    _input.style.display = "none";
    _input.removeAttribute("aria-invalid");
    _input.style.borderColor = "";
  }
}

function _onInputKeyDown(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    commit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancel();
  }
  // All other keys (Backspace, letters, etc.) edit text — no geometry change.
}

function _onInputBlur() {
  // Blur = cancel (discard uncommitted edit)
  if (_editing) cancel();
}
