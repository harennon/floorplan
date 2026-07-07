/**
 * main.js — application boot / wiring
 *
 * Initialises modules, wires onChange callbacks, and kicks off the first render.
 * This is the only file that knows about all modules.
 */

import { onChange as onViewChange, resetView } from "./view.js";
import { onChange as onUnitChange } from "./units.js";
import { init as initSurface, initWallLayer, resize, render, scheduleRender } from "./surface.js";
import { init as initHud } from "./hud.js";
import { init as initInteractions, setDrawHooks } from "./interactions.js";
import { init as initWallRender, render as wallRender } from "./wallRender.js";
import { init as initWallTool, isDrawMode, getSnap, onHover, onClick, onLeave } from "./wallTool.js";
import { init as initDimensions } from "./dimensions.js";

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // ── Grab DOM refs ──────────────────────────────────────────────────────────
  const stage    = document.getElementById("stage");
  const svg      = document.getElementById("drawing");
  const gGrid    = document.getElementById("grid");
  const gWorld   = document.getElementById("world");
  const gDraft   = document.getElementById("draft");
  const gSnap    = document.getElementById("snap");
  const labelsEl  = document.querySelector(".labels");
  const dimLayerEl = document.querySelector(".dim-layer");
  const hint       = document.getElementById("hint");

  // HUD
  const elZoom    = document.getElementById("hud-zoom");
  const elScale   = document.getElementById("hud-scale");
  const elCursor  = document.getElementById("hud-cursor");
  const elUnitImp = document.getElementById("unit-imperial");
  const elUnitMet = document.getElementById("unit-metric");
  const elHudSnap = document.getElementById("hud-snap-val");

  // Zoom buttons
  const btnZoomIn  = document.getElementById("btn-zoom-in");
  const btnZoomOut = document.getElementById("btn-zoom-out");
  const btnReset   = document.getElementById("btn-zoom-reset");

  // Tool rail
  const snapTagEl    = document.querySelector(".snap-tag");
  const btnSelect    = document.getElementById("tool-select");
  const btnWall      = document.getElementById("tool-wall");
  const btnUndo      = document.getElementById("tool-undo");
  const btnFinish    = document.getElementById("tool-finish");
  const railEl        = document.querySelector(".tool-rail");
  const railToggleEl  = document.querySelector(".tool-rail-toggle");
  const railCollapseEl = document.querySelector(".tool-rail-collapse");

  // ── Initialise modules ─────────────────────────────────────────────────────
  initSurface(stage, svg, gGrid, gWorld);
  initHud(elZoom, elScale, elCursor, elUnitImp, elUnitMet);

  // wallRender binds mount points + getSnap
  initWallRender(gWorld, gDraft, gSnap, labelsEl, dimLayerEl, getSnap);

  // wallTool binds rail, hud, keyboard
  initWallTool({
    hudSnap:     elHudSnap,
    snapTag:     snapTagEl,
    btnSelect,
    btnWall,
    btnUndo,
    btnFinish,
    stage,
    rail:         railEl,
    railToggle:   railToggleEl,
    railCollapse: railCollapseEl,
  });

  // Wire wall render into surface loop
  initWallLayer(gDraft, gSnap, labelsEl, wallRender);

  // Dimension interaction controller
  initDimensions({ dimLayer: dimLayerEl, stage, onCommit: scheduleRender });

  // Inject draw hooks into interactions (no static wall import there)
  setDrawHooks({ isDrawMode, onHover, onClick, onLeave });

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
