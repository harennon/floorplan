/**
 * clearanceRender.js — SVG + HTML-overlay renderer for clearance leaders, bands,
 * chips, and the fit-verdict pill.
 *
 * Registered as a surface.onRender hook AFTER symbolRenderFn so leaders sit above
 * symbol bodies but below the selection overlay (which is in #symbol-overlay).
 *
 * Canvas annotations (leaders, bands, chips, pill) live in:
 *   - SVG group #clearance  (leaders, ticks, bands)
 *   - .dim-labels container (chips + pill — crisp HTML text, not SVG)
 *
 * This module only appends its own nodes (class-tagged .clr-chip / .fit-pill) and
 * removes only those — it does NOT clear wall or symbol dim chips.
 *
 * Density "flagged" (default): canvas annotations only for tight/bad gaps.
 * Density "all": annotate every neighbour.
 * Panel list always shows all neighbours regardless of density.
 */

import { worldToScreen } from "./view.js";
import { fmtLen, unitLabel } from "./units.js";
import { model as symbolsModel } from "./symbols.js";
import { model as wallsModel } from "./walls.js";
import {
  threshold, density, enabled,
  aabb, computeClearances, worstStatus,
} from "./clearance.js";

const NS = "http://www.w3.org/2000/svg";

// ── DOM refs ───────────────────────────────────────────────────────────────────

let _gClearance   = null;
let _overlayEl    = null;
let _getSelectedId = () => null;
let _getSymbol     = () => null;

// ── Init ───────────────────────────────────────────────────────────────────────

/**
 * @param {SVGGElement} gClearance       #clearance SVG group
 * @param {HTMLElement} overlayEl        .dim-labels HTML overlay
 * @param {()=>string|null} getSelectedId
 * @param {(id:string)=>import("./symbols.js").Sym|null} getSymbol
 */
export function init(gClearance, overlayEl, getSelectedId, getSymbol) {
  _gClearance    = gClearance;
  _overlayEl     = overlayEl;
  _getSelectedId = getSelectedId || (() => null);
  _getSymbol     = getSymbol     || (() => null);
}

// ── Main render hook ───────────────────────────────────────────────────────────

/**
 * Full idempotent redraw: clears #clearance SVG group and any .clr-chip/.fit-pill
 * nodes in .dim-labels, then redraws from current state.
 * Called as a surface.onRender hook.
 */
export function render() {
  if (!_gClearance || !_overlayEl) return;

  // Clear our SVG group
  _clearGroup(_gClearance);

  // Clear ONLY our overlay nodes (leave wall/symbol dim chips intact)
  const old = _overlayEl.querySelectorAll(".clr-chip, .fit-pill");
  for (const el of old) el.remove();

  if (!enabled) return;

  const selectedId = _getSelectedId();
  if (!selectedId) return;

  const sym = _getSymbol(selectedId);
  if (!sym) return;

  const clearances = computeClearances(sym, {
    rooms: wallsModel.rooms,
    symbols: symbolsModel.symbols,
  });

  const worst = worstStatus(clearances);

  // Determine which gaps to annotate on canvas
  const toAnnotate = density === "all"
    ? clearances
    : clearances.filter(c => c.status !== "ok");

  // Draw SVG leaders + bands
  for (const c of toAnnotate) {
    _drawLeader(_gClearance, c);
    if (c.status !== "ok") {
      _drawBand(_gClearance, c);
    }
  }

  // Draw HTML chips (one per annotated gap)
  for (const c of toAnnotate) {
    _appendChip(c);
  }

  // Draw fit pill below selected symbol's AABB bottom-center
  if (clearances.length > 0) {
    _appendPill(sym, worst);
  }
}

// ── Private: SVG drawing ───────────────────────────────────────────────────────

/**
 * Draw a leader line (a→b in world coords) with end ticks, colored by status.
 * @param {SVGGElement} parent
 * @param {import("./clearance.js").Clearance} c
 */
function _drawLeader(parent, c) {
  const sa = worldToScreen(c.a.x, c.a.y);
  const sb = worldToScreen(c.b.x, c.b.y);
  const color = _statusColor(c.status);

  const line = _makeLine(sa.x, sa.y, sb.x, sb.y);
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("class", "clr-leader");
  line.setAttribute("opacity", "0.85");
  parent.appendChild(line);

  // End ticks (small perpendicular lines at a and b)
  _drawTick(parent, sa, sb, color);
  _drawTick(parent, sb, sa, color);
}

/**
 * Draw a small perpendicular end-tick at point `at`, perpendicular to the
 * direction toward `toward`.
 */
