/**
 * measureRender.js — SVG + chip rendering for committed measurements and rubber-band
 * preview (LLD 93).
 *
 * Registered as a surface.onRender hook (AFTER wallRender runs, per the
 * .dim-labels ordering contract). Draws into the dedicated #measures SVG group
 * and appends distance chips to the shared .dim-labels overlay.
 *
 * Chips use the .measure-chip class (NOT .dim-chip) so dimEntry's delegated
 * click listener never swallows pointer events on them. pointer-events:none is
 * also set in CSS so they never intercept placement/selection taps.
 *
 * Nothing in this module fires events or handles input.
 */

import { worldToScreen, pxPerM } from "./view.js";
import { model } from "./measurements.js";
import { fmtLen, unitLabel } from "./units.js";
import { palette } from "./theme.js";

const NS = "http://www.w3.org/2000/svg";

/** Screen-px length of the end tick marks. */
const TICK_LEN = 6;
/** Perpendicular offset for the distance label (screen px). */
const LABEL_OFFSET = 14;

// ── DOM refs ───────────────────────────────────────────────────────────────────

let _gMeasures  = null;
let _dimLabels  = null;

// ── Injected getters ────────────────────────────────────────────────────────────

let _getSelectedId = () => null;
let _getDraft      = () => null;

// ── Init ───────────────────────────────────────────────────────────────────────

/**
 * @param {SVGGElement} gMeasures  the #measures SVG group
 * @param {HTMLElement} dimLabels  the .dim-labels container
 * @param {()=>string|null} getSelectedId
 * @param {()=>{ a:{x,y}, cursor:{x,y}, snapType }|null} getDraft
 */
export function init(gMeasures, dimLabels, getSelectedId, getDraft) {
  _gMeasures     = gMeasures;
  _dimLabels     = dimLabels;
  _getSelectedId = getSelectedId || (() => null);
  _getDraft      = getDraft      || (() => null);
}

// ── Main render ────────────────────────────────────────────────────────────────

/**
 * Full idempotent redraw of all committed measurements + rubber-band preview.
 * Called as a surface.onRender hook; MUST run after wallRender.
 */
export function render() {
  if (!_gMeasures) return;

  _clearGroup(_gMeasures);
  // Remove previously appended measure chips (keep wall/symbol chips)
  if (_dimLabels) {
    const existing = _dimLabels.querySelectorAll(".measure-chip");
    for (const el of existing) el.remove();
  }

  const p = palette();
  const selectedId = _getSelectedId();
  const draft = _getDraft();

  // Draw committed measurements
  for (const m of model.measurements) {
    const selected = m.id === selectedId;
    _drawMeasurement(m.a, m.b, selected, p, m.id);
  }

  // Draw rubber-band preview (in-progress draft)
  if (draft !== null) {
    _drawPreview(draft, p);
  }
}

// ── Drawing helpers ────────────────────────────────────────────────────────────

/**
 * Draw a committed measurement line with end ticks, selection handles,
 * and a distance label chip.
 */
function _drawMeasurement(worldA, worldB, selected, p, id) {
  const sA = worldToScreen(worldA.x, worldA.y);
  const sB = worldToScreen(worldB.x, worldB.y);

  const dx = sB.x - sA.x;
  const dy = sB.y - sA.y;
  const len = Math.sqrt(dx * dx + dy * dy);

  const color    = selected ? p.gold : p.dim;
  const strokeW  = selected ? 2.5 : 1.5;

  // Main line
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", sA.x);
  line.setAttribute("y1", sA.y);
  line.setAttribute("x2", sB.x);
  line.setAttribute("y2", sB.y);
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", strokeW);
  line.setAttribute("stroke-linecap", "round");
  _gMeasures.appendChild(line);

  // End ticks (perpendicular serifs at A and B)
  if (len > 0) {
    const nx = -dy / len;
    const ny =  dx / len;
    _drawTick(sA.x, sA.y, nx, ny, TICK_LEN, color, strokeW);
    _drawTick(sB.x, sB.y, nx, ny, TICK_LEN, color, strokeW);
  }

  // Selection handles (small squares at A and B)
  if (selected) {
    _drawHandle(sA.x, sA.y, p.gold);
    _drawHandle(sB.x, sB.y, p.gold);
  }

  // Distance label chip
  const midX = (sA.x + sB.x) / 2;
  const midY = (sA.y + sB.y) / 2;
  _appendDistChip(midX, midY, dx, dy, len, worldA, worldB, false);
}

