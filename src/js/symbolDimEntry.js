/**
 * symbolDimEntry.js — inline width/depth editing for symbols
 *
 * Mirrors dimEntry.js. Owns a single floating <input class="dim-input sym-dim-input">
 * appended to .stage.
 *
 * Event delegation on dimLabels: a click on a .sym-dim-chip reads
 * data-symbol-id / data-sym-dim and calls beginEdit.
 *
 * Pointer isolation: binds pointerdown/pointerup/pointercancel listeners on
 * dimLabels and on the dim-input that call e.stopPropagation() when the
 * target is a .sym-dim-chip or .sym-dim-input. This prevents the stage
 * select/pan handler from firing (Edge Case 8).
 *
 * Symbol chips carry .sym-dim-chip class so this controller can locate only
 * its own chips within the shared .dim-labels layer (no collision with wall chips).
 */

import { fmtLen, parseLen, onChange as onUnitChange } from "./units.js";
import { model as symbolModel, getSymbol, resizeSymbol, CATALOG, corners } from "./symbols.js";
import { scheduleRender } from "./surface.js";
import { worldToScreen } from "./view.js";

// ── State ──────────────────────────────────────────────────────────────────────

/** @type {{ symbolId:string, dim:"w"|"h" }|null} */
let _editing = null;

/** @type {HTMLInputElement|null} */
let _input = null;

/** @type {Element|null} */
let _stage = null;

/** @type {Element|null} */
let _dimLabels = null;

// ── Init ───────────────────────────────────────────────────────────────────────

/**
 * @param {{ stage:Element, dimLabels:Element }} refs
 */
export function init(refs) {
  _stage = refs.stage;
  _dimLabels = refs.dimLabels;

  if (_input) {
    _input.style.display = "none";
    _input = null;
  }
  _editing = null;

  // Event delegation: click on any .sym-dim-chip inside dimLabels
  _dimLabels.addEventListener("click", (e) => {
    const chip = e.target.closest(".sym-dim-chip");
    if (!chip) return;
    const symbolId = chip.getAttribute("data-symbol-id");
    const dim = chip.getAttribute("data-sym-dim");
    if (symbolId && (dim === "w" || dim === "h")) {
      beginEdit(symbolId, dim);
    }
  });

  // Pointer isolation on dimLabels for sym-dim-chip targets
  _bindPointerIsolation(_dimLabels, ".sym-dim-chip");

  // Cancel open edit on unit change (Edge Case 7)
  onUnitChange(() => {
    if (isEditing()) cancel();
  });
}

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

// ── Public API ─────────────────────────────────────────────────────────────────

/** Whether an edit is currently open. */
export function isEditing() {
  return _editing !== null;
}

/** The currently-editing dim ref, or null. */
export function getEditingDim() {
  return _editing;
}

/**
 * Open the inline input over the dimension chip of (symbolId, dim).
 * @param {string} symbolId
 * @param {"w"|"h"} dim
 */
export function beginEdit(symbolId, dim) {
  if (_editing) cancel();

  const sym = getSymbol(symbolId);
  if (!sym) return;

  // Guard: openings only allow width
  if (CATALOG[sym.type]?.openings && dim === "h") return;

  _editing = { symbolId, dim };

  if (!_input) {
    _input = document.createElement("input");
    _input.className = "dim-input sym-dim-input";
    _input.setAttribute("inputmode", "decimal");
    _input.setAttribute("autocomplete", "off");
    _input.setAttribute("type", "text");
    _stage.appendChild(_input);

    _bindPointerIsolation(_input, ".sym-dim-input");
    _input.addEventListener("keydown", _onInputKeyDown);
    _input.addEventListener("blur", _onInputBlur);
  }

  const currentVal = dim === "w" ? sym.w : sym.h;
  _input.value = fmtLen(currentVal);
  _input.setAttribute("aria-label",
    `Symbol ${dim === "w" ? "width" : "depth"} — type a value and press Enter`
  );
  _input.removeAttribute("aria-invalid");
  _input.style.borderColor = "";

  _positionInput(sym, dim);
  _input.style.display = "block";
  _input.select();
  _input.focus();

  scheduleRender();
}

/**
 * Parse the input value → resizeSymbol → close → scheduleRender.
 * On invalid parse: flag error and stay open.
 */
export function commit() {
  if (!_editing || !_input) return;

  const sym = getSymbol(_editing.symbolId);
  if (!sym) { cancel(); return; }

  const valueStr = _input.value;
  const targetM = parseLen(valueStr);

  if (targetM === null) {
    _input.setAttribute("aria-invalid", "true");
    _input.style.borderColor = "var(--error, #e57373)";
    return;
  }

  // No-op if display value is identical (lossless round-trip)
  const currentVal = _editing.dim === "w" ? sym.w : sym.h;
  if (fmtLen(targetM) === fmtLen(currentVal)) {
    _closeInput();
    scheduleRender();
    return;
  }

  resizeSymbol(sym, _editing.dim, targetM, false);
  _closeInput();
  scheduleRender();
}

/** Discard and close without changing geometry. */
export function cancel() {
  if (!_editing) return;
  _closeInput();
  scheduleRender();
}

/**
 * Post-render hook: reposition the open input to track pan/zoom.
 * Also guards: if the symbol was removed, close silently (Edge Case 11).
 */
export function reposition() {
  if (!_editing || !_input || _input.style.display === "none") return;

  const sym = getSymbol(_editing.symbolId);
  if (!sym) { _closeInput(); return; }

  _positionInput(sym, _editing.dim);
}

// ── Private ────────────────────────────────────────────────────────────────────

/**
 * Position the input over the chip location for the given dim.
 * Width chip: centered on top edge. Depth chip: centered on left edge.
 */
function _positionInput(sym, dim) {
  if (!_input) return;

  const cs = corners(sym).map(c => worldToScreen(c.x, c.y));
  let cx, cy;

  if (dim === "w") {
    // Top edge midpoint
    cx = (cs[0].x + cs[1].x) / 2;
    cy = (cs[0].y + cs[1].y) / 2;
    // Offset outward
    const rad = (sym.rot * Math.PI) / 180;
    cx += Math.sin(rad) * 14;
    cy += -Math.cos(rad) * 14;
  } else {
    // Left edge midpoint (TL to BL = cs[0] to cs[3])
    cx = (cs[0].x + cs[3].x) / 2;
    cy = (cs[0].y + cs[3].y) / 2;
    // Offset outward (left direction in local frame)
    const rad = (sym.rot * Math.PI) / 180;
    cx += -Math.cos(rad) * 14;
    cy += -Math.sin(rad) * 14;
  }

  _input.style.left = cx + "px";
  _input.style.top  = cy + "px";
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
}

function _onInputBlur() {
  if (_editing) cancel();
}
