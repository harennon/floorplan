/**
 * measure.js — Measure inspector: live area + perimeter for closed rooms
 *
 * Docked panel (desktop: under the unit toggle, top-right).
 * Total Floor Area = Σ closed-room areas; per-room rows with hover-to-highlight.
 * Open polylines are excluded from the inspector but get dimension chips via
 * wallRender.
 *
 * LLD 82: adds a W×H explicit size editor for selected rectangular rooms.
 */

import { model, isRectangle, rectDims, rescaleRectEdge, MIN_SEG_M } from "./walls.js";
import { roomMetrics } from "./walls.js";
import { fmtLen, fmtArea, areaUnitLabel, unitLabel, parseLen } from "./units.js";
import { scheduleRender } from "./surface.js";

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {string|null} */
let _highlightRoomId = null;

/**
 * Last-rendered snapshot, used to dirty-check before rebuilding DOM rows.
 * Each element: { id, areaText, perimText, label }
 * @type {Array<{id:string, areaText:string, perimText:string, label:string}>}
 */
let _lastRows = [];

// ── Injected dependencies (LLD 82) ───────────────────────────────────────────

/** Injected from main.js: returns the currently selected room id, or null. */
let _getSelectedRoomId = null;

/** Injected from main.js: commits a history snapshot. */
let _historyCommit = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────

let _panel  = null;
let _list   = null;
let _total  = null;
let _toggle = null;

// W×H block elements (LLD 82)
let _wxhBox   = null;
let _wxhW     = null;
let _wxhH     = null;
let _wxhUnit  = null;
let _wxhApply = null;

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * @param {{ panel:Element, list:Element, total:Element, toggle:Element,
 *           wxhBox?:Element, wxhW?:Element, wxhH?:Element,
 *           wxhUnit?:Element, wxhApply?:Element }} refs
 */
export function init(refs) {
  _panel  = refs.panel;
  _list   = refs.list;
  _total  = refs.total;
  _toggle = refs.toggle;

  // W×H block refs (LLD 82) — optional so existing tests without them still work
  _wxhBox   = refs.wxhBox   ?? null;
  _wxhW     = refs.wxhW     ?? null;
  _wxhH     = refs.wxhH     ?? null;
  _wxhUnit  = refs.wxhUnit  ?? null;
  _wxhApply = refs.wxhApply ?? null;

  // Reset dirty-check snapshot for new DOM context (supports multiple test rigs).
  _lastRows = [];
  _highlightRoomId = null;

  // Collapse/expand toggle
  _toggle.addEventListener("click", () => {
    const willCollapse = !_panel.classList.contains("measure--collapsed");
    _panel.classList.toggle("measure--collapsed");
    _toggle.setAttribute("aria-expanded", willCollapse ? "false" : "true");
    _toggle.textContent = willCollapse ? "▸" : "▾";
  });

  // Hover/focus delegation on room list rows
  _list.addEventListener("mouseenter", _onRowEnter, true);
  _list.addEventListener("mouseleave", _onRowLeave, true);
  _list.addEventListener("focusin",  _onRowEnter, true);
  _list.addEventListener("focusout", _onRowLeave, true);

  // Wire W×H block interactions (LLD 82)
  if (_wxhApply) {
    _wxhApply.addEventListener("click", _applyWxH);
  }
  if (_wxhW) {
    _wxhW.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); _applyWxH(); }
      if (e.key === "Escape") { e.preventDefault(); _cancelWxH(); }
    });
    _wxhW.addEventListener("blur", _onWxHBlur);
  }
  if (_wxhH) {
    _wxhH.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); _applyWxH(); }
      if (e.key === "Escape") { e.preventDefault(); _cancelWxH(); }
    });
    _wxhH.addEventListener("blur", _onWxHBlur);
  }
}

// ── Injectors (LLD 82) ───────────────────────────────────────────────────────

/**
 * Inject the getSelectedRoomId accessor. Called from main.js.
 * @param {()=>string|null} fn
 */
export function setSelectedRoomAccessor(fn) {
  _getSelectedRoomId = fn;
}

/**
 * Inject history.commit. Called from main.js.
 * @param {()=>void} fn
 */
