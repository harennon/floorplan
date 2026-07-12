/**
 * measureRender.js — SVG + HTML-overlay renderer for distance annotations (LLD 91)
 *
 * Registered as a surface.onRender hook AFTER clearanceRenderFn in main.js.
 * Renders into:
 *   - SVG group #measure  (lines, end ticks, rubber-band)
 *   - .dim-labels overlay (label chips with class .measure-label)
 *
 * Follows the clearanceRender pattern of SCOPED overlay removal:
 *   removes only .measure-label nodes, never full-clears .dim-labels
 *   (wallRender already full-cleared it before this hook runs).
 *
 * The rubber-band draft branch is explicitly gated on isMeasureMode() to prevent
 * a stale pendingA from painting outside measure mode.
 */

import { worldToScreen } from "./view.js";
import { fmtLen, unitLabel } from "./units.js";
import { model as measurementsModel } from "./measurements.js";
import { edgeLength } from "./walls.js";
import { palette } from "./theme.js";
import { isMeasureMode } from "./wallTool.js";

const NS = "http://www.w3.org/2000/svg";

/** End-tick half-length in screen px (matches wall dimension tick idiom). */
const TICK_PX = 6;

// ── Module refs ───────────────────────────────────────────────────────────────

/** @type {SVGGElement|null} */
let _gMeasure = null;
/** @type {HTMLElement|null} */
let _dimLabelsEl = null;
/** @type {()=>{ pendingA:{x:number,y:number}|null, cursorSnap:{x:number,y:number,type:string}|null }} */
let _getDraftState = () => ({ pendingA: null, cursorSnap: null });
/** @type {()=>string|null} */
let _getSelectedId = () => null;

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * @param {SVGGElement} gMeasure        #measure SVG group
 * @param {HTMLElement} dimLabelsEl     .dim-labels HTML overlay
 * @param {()=>object}  getDraftState   from measureTool.getDraftState
 * @param {()=>string|null} getSelectedId  from measureTool.getSelectedId
 */
export function init(gMeasure, dimLabelsEl, getDraftState, getSelectedId) {
  _gMeasure      = gMeasure;
  _dimLabelsEl   = dimLabelsEl;
  _getDraftState = getDraftState || (() => ({ pendingA: null, cursorSnap: null }));
  _getSelectedId = getSelectedId || (() => null);
}

// ── Main render hook ──────────────────────────────────────────────────────────

/**
 * Full idempotent redraw. Called on the onRender chain (after clearanceRender).
 */
export function render() {
  if (!_gMeasure || !_dimLabelsEl) return;

  // Clear our SVG group (exclusively owned)
  _clearGroup(_gMeasure);

  // Clear ONLY our overlay nodes (never full-clear — wall/clearance chips may exist)
  const old = _dimLabelsEl.querySelectorAll(".measure-label");
  for (const el of old) el.remove();

  const p = palette();
  const selId = _getSelectedId();

  // Draw all committed measurements
  for (const m of measurementsModel.measurements) {
    const selected = m.id === selId;
    _drawMeasurement(_gMeasure, m.a, m.b, selected, p);
    _appendLabel(m.a, m.b);
  }

  // Draw rubber-band in-progress line (gated on isMeasureMode())
  if (isMeasureMode()) {
    const { pendingA, cursorSnap } = _getDraftState();
    if (pendingA && cursorSnap) {
      _drawRubberBand(_gMeasure, pendingA, cursorSnap, p);
      _appendDraftLabel(pendingA, cursorSnap);
    }
  }
}

// ── Private: SVG drawing ──────────────────────────────────────────────────────

/**
 * Draw a committed measurement line + end ticks.
 * @param {SVGGElement} parent
 * @param {{ x:number, y:number }} a  world
 * @param {{ x:number, y:number }} b  world
 * @param {boolean} selected
 * @param {object} p  palette
 */
function _drawMeasurement(parent, a, b, selected, p) {
  const sa = worldToScreen(a.x, a.y);
  const sb = worldToScreen(b.x, b.y);

  const color = selected
    ? `rgb(${p.accentRgb})`
    : p.dim;
  const width = selected ? 2 : 1.5;

  // Main line
  const line = _makeLine(sa.x, sa.y, sb.x, sb.y);
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", String(width));
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("class", "measure-line");
  parent.appendChild(line);

  // End ticks at A and B
  _drawTick(parent, sa, sb, color, width);
  _drawTick(parent, sb, sa, color, width);
}

