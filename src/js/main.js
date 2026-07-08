/**
 * main.js — application boot / wiring
 *
 * Initialises modules, wires onChange callbacks, and kicks off the first render.
 * This is the only file that knows about all modules.
 */

import { onChange as onViewChange, resetView } from "./view.js";
import { onChange as onUnitChange } from "./units.js";
import { init as initSurface, initWallLayer, onRender, resize, render, scheduleRender } from "./surface.js";
import { scheduleSave } from "./persist.js";
import { init as initActionsUI, boot as bootActionsUI } from "./actionsUI.js";
import { init as initHud } from "./hud.js";
import { init as initInteractions, setDrawHooks, setSelectHooks } from "./interactions.js";
import { init as initWallRender, render as wallRender } from "./wallRender.js";
import { init as initWallTool, isDrawMode, getSnap, onHover, onClick, onLeave, setTool } from "./wallTool.js";
import { init as initMeasure, update as measureUpdate, getHighlightRoomId } from "./measure.js";
import { init as initDimEntry, reposition as dimReposition, getEditingEdge } from "./dimEntry.js";
import { init as initSymbolRender, render as symbolRenderFn } from "./symbolRender.js";
import { init as initSymbolDimEntry, reposition as symbolDimReposition, getEditingDim } from "./symbolDimEntry.js";
import { init as initSymbolTool, getSelectedId, getPlacementGhost, onSelectDown, onSelectMove, onSelectUp, onTapEmpty, onDrawModeEnter, getLockAspect, repositionInspector } from "./symbolTool.js";

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  // ── Grab DOM refs ──────────────────────────────────────────────────────────
  const stage    = document.getElementById("stage");
  const svg      = document.getElementById("drawing");
  const gGrid    = document.getElementById("grid");
  const gWorld   = document.getElementById("world");
  const gDraft   = document.getElementById("draft");
  const gSnap    = document.getElementById("snap");
  const gSymbols    = document.getElementById("symbols");
  const gSymOverlay = document.getElementById("symbol-overlay");
  const labelsEl    = document.querySelector(".labels");
  const dimLabelsEl = document.querySelector(".dim-labels");
  const hint     = document.getElementById("hint");
  const dockEl      = document.getElementById("symbol-dock");
  const inspectorEl = document.getElementById("symbol-inspector");

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

  // symbolDimEntry — mirrors dimEntry for symbol w/h chips; getLockAspect bridges lock-aspect state
  initSymbolDimEntry({ stage, dimLabels: dimLabelsEl, getLockAspect });

  // symbolRender — reads symbols.model + selection/ghost state, appends to .dim-labels AFTER wall chips
  initSymbolRender(gSymbols, gSymOverlay, dimLabelsEl, getSelectedId, getPlacementGhost, getEditingDim);

  // symbolTool — placement, selection, inspector
  initSymbolTool({
    stage,
    dock:       dockEl,
    inspector:  inspectorEl,
    setTool,
    isDrawMode,
  });

  // Wire select hooks into interactions (no static symbol import there)
  setSelectHooks({ onDown: onSelectDown, onMove: onSelectMove, onUp: onSelectUp, onTapEmpty });

  // When switching to draw mode, clear symbol selection
  // Wire this by patching setTool: wallTool.setTool is already wired to rail buttons.
  // We intercept mode changes by monitoring the draw-mode toggle via onUnitChange-style hook.
  // The cleanest way: wallTool exports setTool; we wrap onDrawModeEnter there.
  // For now, wallTool.setTool already dispatches to scheduleRender; we hook via a unit-like
  // observer. Instead, main.js re-exports a wrapped version (no cycle since main drives both).
  // The approach: interactions.js now notifies select hooks; but wall mode is driven by wallTool.
  // Simplest: listen to the rail button clicks too.
  document.getElementById("tool-wall")?.addEventListener("click", onDrawModeEnter);
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "w" || e.key === "W") onDrawModeEnter();
  });

  // Register post-render hooks
  // Order: wallRender (in _wallRender) → symbolRenderFn → symbolDimReposition → repositionInspector → dimReposition → measureUpdate
  onRender(symbolRenderFn);
  onRender(symbolDimReposition);
  onRender(repositionInspector);
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

  // ── Actions UI init (wires DOM, no boot logic yet) ─────────────────────────
  initActionsUI({
    actionsCluster: document.getElementById("actions-cluster"),
    btnShare:       document.getElementById("btn-share"),
    btnExport:      document.getElementById("btn-export"),
    btnOverflow:    document.getElementById("btn-overflow"),
    sharePopover:   document.getElementById("share-popover"),
    exportMenu:     document.getElementById("export-menu"),
    overflowMenu:   document.getElementById("overflow-menu"),
    banner:         document.getElementById("restore-banner"),
    statusPill:     document.getElementById("status-pill"),
    fileInput:      document.getElementById("import-file-input"),
  });

  // ── Boot: restore-vs-share decision (runs before first render) ────────────
  await bootActionsUI(W, H);

  // ── Wire autosave hook ────────────────────────────────────────────────────
  onRender(scheduleSave);

  // ── Window resize ──────────────────────────────────────────────────────────
  window.addEventListener("resize", () => {
    resize();
    render();
  });

  // ── First render ───────────────────────────────────────────────────────────
  render();
});
