/**
 * hud.js — Heads-Up Display updater
 *
 * Reads view state and formats it into the HUD DOM cells.
 * Also handles the unit toggle button state and the snap-precision chip.
 * Values are built from numeric data through formatting functions —
 * no raw event data or user strings go into innerHTML.
 */

import { view, pxPerM, screenToWorld } from "./view.js";
import { fmtLen, unitLabel, unit, setUnit } from "./units.js";
import { getSnapMode, cycleSnapMode, onSnapModeChange } from "./grid.js";

/** DOM refs — populated by init(). */
let _elZoom = null;
let _elScale = null;
let _elCursor = null;
let _elUnitImp = null;
let _elUnitMet = null;
let _elSnapModeVal = null;   // <span id="hud-snap-mode-val">

/** Last known cursor screen position (updated by interactions.js). */
export let cursorScreen = { x: 0, y: 0 };

export function setCursorScreen(x, y) {
  cursorScreen.x = x;
  cursorScreen.y = y;
}

/** Bind HUD element references. Called once from main.js. */
export function init(elZoom, elScale, elCursor, elUnitImp, elUnitMet, elSnapModeBtn) {
  _elZoom = elZoom;
  _elScale = elScale;
  _elCursor = elCursor;
  _elUnitImp = elUnitImp;
  _elUnitMet = elUnitMet;

  // Wire unit toggle buttons.
  _elUnitImp.addEventListener("click", () => setUnit("ft"));
  _elUnitMet.addEventListener("click", () => setUnit("m"));

  // Wire snap-mode chip
  if (elSnapModeBtn) {
    _elSnapModeVal = elSnapModeBtn.querySelector("#hud-snap-mode-val");
    elSnapModeBtn.addEventListener("click", () => {
      cycleSnapMode();
    });
    elSnapModeBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        cycleSnapMode();
      }
    });
  }

  // Subscribe to snap mode changes to keep chip up to date
  onSnapModeChange(() => update());
}

/** Update all HUD cells from current view + unit state. */
export function update() {
  if (!_elZoom) return;

  // Zoom %.
  _elZoom.textContent = `${Math.round(view.zoom * 100)}%`;

  // Scale: how many metres per grid cell, formatted in current units.
  // We show the grid step that chooseGridStep would pick; instead of importing
  // grid.js here (avoids a cycle), we compute it directly with the same logic.
  const gridStep = _scaleForHud();
  _elScale.textContent = `${fmtLen(gridStep)} ${unitLabel()}/cell`;

  // Cursor world coords.
  const w = screenToWorld(cursorScreen.x, cursorScreen.y);
  _elCursor.textContent = `${fmtLen(w.x)}, ${fmtLen(w.y)} ${unitLabel()}`;

  // Unit toggle button pressed state.
  _elUnitImp.setAttribute("aria-pressed", unit === "ft" ? "true" : "false");
  _elUnitMet.setAttribute("aria-pressed", unit === "m" ? "true" : "false");

  // Snap-precision chip label
  if (_elSnapModeVal) {
    _elSnapModeVal.textContent = _snapChipLabel(getSnapMode());
  }
}

/**
 * Human label for the snap-mode chip, unit-aware.
 * @param {"auto"|number|"off"} mode
 * @returns {string}
 */
function _snapChipLabel(mode) {
  if (mode === "off")  return "Off";
  if (mode === "auto") return `Auto (${fmtLen(_scaleForHud())} ${unitLabel()})`;
  return `${fmtLen(mode)} ${unitLabel()}`;
}

/**
 * Compute current grid step in metres for the HUD scale cell.
 * Mirrors chooseGridStep logic without importing the full grid.js render path.
 * (chooseGridStep is now imported from grid.js via the snap API, but the scale
 * display uses the same adaptive rule so we keep the local mirror for the
 * Scale cell to avoid any risk of future dependency cycles.)
 */
const NICE_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100];
const TARGET_PX = 56;

function _scaleForHud() {
  const scale = pxPerM();
  for (const step of NICE_STEPS) {
    if (step * scale >= TARGET_PX) return step;
  }
  return NICE_STEPS[NICE_STEPS.length - 1];
}
