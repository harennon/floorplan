/**
 * measureRender.js — SVG + HTML-overlay renderer for distance annotations (LLD 92)
 *
 * Registered as a surface.onRender hook AFTER clearanceRenderFn and before the
 * selection overlays so measurement lines sit below #symbol-overlay.
 *
 * Canvas annotations live in:
 *   - SVG group #measure  (lines, ticks, endpoint nodes)
 *   - .dim-labels container (.measure-chip HTML pills)
 *
 * This module only appends its own nodes (class-tagged .measure-chip) and
 * removes only those — it does NOT clear wall, symbol, or clearance chips.
 *
 * Colors: palette().snapTeal / --snap-teal (teal, distinct from wall gold/clearance red).
 * Selected measurement: thicker stroke.
 */

import { worldToScreen } from "./view.js";
import { fmtLen, unitLabel } from "./units.js";
import { palette } from "./theme.js";
import { length } from "./measurements.js";

const NS = "http://www.w3.org/2000/svg";

// Stroke widths
const STROKE_NORMAL   = 1.75;
const STROKE_SELECTED = 2.5;
const TICK_HALF = 4; // px half-length for perpendicular end-ticks
const NODE_R    = 3; // px radius of endpoint node dots

// ── DOM refs ──────────────────────────────────────────────────────────────────

let _gMeasure      = null;
let _overlayEl     = null;
let _getMeasurements = () => [];
let _getDraft        = () => null;
let _getSelectedId   = () => null;

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * @param {SVGGElement} gMeasure       #measure SVG group
 * @param {HTMLElement} overlayEl      .dim-labels HTML container
 * @param {()=>import("./measurements.js").Measurement[]} getMeasurements
 * @param {()=>({a:{x:number,y:number},b:{x:number,y:number},snapType:string}|null)} getDraft
 * @param {()=>string|null} getSelectedId
 */
export function init(gMeasure, overlayEl, getMeasurements, getDraft, getSelectedId) {
  _gMeasure        = gMeasure;
  _overlayEl       = overlayEl;
  _getMeasurements = getMeasurements || (() => []);
  _getDraft        = getDraft        || (() => null);
  _getSelectedId   = getSelectedId   || (() => null);
}

// ── Main render hook ───────────────────────────────────────────────────────────

/**
 * Full idempotent redraw: clears #measure SVG group and any .measure-chip nodes
 * in .dim-labels, then redraws from current state.
 * Called as a surface.onRender hook.
 */
export function render() {
  if (!_gMeasure || !_overlayEl) return;

  // Clear our SVG group
  _clearGroup(_gMeasure);

  // Clear ONLY our overlay nodes
  const old = _overlayEl.querySelectorAll(".measure-chip");
  for (const el of old) el.remove();

  const color = palette().snapTeal;
  const selectedId = _getSelectedId();

  // Draw committed measurements
  for (const m of _getMeasurements()) {
    const isSelected = m.id === selectedId;
    const strokeW = isSelected ? STROKE_SELECTED : STROKE_NORMAL;
    _drawMeasurement(_gMeasure, m.a, m.b, color, strokeW, isSelected, false);
    _appendChip(m.a, m.b, false);
  }

  // Draw in-progress draft
  const draft = _getDraft();
  if (draft) {
    _drawMeasurement(_gMeasure, draft.a, draft.b, color, STROKE_NORMAL, false, true);
    _appendChip(draft.a, draft.b, true);
  }
}

// ── Private: SVG drawing ───────────────────────────────────────────────────────

/**
 * Draw one measurement annotation: line, end-ticks, endpoint nodes.
 * @param {SVGGElement} parent
 * @param {{x:number,y:number}} wa  world endpoint A
 * @param {{x:number,y:number}} wb  world endpoint B
 * @param {string} color
 * @param {number} strokeW
 * @param {boolean} isSelected
 * @param {boolean} isDraft
 */
function _drawMeasurement(parent, wa, wb, color, strokeW, isSelected, isDraft) {
  const sa = worldToScreen(wa.x, wa.y);
  const sb = worldToScreen(wb.x, wb.y);

  // Main line
  const line = _makeLine(sa.x, sa.y, sb.x, sb.y);
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", String(strokeW));
  line.setAttribute("stroke-linecap", "round");
  if (isDraft) {
    line.setAttribute("stroke-dasharray", "5,4");
    line.setAttribute("opacity", "0.75");
  } else {
    line.setAttribute("opacity", isSelected ? "1" : "0.85");
  }
  if (isSelected) {
    // Subtle halo: a wider, very transparent duplicate underneath
    const halo = _makeLine(sa.x, sa.y, sb.x, sb.y);
    halo.setAttribute("stroke", color);
    halo.setAttribute("stroke-width", String(strokeW + 4));
    halo.setAttribute("stroke-linecap", "round");
    halo.setAttribute("opacity", "0.18");
    parent.appendChild(halo);
  }
  parent.appendChild(line);

  // Perpendicular end-ticks
  _drawTick(parent, sa, sb, color, strokeW);
  _drawTick(parent, sb, sa, color, strokeW);

  // Endpoint node dots
  _drawNode(parent, sa, color);
  _drawNode(parent, sb, color);
}

/**
 * Draw a perpendicular end-tick at `at`, perpendicular to the direction toward `toward`.
 */
function _drawTick(parent, at, toward, color, strokeW) {
  const dx = toward.x - at.x;
  const dy = toward.y - at.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;
  const px = -dy / len;
  const py =  dx / len;

  const tick = _makeLine(
    at.x - px * TICK_HALF, at.y - py * TICK_HALF,
    at.x + px * TICK_HALF, at.y + py * TICK_HALF,
  );
  tick.setAttribute("stroke", color);
  tick.setAttribute("stroke-width", String(strokeW));
  tick.setAttribute("stroke-linecap", "round");
  parent.appendChild(tick);
}

/**
 * Draw a small endpoint node dot.
 */
function _drawNode(parent, s, color) {
  const circle = document.createElementNS(NS, "circle");
  circle.setAttribute("cx", String(s.x));
  circle.setAttribute("cy", String(s.y));
  circle.setAttribute("r",  String(NODE_R));
  circle.setAttribute("fill", color);
  circle.setAttribute("opacity", "0.9");
  parent.appendChild(circle);
}

// ── Private: HTML overlay ──────────────────────────────────────────────────────

/**
 * Append a distance chip at the line midpoint to .dim-labels.
 * @param {{x:number,y:number}} wa
 * @param {{x:number,y:number}} wb
 * @param {boolean} isDraft
 */
function _appendChip(wa, wb, isDraft) {
  if (!_overlayEl) return;

  const mid = worldToScreen(
    (wa.x + wb.x) / 2,
    (wa.y + wb.y) / 2,
  );

  const len = length({ a: wa, b: wb });
  const text = fmtLen(len) + " " + unitLabel();

  const chip = document.createElement("div");
  chip.className = isDraft ? "measure-chip measure-chip--draft" : "measure-chip";
  chip.textContent = text;
  chip.style.left = mid.x + "px";
  chip.style.top  = mid.y + "px";
  chip.setAttribute("aria-hidden", "true");
  _overlayEl.appendChild(chip);
}

// ── Private: helpers ───────────────────────────────────────────────────────────

function _clearGroup(g) {
  while (g.firstChild) g.removeChild(g.firstChild);
}

function _makeLine(x1, y1, x2, y2) {
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", String(x1));
  line.setAttribute("y1", String(y1));
  line.setAttribute("x2", String(x2));
  line.setAttribute("y2", String(y2));
  return line;
}
