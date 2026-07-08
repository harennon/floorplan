/**
 * grid.js — adaptive grid renderer + snap-precision authority
 *
 * Draws fine / major / axis line tiers into an SVG <g> element.
 * Grid is locked to world space (lines move with pan/zoom).
 *
 * Step selection:
 *   Pick the smallest NICE step whose on-screen spacing >= targetPx (~56px).
 *   Every MAJOR_EVERY-th line is a "major" line; world origin lines are "axis".
 *
 * Snap-precision mode:
 *   snapStep() is the single authority for the effective snap increment.
 *   It is decoupled from chooseGridStep() / grid rendering — fixed presets
 *   apply at any zoom without requiring extreme zoom levels.
 *
 * Implementation notes:
 *   - Lines are built into a DocumentFragment and appended once.
 *   - Iterate by integer index off origin (not float accumulation) to avoid drift.
 *   - Cap line count at MAX_LINES per axis to guard against degenerate viewports.
 *   - Use Math.round when classifying axis/major to handle float imprecision near origin.
 */

import { view, pxPerM, screenToWorld } from "./view.js";

export const NICE_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100]; // metres
export const MAJOR_EVERY = 5;

const MAX_LINES = 2000; // defensive cap per axis
const NS = "http://www.w3.org/2000/svg";

/**
 * Returns the smallest NICE step whose on-screen spacing >= targetPx.
 * Falls back to the largest step (100m) if none qualifies.
 */
export function chooseGridStep(targetPx = 56) {
  const scale = pxPerM();
  for (const step of NICE_STEPS) {
    if (step * scale >= targetPx) return step;
  }
  return NICE_STEPS[NICE_STEPS.length - 1];
}

// ── Snap-precision mode ───────────────────────────────────────────────────────

/**
 * Ordered presets for the HUD Snap chip.
 * "auto" and "off" are sentinels; numbers are fixed steps in metres.
 * @type {Array<"auto"|number|"off">}
 */
export const SNAP_PRESETS = ["auto", 0.25, 0.1, 0.025, "off"];

/**
 * @typedef {"auto" | 0.25 | 0.1 | 0.025 | "off"} SnapMode
 */

/** Current snap-precision mode. In-memory (not persisted), default "auto". */
let _snapMode = "auto";

/** Registered mode-change callbacks. */
const _modeListeners = [];

/**
 * Returns the current snap mode.
 * @returns {SnapMode}
 */
export function getSnapMode() {
  return _snapMode;
}

/**
 * Set the snap mode. Must be one of SNAP_PRESETS.
 * Fires onSnapModeChange listeners after update.
 * Throws (dev error) on invalid mode.
 * @param {SnapMode} mode
 */
export function setSnapMode(mode) {
  if (!SNAP_PRESETS.includes(mode)) {
    throw new Error(`setSnapMode: invalid mode "${mode}"; must be one of ${JSON.stringify(SNAP_PRESETS)}`);
  }
  _snapMode = mode;
  for (const cb of _modeListeners) cb(mode);
}

/**
 * Advance to the next preset (wraps around).
 * Used by the HUD chip click.
 * @returns {SnapMode}
 */
export function cycleSnapMode() {
  const idx = SNAP_PRESETS.indexOf(_snapMode);
  const nextIdx = (idx + 1) % SNAP_PRESETS.length;
  setSnapMode(SNAP_PRESETS[nextIdx]);
  return _snapMode;
}

/**
 * Effective snap step in metres for the current mode, decoupled from render/zoom.
 *  - "auto"  → chooseGridStep(56)  (adaptive; zoom-dependent, unchanged rule)
 *  - number  → that value verbatim (zoom-INDEPENDENT)
 *  - "off"   → null                (free placement; caller skips grid snap)
 * @returns {number|null}
 */
export function snapStep() {
  if (_snapMode === "off") return null;
  if (_snapMode === "auto") return chooseGridStep(56);
  return _snapMode; // fixed numeric preset
}

/**
 * Register a callback fired after the snap mode changes (for HUD re-render etc.).
 * @param {(mode: SnapMode) => void} cb
 */
export function onSnapModeChange(cb) {
  _modeListeners.push(cb);
}

/**
 * Draw grid lines into gGrid covering the visible area W × H.
 * Clears gGrid before drawing.
 */
export function drawGrid(gGrid, W, H) {
  // Clear existing lines.
  while (gGrid.firstChild) gGrid.removeChild(gGrid.firstChild);

  if (W <= 0 || H <= 0) return;

  const step = chooseGridStep(56);
  const scale = pxPerM();

  // World coords of screen corners.
  const topLeft = screenToWorld(0, 0);
  const botRight = screenToWorld(W, H);

  // Integer index range covering visible area with one cell margin.
  const iXMin = Math.floor(topLeft.x / step) - 1;
  const iXMax = Math.ceil(botRight.x / step) + 1;
  const iYMin = Math.floor(topLeft.y / step) - 1;
  const iYMax = Math.ceil(botRight.y / step) + 1;

  // Defensive cap — bail if a degenerate viewport would emit too many lines.
  if ((iXMax - iXMin) > MAX_LINES || (iYMax - iYMin) > MAX_LINES) return;

  const frag = document.createDocumentFragment();

  // Vertical lines (constant x in world space).
  for (let ix = iXMin; ix <= iXMax; ix++) {
    const wx = ix * step;
    const sx = wx * scale + view.panX;
    frag.appendChild(_makeLine(sx, 0, sx, H, _tier(ix)));
  }

  // Horizontal lines (constant y in world space).
  for (let iy = iYMin; iy <= iYMax; iy++) {
    const wy = iy * step;
    const sy = wy * scale + view.panY;
    frag.appendChild(_makeLine(0, sy, W, sy, _tier(iy)));
  }

  gGrid.appendChild(frag);
}

/** Classify a grid line index as "axis", "major", or "fine". */
function _tier(idx) {
  const r = Math.round(idx);
  if (r === 0) return "axis";
  if (r % MAJOR_EVERY === 0) return "major";
  return "fine";
}

/** Create an SVG line element with the appropriate CSS class. */
function _makeLine(x1, y1, x2, y2, tier) {
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  line.setAttribute("class", `grid-${tier}`);
  return line;
}
