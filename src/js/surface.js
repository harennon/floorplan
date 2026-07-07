/**
 * surface.js — SVG render + resize
 *
 * Owns the SVG element and the render loop.
 * Renders are coalesced via requestAnimationFrame so rapid pan/wheel
 * events don't queue synchronous DOM rebuilds.
 */

import { drawGrid } from "./grid.js";
import { update as hudUpdate } from "./hud.js";

/** DOM refs — set by init(). */
let _stage = null;
let _svg = null;
let _gGrid = null;
let _gWorld = null;

/** Wall-layer refs (set by initWallLayer). */
let _gDraft   = null;
let _gSnap    = null;
let _labelsEl = null;

/** wallRender.render callback — injected after wallRender init. */
let _wallRender = null;

/** Post-render hooks registered via onRender(). */
const _renderHooks = [];

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
}

/**
 * Bind the wall-layer SVG groups and labels overlay, and supply the
 * wallRender.render function. Called once from main.js after init().
 * @param {SVGGElement} gDraft
 * @param {SVGGElement} gSnap
 * @param {HTMLElement} labelsEl
 * @param {()=>void} wallRenderFn
 */
export function initWallLayer(gDraft, gSnap, labelsEl, wallRenderFn) {
  _gDraft    = gDraft;
  _gSnap     = gSnap;
  _labelsEl  = labelsEl;
  _wallRender = wallRenderFn;
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

/**
 * Register a post-render hook. Called at end of _doRender, after wallRender
 * and before hudUpdate. Used by measure.update and dimEntry.reposition.
 * @param {()=>void} cb
 */
export function onRender(cb) {
  _renderHooks.push(cb);
}

function _doRender() {
  _rafHandle = null;
  if (W <= 0 || H <= 0) return;

  drawGrid(_gGrid, W, H);
  if (_wallRender) _wallRender();
  for (const cb of _renderHooks) cb();
  hudUpdate();
}
