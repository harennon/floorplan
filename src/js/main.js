/**
 * main.js — application boot / wiring
 *
 * Initialises modules, wires onChange callbacks, and kicks off the first render.
 * This is the only file that knows about all modules.
 */

import { onChange as onViewChange, resetView } from "./view.js";
import { onChange as onUnitChange } from "./units.js";
import { init as initSurface, resize, render, scheduleRender } from "./surface.js";
import { init as initHud } from "./hud.js";
import { init as initInteractions } from "./interactions.js";

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // ── Grab DOM refs ──────────────────────────────────────────────────────────
  const stage    = document.getElementById("stage");
  const svg      = document.getElementById("drawing");
  const gGrid    = document.getElementById("grid");
  const gWorld   = document.getElementById("world");
  const hint     = document.getElementById("hint");

  // HUD
  const elZoom   = document.getElementById("hud-zoom");
  const elScale  = document.getElementById("hud-scale");
  const elCursor = document.getElementById("hud-cursor");
  const elUnitImp = document.getElementById("unit-imperial");
  const elUnitMet = document.getElementById("unit-metric");

  // Zoom buttons
  const btnZoomIn  = document.getElementById("btn-zoom-in");
  const btnZoomOut = document.getElementById("btn-zoom-out");
  const btnReset   = document.getElementById("btn-zoom-reset");

  // ── Initialise modules ─────────────────────────────────────────────────────
  initSurface(stage, svg, gGrid, gWorld);
  initHud(elZoom, elScale, elCursor, elUnitImp, elUnitMet);
  initInteractions(stage, hint, btnZoomIn, btnZoomOut, btnReset);

  // ── Wire re-render on view / unit changes ──────────────────────────────────
  onViewChange(scheduleRender);
  onUnitChange(scheduleRender);

  // ── Initial size + view ────────────────────────────────────────────────────
  const { W, H } = resize();
  resetView(W, H);

  // ── Window resize ──────────────────────────────────────────────────────────
  window.addEventListener("resize", () => {
    resize();
    render();
  });

  // ── First render ───────────────────────────────────────────────────────────
  render();
});