export function setHistoryCommit(fn) {
  _historyCommit = fn;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Recompute from model.rooms and update the inspector DOM.
 * Registered via surface.onRender so it runs each frame.
 *
 * LLD 82: _refreshWxh() is called UNCONDITIONALLY near the top, before the
 * dirty-check early return, so selection changes, unit toggles, and hover
 * events (which all take the early-return path) still show/hide the block.
 *
 * Uses a dirty-check: existing row DOM nodes are updated in place when the
 * room set and values are unchanged, so keyboard focus on a row is preserved
 * across render frames (e.g. when hover triggers scheduleRender). Rows are
 * only torn down and rebuilt when the room list structure changes.
 */
export function update() {
  if (!_panel) return;

  // LLD 82: refresh W×H block BEFORE the dirty-check early return.
  // This must run on every invocation — selection change, unit toggle, hover,
  // and drag all leave model.rooms structurally unchanged and hit the early
  // return below; if _refreshWxh() were placed after that return it would
  // never fire for those events.
  _refreshWxh();

  const closedRooms = model.rooms.filter(r => r.closed);

  // Total floor area (sum of closed rooms)
  let totalArea = 0;
  for (const room of closedRooms) {
    const m = roomMetrics(room);
    totalArea += m.area;
  }

  // Update total display
  _total.textContent = fmtArea(totalArea) + " " + areaUnitLabel();

  // Build the new row descriptors
  /** @type {Array<{id:string, areaText:string, perimText:string, label:string}>} */
  const newRows = closedRooms.map((room, idx) => {
    const m = roomMetrics(room);
    return {
      id:       room.id,
      label:    "Room " + (idx + 1),
      areaText: fmtArea(m.area) + " " + areaUnitLabel(),
      perimText: fmtLen(m.perimeter) + " " + unitLabel(),
    };
  });

  // Dirty-check: if the row structure and all text values match, update
  // textContent in place so existing DOM nodes (and any keyboard focus) are
  // preserved.  Only tear down when structure actually changes.
  const structureUnchanged =
    newRows.length === _lastRows.length &&
    newRows.every((r, i) => r.id === _lastRows[i].id);

  if (structureUnchanged && newRows.length > 0) {
    // Update text content in place.
    const rowEls = _list.querySelectorAll(".measure-row");
    newRows.forEach((r, i) => {
      const row = rowEls[i];
      if (!row) return;
      row.querySelector(".measure-row-label").textContent  = r.label;
      row.querySelector(".measure-row-area").textContent   = r.areaText;
      row.querySelector(".measure-row-perim").textContent  = r.perimText;
    });
    _lastRows = newRows;
    return;
  }

  // Structure changed — rebuild from scratch.
  while (_list.firstChild) _list.removeChild(_list.firstChild);
  _lastRows = [];

  if (newRows.length === 0) {
    const hint = document.createElement("div");
    hint.className = "measure-empty";
    hint.textContent = "Draw a closed room to see its area";
    _list.appendChild(hint);
    return;
  }

  for (const r of newRows) {
    const row = document.createElement("div");
    row.className = "measure-row";
    row.setAttribute("data-room-id", r.id);
    row.setAttribute("tabindex", "0");
    row.setAttribute("role", "row");

    const labelEl = document.createElement("span");
    labelEl.className = "measure-row-label";
    labelEl.setAttribute("role", "cell");
    labelEl.textContent = r.label;

    const areaEl = document.createElement("span");
    areaEl.className = "measure-row-area";
    areaEl.setAttribute("role", "cell");
    areaEl.textContent = r.areaText;

    const perimEl = document.createElement("span");
    perimEl.className = "measure-row-perim";
    perimEl.setAttribute("role", "cell");
    perimEl.textContent = r.perimText;

    row.appendChild(labelEl);
    row.appendChild(areaEl);
    row.appendChild(perimEl);
    _list.appendChild(row);
  }

  _lastRows = newRows;
}

/** The room currently highlighted by hover/focus, or null. */
export function getHighlightRoomId() {
  return _highlightRoomId;
}

// ── W×H private helpers (LLD 82) ─────────────────────────────────────────────

/**
 * Resolve the currently selected rectangular room, or null.
 * Returns null when: no accessor injected, no selection, room not found,
 * room not a rectangle.
 * @returns {import("./walls.js").Room|null}
 */
function _getSelectedRect() {
  if (!_getSelectedRoomId) return null;
  const id = _getSelectedRoomId();
  if (!id) return null;
  const room = model.rooms.find(r => r.id === id);
  if (!room) return null;
  if (!isRectangle(room)) return null;
  return room;
}

/**
 * Show + prefill the W×H block for the currently selected rectangular room,
 * or hide it if no rectangular room is selected.
 *
 * Called unconditionally near the top of update() — before the dirty-check
 * early return — so it fires for every event that changes selection or units.
 *
 * A focused field is NOT re-prefilled (guard via document.activeElement) so
 * mid-typing is not clobbered by frequent re-renders.
 */
function _refreshWxh() {
  if (!_wxhBox) return;

  const room = _getSelectedRect();
  if (!room) {
    _wxhBox.hidden = true;
    return;
  }

  const dims = rectDims(room);
  if (!dims) {
    _wxhBox.hidden = true;
    return;
  }

  _wxhBox.hidden = false;

  // Update unit label
  if (_wxhUnit) {
    _wxhUnit.textContent = unitLabel();
  }

  // Prefill fields — skip a field the user currently has focused
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (_wxhW && _wxhW !== active) {
    _wxhW.value = fmtLen(dims.w);
    _wxhW.removeAttribute("aria-invalid");
  }
  if (_wxhH && _wxhH !== active) {
    _wxhH.value = fmtLen(dims.h);
    _wxhH.removeAttribute("aria-invalid");
  }
}

/**
 * Apply the typed W×H values to the selected rectangular room.
 * - Parses both fields via parseLen; flags invalid on null or < MIN_SEG_M.
 * - Captures dims0 BEFORE any mutation so the no-op guard reads pre-mutation values.
 * - Skips an axis when fmtLen(typed) === fmtLen(current) (display-precision no-op).
 * - One history.commit() if anything changed.
 * - Calls scheduleRender() so the canvas, chips, and fields refresh.
 */
function _applyWxH() {
  if (!_wxhW || !_wxhH) return;
  const room = _getSelectedRect();
  if (!room) return;

  // Capture pre-mutation dims snapshot
  const dims0 = rectDims(room);
  if (!dims0) return;

  // Parse both fields
  const wStr = _wxhW.value;
  const hStr = _wxhH.value;
  const wM = parseLen(wStr);
  const hM = parseLen(hStr);

  // Validate — flag invalid fields and abort if either fails
  let valid = true;
  if (wM === null || wM < MIN_SEG_M) {
    _wxhW.setAttribute("aria-invalid", "true");
    valid = false;
  } else {
    _wxhW.removeAttribute("aria-invalid");
  }
  if (hM === null || hM < MIN_SEG_M) {
    _wxhH.setAttribute("aria-invalid", "true");
    valid = false;
  } else {
    _wxhH.removeAttribute("aria-invalid");
  }
  if (!valid) return;

  // Apply each axis if it changed at display precision (using pre-mutation dims0)
  let changed = false;

  const wNoOp = fmtLen(wM) === fmtLen(dims0.w);
  if (!wNoOp) {
    const ok = rescaleRectEdge(room, dims0.wEdge, wM);
    if (ok) changed = true;
    else {
      // rescaleRectEdge rejected (e.g. very tiny value that passed parseLen)
      _wxhW.setAttribute("aria-invalid", "true");
    }
  }

  const hNoOp = fmtLen(hM) === fmtLen(dims0.h);
  if (!hNoOp) {
    const ok = rescaleRectEdge(room, dims0.hEdge, hM);
    if (ok) changed = true;
    else {
      _wxhH.setAttribute("aria-invalid", "true");
    }
  }

  if (changed) {
    if (_historyCommit) _historyCommit();
    scheduleRender();
  }
}

/**
 * Cancel: re-prefill fields from geometry (discard typed-but-not-applied values).
 */
function _cancelWxH() {
  const room = _getSelectedRect();
  if (!room || !_wxhW || !_wxhH) return;
  const dims = rectDims(room);
  if (!dims) return;
  _wxhW.value = fmtLen(dims.w);
  _wxhW.removeAttribute("aria-invalid");
  _wxhH.value = fmtLen(dims.h);
  _wxhH.removeAttribute("aria-invalid");
}

/**
 * Blur handler: re-prefill the blurred field (discard typed-but-not-applied value).
 * Uses a small timeout so Enter-key → apply → blur doesn't double-cancel.
 */
function _onWxHBlur(e) {
  // Small delay: let a click on Apply fire first before we restore
  const field = e.target;
  setTimeout(() => {
    const room = _getSelectedRect();
    if (!room) return;
    const dims = rectDims(room);
    if (!dims) return;
    if (field === _wxhW) {
      _wxhW.value = fmtLen(dims.w);
      _wxhW.removeAttribute("aria-invalid");
    } else if (field === _wxhH) {
      _wxhH.value = fmtLen(dims.h);
      _wxhH.removeAttribute("aria-invalid");
    }
  }, 150);
}

// ── Private ───────────────────────────────────────────────────────────────────

function _onRowEnter(e) {
  const row = e.target.closest(".measure-row");
  if (!row) return;
  const id = row.getAttribute("data-room-id");
  if (id && id !== _highlightRoomId) {
    _highlightRoomId = id;
    scheduleRender();
  }
}

function _onRowLeave(e) {
  const row = e.target.closest(".measure-row");
  if (!row) return;
  // Only clear if not entering another row (relatedTarget check)
  const related = e.relatedTarget;
  if (related && row.contains(related)) return;
  if (_highlightRoomId !== null) {
    _highlightRoomId = null;
    scheduleRender();
  }
}