function _drawTick(parent, at, toward, color) {
  const TICK = 4; // px half-length
  const dx = toward.x - at.x;
  const dy = toward.y - at.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;
  // Perpendicular direction
  const px = -dy / len;
  const py =  dx / len;

  const tick = _makeLine(
    at.x - px * TICK, at.y - py * TICK,
    at.x + px * TICK, at.y + py * TICK,
  );
  tick.setAttribute("stroke", color);
  tick.setAttribute("stroke-width", "1.5");
  tick.setAttribute("stroke-linecap", "round");
  tick.setAttribute("class", "clr-tick");
  parent.appendChild(tick);
}

/**
 * Draw the filled band rectangle (perpendicular ribbon) between a and b in
 * world coords, for tight/bad gaps. Adds a pulsing animation class.
 * @param {SVGGElement} parent
 * @param {import("./clearance.js").Clearance} c
 */
function _drawBand(parent, c) {
  const sa = worldToScreen(c.a.x, c.a.y);
  const sb = worldToScreen(c.b.x, c.b.y);

  const dx = sb.x - sa.x;
  const dy = sb.y - sa.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;

  const BAND_W = 18; // px band width (perpendicular extent)

  // Perpendicular unit vector
  const px = -dy / len;
  const py =  dx / len;

  // Four corners of the band rectangle in screen space
  const pts = [
    { x: sa.x - px * BAND_W / 2, y: sa.y - py * BAND_W / 2 },
    { x: sb.x - px * BAND_W / 2, y: sb.y - py * BAND_W / 2 },
    { x: sb.x + px * BAND_W / 2, y: sb.y + py * BAND_W / 2 },
    { x: sa.x + px * BAND_W / 2, y: sa.y + py * BAND_W / 2 },
  ].map(p => `${p.x},${p.y}`).join(" ");

  const poly = document.createElementNS(NS, "polygon");
  poly.setAttribute("points", pts);
  poly.setAttribute("fill", _statusFill(c.status));
  poly.setAttribute("stroke", "none");
  poly.setAttribute("class", "clr-band");
  parent.appendChild(poly);
}

// ── Private: HTML overlay ──────────────────────────────────────────────────────

/**
 * Append a distance chip for a clearance item to .dim-labels.
 * @param {import("./clearance.js").Clearance} c
 */
function _appendChip(c) {
  if (!_overlayEl) return;

  // Position at leader midpoint in screen space
  const mid = worldToScreen(
    (c.a.x + c.b.x) / 2,
    (c.a.y + c.b.y) / 2,
  );

  const chip = document.createElement("div");
  chip.className = "clr-chip";

  const gapText = c.status === "bad"
    ? "overlap"
    : fmtLen(c.gap) + " " + unitLabel();

  chip.textContent = gapText;
  chip.style.left  = mid.x + "px";
  chip.style.top   = mid.y + "px";
  chip.style.color = _statusColor(c.status);
  chip.setAttribute("aria-hidden", "true");
  _overlayEl.appendChild(chip);
}

/**
 * Append the fit-verdict pill below the selected symbol's AABB bottom-center.
 * @param {import("./symbols.js").Sym} sym
 * @param {import("./clearance.js").ClrStatus} worst
 */
function _appendPill(sym, worst) {
  if (!_overlayEl) return;

  const box = aabb(sym);
  const botCenter = worldToScreen((box.l + box.r) / 2, box.b);
  const PILL_OFFSET = 28; // px below bottom edge

  const pill = document.createElement("div");
  pill.className = "fit-pill";
  pill.style.left = botCenter.x + "px";
  pill.style.top  = (botCenter.y + PILL_OFFSET) + "px";

  const verdictText = _verdictText(worst);
  pill.textContent = verdictText;
  pill.style.color = _statusColor(worst);
  pill.setAttribute("aria-hidden", "true");
  _overlayEl.appendChild(pill);
}

// ── Private: helpers ───────────────────────────────────────────────────────────

/**
 * Return the verdict text for the fit pill.
 * worst==="bad" covers both symbol overlap and wall-flush cases (gap clamped to
 * 0). The LLD specifies "Won't fit — overlap" for all bad states; the sub-
 * distinction ("no walkway" vs "overlap") was unreachable because any bad status
 * means gap<=0, so hasOverlap was always true. Simplified to a single branch.
 * @param {import("./clearance.js").ClrStatus} worst
 * @returns {string}
 */
function _verdictText(worst) {
  if (worst === "bad")   return "Won't fit — overlap";
  if (worst === "tight") return `Tight — under ${fmtLen(threshold)} ${unitLabel()} walkway`;
  return "It fits — room to spare";
}

/** Map ClrStatus to its CSS color variable value. */
function _statusColor(status) {
  if (status === "bad")   return "var(--clr-bad)";
  if (status === "tight") return "var(--clr-tight)";
  return "var(--clr-ok)";
}

/** Map ClrStatus to its fill color variable value (for bands). */
function _statusFill(status) {
  if (status === "bad")   return "var(--clr-bad-fill)";
  if (status === "tight") return "var(--clr-tight-fill)";
  return "var(--clr-ok-fill)";
}

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
