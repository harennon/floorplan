/**
 * surface.js — SVG render + resize
 *
 * Owns the SVG element and the render loop.
 * Renders are coalesced via requestAnimationFrame so rapid pan/wheel
 * events don't queue synchronous DOM rebuilds.
 */

import { drawGrid } from "./grid.js";
import { update as hudUpdate } from "./hud.js";
import { worldToScreen } from "./view.js";

const NS = "http://www.w3.org/2000/svg";

/** DOM refs — set by init(). */
let _stage = null;
let _svg = null;
let _gGrid = null;
let _gWorld = null;
let _placeholder = null;

/** Current viewport dimensions. */
export let W = 0;
export let H = 0;

/** RAF handle for render coalescing. */
let _rafHandle = null;

/** Bind element references. Called once from main.js before first render. */
export function init(stage, svg, gGrid, gWorld) {
  _stage = stage;
  _svg = svg;
  _gGrid = gGrid;
  _gWorld = gWorld;

  // Create placeholder rectangle (scale reference, not a data model).
  _placeholder = document.createElementNS(NS, "rect");
  _placeholder.setAttribute("class", "placeholder");
  _gWorld.appendChild(_placeholder);
}

/**
 * Recompute W/H from stage bounding rect and update SVG viewBox.
 * Returns { W, H }.
 */
export function resize() {
  const rect = _stage.getBoundingClientRect();
  W = rect.width;
  H = rect.height;
  if (W > 0 && H > 0) {
    _svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  }
  return { W, H };
}

/**
 * Schedule a render (coalesced per animation frame).
 * Call this instead of render() directly from event handlers.
 */
export function scheduleRender() {
  if (_rafHandle !== null) return;
  _rafHandle = requestAnimationFrame(_doRender);
}

/**
 * Synchronous full render: grid + placeholder + HUD.
 * Idempotent — clears and redraws from current state.
 * Cancels any pending scheduled render so it doesn't fire redundantly.
 * Prefer scheduleRender() from event handlers.
 */
export function render() {
  if (_rafHandle !== null) {
    cancelAnimationFrame(_rafHandle);
    _rafHandle = null;
  }
  _doRender();
}

function _doRender() {
  _rafHandle = null;
  if (W <= 0 || H <= 0) return;

  drawGrid(_gGrid, W, H);
  _drawPlaceholder();
  hudUpdate();
}

/**
 * Draw a faint placeholder rectangle to convey scale.
 * 5m wide × 3m tall room outline, offset 1m from origin.
 * Not editable, not a data model.
 */
function _drawPlaceholder() {
  if (!_placeholder) return;
  const tl = worldToScreen(1, 1);
  const br = worldToScreen(6, 4);
  _placeholder.setAttribute("x", tl.x);
  _placeholder.setAttribute("y", tl.y);
  _placeholder.setAttribute("width", br.x - tl.x);
  _placeholder.setAttribute("height", br.y - tl.y);
}
