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

  // Rebuild the room list
  while (_list.firstChild) _list.removeChild(_list.firstChild);

  if (closedRooms.length === 0) {
    const hint = document.createElement("div");
    hint.className = "measure-empty";
    hint.textContent = "Draw a closed room to see its area";
    _list.appendChild(hint);
    return;
  }

  for (let idx = 0; idx < closedRooms.length; idx++) {
    const room = closedRooms[idx];
    const m = roomMetrics(room);
    const row = document.createElement("div");
    row.className = "measure-row";
    row.setAttribute("data-room-id", room.id);
    row.setAttribute("tabindex", "0");
    row.setAttribute("role", "row");

    const label = document.createElement("span");
    label.className = "measure-row-label";
    label.textContent = "Room " + (idx + 1);

    const areaEl = document.createElement("span");
    areaEl.className = "measure-row-area";
    areaEl.textContent = fmtArea(m.area) + " " + areaUnitLabel();

    const perimEl = document.createElement("span");
    perimEl.className = "measure-row-perim";
    perimEl.textContent = fmtLen(m.perimeter) + " " + unitLabel();

    row.appendChild(label);
    row.appendChild(areaEl);
    row.appendChild(perimEl);
    _list.appendChild(row);
  }
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
