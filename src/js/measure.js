/**
 * measure.js — Measure inspector: live area + perimeter for closed rooms
 *
 * Docked panel (desktop: under the unit toggle, top-right).
 * Total Floor Area = Σ closed-room areas; per-room rows with hover-to-highlight.
 * Open polylines are excluded from the inspector but get dimension chips via
 * wallRender.
 */

import { model } from "./walls.js";
import { roomMetrics } from "./walls.js";
import { fmtLen, fmtArea, areaUnitLabel, unitLabel } from "./units.js";
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

// ── DOM refs ──────────────────────────────────────────────────────────────────

let _panel  = null;
let _list   = null;
let _total  = null;
let _toggle = null;

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * @param {{ panel:Element, list:Element, total:Element, toggle:Element }} refs
 */
export function init(refs) {
  _panel  = refs.panel;
  _list   = refs.list;
  _total  = refs.total;
  _toggle = refs.toggle;

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
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Recompute from model.rooms and update the inspector DOM.
 * Registered via surface.onRender so it runs each frame.
 *
 * Uses a dirty-check: existing row DOM nodes are updated in place when the
 * room set and values are unchanged, so keyboard focus on a row is preserved
 * across render frames (e.g. when hover triggers scheduleRender). Rows are
 * only torn down and rebuilt when the room list structure changes.
 */
export function update() {
  if (!_panel) return;

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
    labelEl.textContent = r.label;

    const areaEl = document.createElement("span");
    areaEl.className = "measure-row-area";
    areaEl.textContent = r.areaText;

    const perimEl = document.createElement("span");
    perimEl.className = "measure-row-perim";
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
