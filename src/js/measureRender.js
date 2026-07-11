/**
 * measureRender.js — SVG lines/ticks and .dim-labels chips for distance
 * annotations (LLD 85).
 *
 * Registered on the surface.onRender chain AFTER symbolRenderFn so .dim-labels
 * is already populated by wall + symbol chips; this module only appends.
 *
 * Reads:
 *  - measurements.model — committed annotations
 *  - getSelectedId()    — highlight selected annotation
 *  - getPendingA()      — in-progress placement: point A
 *  - getPreviewSnap()   — in-progress placement: live cursor snap
 *
 * Never mutates models; purely for display.
 *
 * @typedef {import("./measurements.js").Measurement} Measurement
 * @typedef {import("./walls.js").Snap} Snap
 */

import { worldToScreen } from "./view.js";
import { fmtLen, unitLabel } from "./units.js";
import { edgeLength } from "./walls.js";
import { model as measurementsModel } from "./measurements.js";
import { palette } from "./theme.js";

const NS = "http://www.w3.org/2000/svg";

/** Length of end ticks in screen px. */
const TICK_HALF_PX = 6;
/** Stroke width for selected state. */
const SEL_STROKE_W = 2.5;
/** Normal stroke width. */
const NORMAL_STROKE_W = 1.5;

// ── DOM refs ───────────────────────────────────────────────────────────────────

let _gMeasure    = null;
let _dimLabels   = null;

// ── Injected getters ───────────────────────────────────────────────────────────

let _getMeasurements = () => measurementsModel.measurements;
let _getSelectedId   = () => null;
let _getPendingA     = () => null;
let _getPreviewSnap  = () => null;

// ── Init ───────────────────────────────────────────────────────────────────────

/**
 * @param {SVGGElement} gMeasure
 * @param {HTMLElement} dimLabels
 * @param {()=>Measurement[]} getMeasurements
 * @param {()=>string|null} getSelectedId
 * @param {()=>{x:number,y:number}|null} getPendingA
 * @param {()=>Snap|null} getPreviewSnap
 */
export function init(gMeasure, dimLabels, getMeasurements, getSelectedId, getPendingA, getPreviewSnap) {
  _gMeasure        = gMeasure;
  _dimLabels       = dimLabels;
  _getMeasurements = getMeasurements || (() => measurementsModel.measurements);
  _getSelectedId   = getSelectedId   || (() => null);
  _getPendingA     = getPendingA     || (() => null);
  _getPreviewSnap  = getPreviewSnap  || (() => null);
}

// ── Main render ────────────────────────────────────────────────────────────────

/**
 * Full idempotent redraw of committed measurements + preview.
 * Called as a surface.onRender hook (after symbolRenderFn).
 */
export function render() {
  if (!_gMeasure) return;

  // Clear only our own SVG group
  _clearGroup(_gMeasure);

  const p = palette();
  const color = p.measureLine || "#6fb3d9";
  const selectedId = _getSelectedId();
  const measurements = _getMeasurements();

  // ── Committed measurements ─────────────────────────────────────────────────
  for (const m of measurements) {
    const sa = worldToScreen(m.a.x, m.a.y);
    const sb = worldToScreen(m.b.x, m.b.y);
    const selected = m.id === selectedId;

    // Main line
    const line = _makeLine(sa.x, sa.y, sb.x, sb.y);
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", selected ? String(SEL_STROKE_W) : String(NORMAL_STROKE_W));
    line.setAttribute("stroke-linecap", "round");
    if (selected) {
      line.setAttribute("data-selected", "true");
      // Soft halo for selected state
      line.setAttribute("filter", "drop-shadow(0 0 3px " + color + ")");
    }
    _gMeasure.appendChild(line);

    // End ticks at A and B
    _appendTick(_gMeasure, sa.x, sa.y, sb.x, sb.y, color, selected);
    _appendTick(_gMeasure, sb.x, sb.y, sa.x, sa.y, color, selected);

    // Distance chip appended to .dim-labels
    _appendMeasureChip(m, sa, sb, color);
  }

  // ── Preview (in-progress rubber-band) ──────────────────────────────────────
  const pendingA = _getPendingA();
  const previewSnap = _getPreviewSnap();
  if (pendingA !== null && previewSnap !== null) {
    const sa = worldToScreen(pendingA.x, pendingA.y);
    const sb = worldToScreen(previewSnap.x, previewSnap.y);

    // Dashed preview line
    const previewLine = _makeLine(sa.x, sa.y, sb.x, sb.y);
    previewLine.setAttribute("stroke", color);
    previewLine.setAttribute("stroke-width", "1.5");
    previewLine.setAttribute("stroke-dasharray", "6 4");
    previewLine.setAttribute("stroke-linecap", "round");
    previewLine.setAttribute("opacity", "0.7");
    _gMeasure.appendChild(previewLine);

    // Snap dot at live endpoint B
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", String(sb.x));
    dot.setAttribute("cy", String(sb.y));
    dot.setAttribute("r", "4");
    dot.setAttribute("fill", color);
    dot.setAttribute("opacity", "0.85");
    _gMeasure.appendChild(dot);

    // Fixed point A marker
    const dotA = document.createElementNS(NS, "circle");
    dotA.setAttribute("cx", String(sa.x));
    dotA.setAttribute("cy", String(sa.y));
    dotA.setAttribute("r", "3");
    dotA.setAttribute("fill", "none");
    dotA.setAttribute("stroke", color);
    dotA.setAttribute("stroke-width", "1.5");
    _gMeasure.appendChild(dotA);
  }
}

// ── Private: end tick ─────────────────────────────────────────────────────────

/**
 * Draw a perpendicular tick at endpoint (ex, ey) oriented relative to the
 * other endpoint (ox, oy).
 */
function _appendTick(parent, ex, ey, ox, oy, color, selected) {
  const dx = ox - ex;
  const dy = oy - ey;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return;
  // Perpendicular unit vector (rotate 90°)
  const px = -dy / len;
  const py =  dx / len;

  const tick = _makeLine(
    ex + px * TICK_HALF_PX, ey + py * TICK_HALF_PX,
    ex - px * TICK_HALF_PX, ey - py * TICK_HALF_PX,
  );
  tick.setAttribute("stroke", color);
  tick.setAttribute("stroke-width", selected ? String(SEL_STROKE_W) : String(NORMAL_STROKE_W));
  tick.setAttribute("stroke-linecap", "round");
  parent.appendChild(tick);
}

// ── Private: distance chip ────────────────────────────────────────────────────

function _appendMeasureChip(m, sa, sb, color) {
  if (!_dimLabels) return;
  const mx = (sa.x + sb.x) / 2;
  const my = (sa.y + sb.y) / 2;
  const len = edgeLength(m.a, m.b);
  const text = fmtLen(len) + " " + unitLabel();

  const chip = document.createElement("span");
  chip.className = "measure-chip";
  chip.textContent = text;
  chip.style.left = mx + "px";
  chip.style.top  = my + "px";
  chip.style.borderColor = color;
  chip.setAttribute("data-measure-id", m.id);
  _dimLabels.appendChild(chip);
}

// ── Private: SVG helpers ───────────────────────────────────────────────────────

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
