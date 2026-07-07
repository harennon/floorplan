/**
 * main.js — application boot / wiring
 *
 * Initialises modules, wires onChange callbacks, and kicks off the first render.
 * This is the only file that knows about all modules.
 */

import { onChange as onViewChange, resetView } from "./view.js";
import { onChange as onUnitChange } from "./units.js";
import { init as initSurface, initWallLayer, onRender, resize, render, scheduleRender } from "./surface.js";
import { init as initHud } from "./hud.js";
import { init as initInteractions, setDrawHooks } from "./interactions.js";
import { init as initWallRender, render as wallRender } from "./wallRender.js";
import { init as initWallTool, isDrawMode, getSnap, onHover, onClick, onLeave } from "./wallTool.js";
import { init as initMeasure, update as measureUpdate, getHighlightRoomId } from "./measure.js";
import { init as initDimEntry, reposition as dimReposition, getEditingEdge } from "./dimEntry.js";

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // ── Grab DOM refs ──────────────────────────────────────────────────────────
  const stage    = document.getElementById("stage");
  const svg      = document.getElementById("drawing");
  const gGrid    = document.getElementById("grid");
  const gWorld   = document.getElementById("world");
  const gDraft   = document.getElementById("draft");
  const gSnap    = document.getElementById("snap");
  const labelsEl    = document.querySelector(".labels");
  const dimLabelsEl = document.querySelector(".dim-labels");
  const hint     = document.getElementById("hint");

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

  // Measure inspector
  const measurePanel  = document.querySelector(".measure");
  const measureList   = document.querySelector(".measure-list");
  const measureTotal  = document.querySelector(".measure-total-val");
  const measureToggle = document.querySelector(".measure-toggle");

  // ── Initialise modules ─────────────────────────────────────────────────────
  initSurface(stage, svg, gGrid, gWorld);
  initHud(elZoom, elScale, elCursor, elUnitImp, elUnitMet);

  // wallRender binds mount points + injected getters
  initWallRender(gWorld, gDraft, gSnap, labelsEl, dimLabelsEl, getSnap, getHighlightRoomId, getEditingEdge);

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

  // Inject draw hooks into interactions (no static wall import there)
  setDrawHooks({ isDrawMode, onHover, onClick, onLeave });

  initInteractions(stage, hint, btnZoomIn, btnZoomOut, btnReset);

  // Measure inspector
  initMeasure({ panel: measurePanel, list: measureList, total: measureTotal, toggle: measureToggle });

  // dimEntry (handles its own pointer-isolation and unit-cancel binding internally)
  initDimEntry({ stage, dimLabels: dimLabelsEl });

  // Register post-render hooks
  onRender(measureUpdate);
  onRender(dimReposition);

  // Default measure inspector to collapsed on narrow screens (Edge Case 13)
  if (window.matchMedia("(max-width: 640px)").matches) {
    measurePanel.classList.add("measure--collapsed");
    measureToggle.textContent = "▸";
    measureToggle.setAttribute("aria-expanded", "false");
  }

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
