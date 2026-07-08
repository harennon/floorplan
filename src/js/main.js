/**
 * main.js — application boot / wiring
 *
 * Initialises modules, wires onChange callbacks, and kicks off the first render.
 * This is the only file that knows about all modules.
 */

import { onChange as onViewChange, resetView } from "./view.js";
import { onChange as onUnitChange } from "./units.js";
import { init as initSurface, initWallLayer, onRender, resize, render, scheduleRender, W, H } from "./surface.js";
import { init as initHud } from "./hud.js";
import { init as initInteractions, setDrawHooks, setSelectHooks } from "./interactions.js";
import { init as initWallRender, render as wallRender } from "./wallRender.js";
import { init as initWallTool, isDrawMode, getSnap, onHover, onClick, onLeave, setTool } from "./wallTool.js";
import { init as initMeasure, update as measureUpdate, getHighlightRoomId } from "./measure.js";
import { init as initDimEntry, reposition as dimReposition, getEditingEdge } from "./dimEntry.js";
import { init as initSymbolRender, render as symbolRenderFn } from "./symbolRender.js";
import { init as initSymbolDimEntry, reposition as symbolDimReposition, getEditingDim } from "./symbolDimEntry.js";
import { init as initSymbolTool, getSelectedId, getPlacementGhost, onSelectDown, onSelectMove, onSelectUp, onTapEmpty, onDrawModeEnter, getLockAspect, repositionInspector, deselect as symbolDeselect } from "./symbolTool.js";
import { init as initStore, loadLocal } from "./store.js";
import { readBootHash } from "./share.js";
import { applyPlan, isEmptyPlan, serializePlan } from "./plan.js";
import { contentBounds } from "./exportImg.js";
import { fitToContent } from "./view.js";
import { init as initActions, showToast, showConflictBanner, setHistoryReset } from "./actions.js";
import { init as initHistory, reset as historyReset } from "./history.js";
import { setOnApplied } from "./exportJson.js";

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
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

  // History undo/redo rail buttons + help button + cheat-sheet overlay
  const btnHistoryUndo = document.getElementById("history-undo");
  const btnHistoryRedo = document.getElementById("history-redo");
  const btnHelp        = document.getElementById("btn-help");
  const sheetEl        = document.getElementById("shortcut-sheet");
  const sheetCloseEl   = document.getElementById("shortcut-sheet-close");

  // Persistence / share DOM refs
  const savePillEl     = document.getElementById("save-pill");
  const btnShare       = document.getElementById("btn-share");
  const btnExport      = document.getElementById("btn-export");
  const btnOverflow    = document.getElementById("btn-overflow");
  const exportMenuEl   = document.getElementById("export-menu");
  const overflowMenuEl = document.getElementById("overflow-menu");
  const toastEl        = document.getElementById("toast");
  const bannerEl       = document.getElementById("conflict-banner");

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

  // Initialise store (save pill + autosave hook)
  if (savePillEl) {
    initStore(savePillEl);
  }

  // Initialise actions cluster
  if (btnShare) {
    initActions({
      btnShare,
      btnExport,
      btnOverflow,
      exportMenu:   exportMenuEl,
      overflowMenu: overflowMenuEl,
      toast:        toastEl,
      banner:       bannerEl,
    });
  }

  // Initialise history (undo/redo, cheat sheet, keyboard shortcuts)
  initHistory({
    btnUndo:   btnHistoryUndo,
    btnRedo:   btnHistoryRedo,
    btnHelp,
    sheet:     sheetEl,
    sheetClose: sheetCloseEl,
    onAfterRestore: () => {
      // Clear symbol selection/inspector (the restored doc may not have the selected id)
      symbolDeselect();
    },
  });

  // Wire history.reset into actions.js (for synchronous Reset confirm path)
  setHistoryReset(historyReset);

  // Wire history.reset into importJson's async after-apply hook
  setOnApplied(historyReset);

  // Default measure inspector to collapsed on narrow screens (Edge Case 13)
  if (window.matchMedia("(max-width: 640px)").matches) {
    measurePanel.classList.add("measure--collapsed");
    measureToggle.textContent = "▸";
    measureToggle.setAttribute("aria-expanded", "false");
  }

  // ── Wire re-render on view / unit changes ──────────────────────────────────
  onViewChange(scheduleRender);
  onUnitChange(scheduleRender);

  // ── Initial size (always) ──────────────────────────────────────────────────
  // CRITICAL: resize() must always run first (measures viewport).
  // resetView() must NOT run unconditionally — it would clobber any restored view.
  const { W: vW, H: vH } = resize();

  // ── Boot restore (LLD 16) ──────────────────────────────────────────────────
  // readBootHash() is async, so we do all boot-restore work in an async IIFE.
  (async () => {
    let hashPlan = null;
    try {
      hashPlan = await readBootHash();
    } catch {
      showToast("That share link couldn't be opened.");
    }

    const localPlan = loadLocal();

    if (hashPlan && localPlan) {
      // Both present: check if they differ
      const hashSer = serializePlan(hashPlan);
      const localSer = serializePlan(localPlan);

      if (hashSer === localSer) {
        // Identical: treat as local restore (no banner)
        applyPlan(localPlan);
        historyReset();
        if (toastEl) showToast("Restored your last plan");
        render();
      } else {
        // Conflict: show banner-with-choice; apply nothing yet
        showConflictBanner(hashPlan, localPlan, (choice) => {
          if (choice === "shared") {
            applyPlan(hashPlan);
            const bounds = contentBounds();
            if (bounds) {
              fitToContent(bounds, vW, vH);
            } else {
              resetView(vW, vH);
            }
            if (toastEl) showToast("Opened shared plan");
          } else {
            applyPlan(localPlan);
          }
          historyReset();
          render();
        });
        // Don't call render yet — banner choice will trigger it
        return;
      }
    } else if (hashPlan) {
      // Only hash plan: apply with fit-to-content
      applyPlan(hashPlan);
      const bounds = contentBounds();
      if (bounds) {
        fitToContent(bounds, vW, vH);
      } else {
        resetView(vW, vH);
      }
      historyReset();
      if (toastEl) showToast("Opened shared plan");
      render();
    } else if (localPlan) {
      // Only local plan: restore verbatim (view included)
      applyPlan(localPlan);
      historyReset();
      if (toastEl) showToast("Restored your last plan");
      render();
    } else {
      // Empty start: use default frame
      resetView(vW, vH);
      historyReset();
      render();
    }
  })();

  // ── Window resize ──────────────────────────────────────────────────────────
  window.addEventListener("resize", () => {
    resize();
    render();
  });
});