/**
 * Draw a short perpendicular end-tick at `at`, perpendicular to direction toward `toward`.
 * @param {SVGGElement} parent
 * @param {{ x:number, y:number }} at      screen coords
 * @param {{ x:number, y:number }} toward  screen coords
 * @param {string} color
 * @param {number} width
 */
function _drawTick(parent, at, toward, color, width) {
  const dx = toward.x - at.x;
  const dy = toward.y - at.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;
  // Perpendicular unit vector
  const px = -dy / len;
  const py =  dx / len;

  const tick = _makeLine(
    at.x - px * TICK_PX, at.y - py * TICK_PX,
    at.x + px * TICK_PX, at.y + py * TICK_PX,
  );
  tick.setAttribute("stroke", color);
  tick.setAttribute("stroke-width", String(width));
  tick.setAttribute("stroke-linecap", "round");
  tick.setAttribute("class", "measure-tick");
  parent.appendChild(tick);
}

/**
 * Draw the rubber-band preview line (dashed) from pendingA to cursorSnap,
 * plus dot markers at both endpoints.
 * @param {SVGGElement} parent
 * @param {{ x:number, y:number }} a  world
 * @param {{ x:number, y:number }} b  world (cursor snap)
 * @param {object} p  palette
 */
function _drawRubberBand(parent, a, b, p) {
  const sa = worldToScreen(a.x, a.y);
  const sb = worldToScreen(b.x, b.y);

  const color = p.muted;

  // Dashed line
  const line = _makeLine(sa.x, sa.y, sb.x, sb.y);
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-dasharray", "4 4");
  line.setAttribute("class", "measure-draft");
  parent.appendChild(line);

  // Dot at A
  _drawDot(parent, sa, color);
  // Dot at cursor
  _drawDot(parent, sb, color);
}

/**
 * Draw a small filled dot at a screen position.
 * @param {SVGGElement} parent
 * @param {{ x:number, y:number }} s  screen coords
 * @param {string} color
 */
function _drawDot(parent, s, color) {
  const circle = document.createElementNS(NS, "circle");
  circle.setAttribute("cx", String(s.x));
  circle.setAttribute("cy", String(s.y));
  circle.setAttribute("r",  "3");
  circle.setAttribute("fill", color);
  circle.setAttribute("class", "measure-dot");
  parent.appendChild(circle);
}

// ── Private: HTML overlay ─────────────────────────────────────────────────────

/**
 * Append a distance label chip for a committed measurement at the midpoint.
 * @param {{ x:number, y:number }} a  world
 * @param {{ x:number, y:number }} b  world
 */
function _appendLabel(a, b) {
  if (!_dimLabelsEl) return;

  const dist = edgeLength(a, b);
  const mid = worldToScreen((a.x + b.x) / 2, (a.y + b.y) / 2);

  const chip = document.createElement("div");
  chip.className = "measure-label";
  chip.textContent = `${fmtLen(dist)} ${unitLabel()}`;
  chip.style.left  = mid.x + "px";
  chip.style.top   = mid.y + "px";
  chip.setAttribute("aria-hidden", "true");
  _dimLabelsEl.appendChild(chip);
}

/**
 * Append a live distance label chip for the in-progress rubber-band.
 * @param {{ x:number, y:number }} a  world
 * @param {{ x:number, y:number }} b  world
 */
function _appendDraftLabel(a, b) {
  if (!_dimLabelsEl) return;

  const dist = edgeLength(a, b);
  if (dist < 1e-6) return; // don't render a label at ~zero length

  const mid = worldToScreen((a.x + b.x) / 2, (a.y + b.y) / 2);

  const chip = document.createElement("div");
  chip.className = "measure-label measure-label--draft";
  chip.textContent = `${fmtLen(dist)} ${unitLabel()}`;
  chip.style.left  = mid.x + "px";
  chip.style.top   = mid.y + "px";
  chip.setAttribute("aria-hidden", "true");
  _dimLabelsEl.appendChild(chip);
}

// ── Private: helpers ──────────────────────────────────────────────────────────

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