/**
 * Draw the rubber-band preview (dashed line from A to cursor + live label).
 */
function _drawPreview(draft, p) {
  const sA = worldToScreen(draft.a.x, draft.a.y);
  const sC = worldToScreen(draft.cursor.x, draft.cursor.y);

  const dx = sC.x - sA.x;
  const dy = sC.y - sA.y;
  const len = Math.sqrt(dx * dx + dy * dy);

  // Dashed preview line
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", sA.x);
  line.setAttribute("y1", sA.y);
  line.setAttribute("x2", sC.x);
  line.setAttribute("y2", sC.y);
  line.setAttribute("stroke", p.dim);
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-dasharray", "5 3");
  line.setAttribute("opacity", "0.7");
  _gMeasures.appendChild(line);

  // A anchor dot
  _drawSnapDot(sA.x, sA.y, "vertex", p);

  // Cursor snap dot
  _drawSnapDot(sC.x, sC.y, draft.snapType, p);

  // Live distance label
  if (len > 1) {
    const midX = (sA.x + sC.x) / 2;
    const midY = (sA.y + sC.y) / 2;
    _appendDistChip(midX, midY, dx, dy, len, draft.a, draft.cursor, true);
  }
}

function _drawTick(cx, cy, nx, ny, halfLen, color, sw) {
  const tick = document.createElementNS(NS, "line");
  tick.setAttribute("x1", cx + nx * halfLen);
  tick.setAttribute("y1", cy + ny * halfLen);
  tick.setAttribute("x2", cx - nx * halfLen);
  tick.setAttribute("y2", cy - ny * halfLen);
  tick.setAttribute("stroke", color);
  tick.setAttribute("stroke-width", sw);
  tick.setAttribute("stroke-linecap", "round");
  _gMeasures.appendChild(tick);
}

function _drawHandle(cx, cy, color) {
  const HALF = 4;
  const rect = document.createElementNS(NS, "rect");
  rect.setAttribute("x", cx - HALF);
  rect.setAttribute("y", cy - HALF);
  rect.setAttribute("width",  HALF * 2);
  rect.setAttribute("height", HALF * 2);
  rect.setAttribute("fill", color);
  rect.setAttribute("stroke", "none");
  _gMeasures.appendChild(rect);
}

function _drawSnapDot(cx, cy, snapType, p) {
  let color;
  switch (snapType) {
    case "vertex":  color = p.snapPoint;   break;
    case "corner":  color = p.snapPoint;   break;
    case "center":  color = p.alignCenter; break;
    case "grid":    color = p.snapGrid;    break;
    default:        color = p.muted;       break;
  }
  const circle = document.createElementNS(NS, "circle");
  circle.setAttribute("cx", cx);
  circle.setAttribute("cy", cy);
  circle.setAttribute("r", "4");
  circle.setAttribute("fill", color);
  circle.setAttribute("stroke", "none");
  _gMeasures.appendChild(circle);
}

/**
 * Append a .measure-chip HTML element to .dim-labels at the midpoint,
 * offset perpendicularly so it doesn't overlap the line.
 */
function _appendDistChip(midX, midY, dx, dy, len, worldA, worldB, isDraft) {
  if (!_dimLabels) return;

  const distM = Math.sqrt(
    (worldB.x - worldA.x) ** 2 + (worldB.y - worldA.y) ** 2
  );
  const text = `${fmtLen(distM)} ${unitLabel()}`;

  // Perpendicular offset direction
  let offX = 0, offY = -LABEL_OFFSET;
  if (len > 0) {
    // Normal perpendicular to the line, pointing "up" in screen space
    const nx = -dy / len;
    const ny =  dx / len;
    // If normal points down (ny > 0), flip so chip is consistently above/beside
    const flip = ny > 0 ? -1 : 1;
    offX = nx * flip * LABEL_OFFSET;
    offY = ny * flip * LABEL_OFFSET;
  }

  const chip = document.createElement("div");
  chip.className = "measure-chip" + (isDraft ? " measure-chip--draft" : "");
  chip.textContent = text;
  chip.style.left = (midX + offX) + "px";
  chip.style.top  = (midY + offY) + "px";
  _dimLabels.appendChild(chip);
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function _clearGroup(g) {
  while (g.firstChild) g.removeChild(g.firstChild);
}
