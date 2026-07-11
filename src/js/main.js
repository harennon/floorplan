/**
 * main.js — application boot / wiring
 *
 * Initialises modules, wires onChange callbacks, and kicks off the first render.
 * This is the only file that knows about all modules.
 */

import { onChange as onViewChange, resetView, fitToContent, view, pxPerM, worldToScreen } from "./view.js";
import { onChange as onUnitChange } from "./units.js";
import { init as initSurface, initWallLayer, onRender, resize, render, scheduleRender, W, H } from "./surface.js";
import { init as initTheme, toggleTheme, getTheme, onThemeChange } from "./theme.js";
import { init as initHud } from "./hud.js";
import { init as initInteractions, setDrawHooks, setSelectHooks, setMeasureHooks, zoomInStep, zoomOutStep, zoomReset } from "./interactions.js";
import { init as initWallRender, render as wallRender } from "./wallRender.js";
import { init as initWallTool, isDrawMode, isMeasureMode, getSnap, onHover, onClick, onLeave, setTool, setHistoryCommit as wallSetHistoryCommit, setToolChangeHook } from "./wallTool.js";
import {
  init as initMeasureTool,
  isMeasureMode as measureToolIsMeasureMode,
  setActive as measureToolSetActive,
  setHistoryCommit as measureToolSetHistoryCommit,
  setToastAndHistory as measureToolSetToastAndHistory,
  setClearRoomSelection as measureToolSetClearRoomSelection,
  setClearSymbolSelection as measureToolSetClearSymbolSelection,
  setIsMeasureMode as measureToolSetIsMeasureMode,
  onHover as measureOnHover, onClick as measureOnClick, onLeave as measureOnLeave,
  onSelectDown as measureOnSelectDown,
  clearSelection as measureClearSelection,
  hasSelection as measureHasSelection,
  deleteSelected as measureDeleteSelected,
  getPendingA as measureGetPendingA,
  getPreviewSnap as measureGetPreviewSnap,
  getSelectedId as measureGetSelectedId,
} from "./measureTool.js";
import { init as initMeasureRender, render as measureRenderFn } from "./measureRender.js";
import { model as measurementsModel } from "./measurements.js";
import { init as initMeasure, update as measureUpdate, getHighlightRoomId } from "./measure.js";
import { init as initDimEntry, reposition as dimReposition, getEditingEdge, setHistoryCommit as dimSetHistoryCommit } from "./dimEntry.js";
import { init as initSymbolRender, render as symbolRenderFn } from "./symbolRender.js";
import { init as initSymbolDimEntry, reposition as symbolDimReposition, getEditingDim, setHistoryCommit as symDimSetHistoryCommit } from "./symbolDimEntry.js";
import { init as initSymbolTool, getSelectedId, getPlacementGhost, onSelectDown, onSelectMove, onSelectUp, onTapEmpty, onDrawModeEnter, getLockAspect, repositionInspector, repositionFlushGuide, hasSelection, deleteSelected, duplicateSelected, setHistoryAndToast, nudgeSelected, rotateSelected, flushNudge, clearSelection as symClearSelection, setClearRoomSelection as symSetClearRoomSelection } from "./symbolTool.js";
import {
  init as initRoomTool,
  onSelectDown as roomOnSelectDown,
  onSelectMove as roomOnSelectMove,
  onSelectUp as roomOnSelectUp,
  onTapEmpty as roomOnTapEmpty,
  onDrawModeEnter as roomOnDrawModeEnter,
  clearSelection as roomClearSelection,
  getSelectedRoomId as roomGetSelectedRoomId,
  setHistoryAndToast as roomSetHistoryAndToast,
  setClearSymbolSelection as roomSetClearSymbolSelection,
} from "./roomTool.js";
import { init as initStore, loadLocal, saveNow } from "./store.js";
import { readBootHash } from "./share.js";
import { applyPlan, isEmptyPlan, serializePlan } from "./plan.js";
import { contentBounds } from "./exportImg.js";
import { init as initActions, showToast, showConflictBanner, setHistoryReset, setOpenTemplates } from "./actions.js";
import { init as initTemplates, open as openTemplates } from "./templates.js";
import { model as wallsModel } from "./walls.js";
import { getSymbol } from "./symbols.js";
import { init as initHistory, reset as historyReset, commit as historyCommit, undo as historyUndo, redo as historyRedo, canUndo, canRedo, depth as historyDepth, onChange as historyOnChange } from "./history.js";
import { init as initHelp } from "./help.js";
import { initDockTabs } from "./dockTabs.js";
import { onSnapModeChange, snapStep } from "./grid.js";
import { init as initClearanceRender, render as clearanceRenderFn } from "./clearanceRender.js";
import { init as initClearancePanel, update as clearancePanelUpdate } from "./clearancePanel.js";
import { onChange as onClearanceChange, setEnabled as setClearanceEnabled } from "./clearance.js";
import { init as initLoupe, setViewModule as loupeSetViewModule, reposition as loupeReposition } from "./loupe.js";
import { toggleGridSnap } from "./prefs.js";
import { init as initOnboarding, maybeShow as onboardingMaybeShow, dismiss as onboardingDismiss } from "./onboarding.js";

/** Detect macOS for platform-correct tooltip chords. */
const _isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

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
  const gMeasure    = document.getElementById("measure");
  const gSymOverlay = document.getElementById("symbol-overlay");
  const labelsEl    = document.querySelector(".labels");
  const dimLabelsEl = document.querySelector(".dim-labels");
  const hint     = document.getElementById("hint");
  const dockEl      = document.getElementById("symbol-dock");
  const inspectorEl = document.getElementById("symbol-inspector");

  // HUD
  const elZoom           = document.getElementById("hud-zoom");
  const elScale          = document.getElementById("hud-scale");
  const elCursor         = document.getElementById("hud-cursor");
  const elUnitImp        = document.getElementById("unit-imperial");
  const elUnitMet        = document.getElementById("unit-metric");
  const elHudSnap        = document.getElementById("hud-snap-val");
  const elSnapModeBtn    = document.getElementById("hud-snap-mode");
  const elGridToggleBtn  = document.getElementById("hud-grid-toggle");

  // Zoom buttons
  const btnZoomIn  = document.getElementById("btn-zoom-in");
  const btnZoomOut = document.getElementById("btn-zoom-out");
  const btnReset   = document.getElementById("btn-zoom-reset");

  // Tool rail
  const snapTagEl    = document.querySelector(".snap-tag");
  const btnSelect    = document.getElementById("tool-select");
  const btnWall      = document.getElementById("tool-wall");
  const btnMeasure   = document.getElementById("tool-measure");
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

  // Clearance inspector
  const clearancePanel  = document.querySelector(".clearance");
  const clearanceBody   = document.getElementById("clr-body");
  const clearanceToggle = document.querySelector(".clr-toggle");
  const clearanceSwitch = document.querySelector(".clr-enable-switch");
  const gClearance      = document.getElementById("clearance");

  // Persistence / share DOM refs
  const savePillEl     = document.getElementById("save-pill");
  const btnShare       = document.getElementById("btn-share");
  const btnExport      = document.getElementById("btn-export");
  const btnOverflow    = document.getElementById("btn-overflow");
  const exportMenuEl   = document.getElementById("export-menu");
  const overflowMenuEl = document.getElementById("overflow-menu");
  const toastEl        = document.getElementById("toast");
  const bannerEl       = document.getElementById("conflict-banner");

  // History undo/redo rail buttons + help button (LLD-21)
  const btnHistoryUndo = document.getElementById("history-undo");
  const btnHistoryRedo = document.getElementById("history-redo");
  const btnHelp        = document.getElementById("btn-help");
  const helpOverlayEl  = document.getElementById("help-overlay");

  // Theme toggle button
  const btnThemeToggle = document.getElementById("btn-theme-toggle");

  // ── Theme init (must run before first render) ──────────────────────────────
  initTheme();

  // ── Initialise modules ─────────────────────────────────────────────────────
  initSurface(stage, svg, gGrid, gWorld);
  initHud(elZoom, elScale, elCursor, elUnitImp, elUnitMet, elSnapModeBtn, elGridToggleBtn);

  // wallRender binds mount points + injected getters
  initWallRender(gWorld, gDraft, gSnap, labelsEl, dimLabelsEl, getSnap, getHighlightRoomId, getEditingEdge, roomGetSelectedRoomId);

  // wallTool binds rail, hud, keyboard
  initWallTool({
    hudSnap:     elHudSnap,
    snapTag:     snapTagEl,
    btnSelect,
    btnWall,
    btnMeasure,
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

  // measureTool — interaction + selection controller
  initMeasureTool({ stage, snapTag: snapTagEl });
  // Inject isMeasureMode into measureTool (avoid circular wallTool→measureTool import)
  measureToolSetIsMeasureMode(isMeasureMode);
  // Wire tool-change hook so leaving measure mode cancels any pending placement
  setToolChangeHook((t) => measureToolSetActive(t === "measure"));

  // Inject measure hooks into interactions
  setMeasureHooks({
    isMeasureMode: measureToolIsMeasureMode,
    onHover: measureOnHover,
    onClick: measureOnClick,
    onLeave: measureOnLeave,
  });

  initInteractions(stage, hint, btnZoomIn, btnZoomOut, btnReset);

  // Magnifier loupe (LLD 57) — visual affordance for touch drawing
  initLoupe(stage, svg);
  loupeSetViewModule({ view, pxPerM, worldToScreen });

  // Measure inspector
  initMeasure({ panel: measurePanel, list: measureList, total: measureTotal, toggle: measureToggle });

  // Clearance render — reads selected id + symbol, paints into #clearance + .dim-labels
  initClearanceRender(gClearance, dimLabelsEl, getSelectedId, getSymbol);

  // Clearance panel — sorted gap list, verdict, slider, density, on/off
  if (clearancePanel && clearanceBody) {
    initClearancePanel({
      panel:         clearancePanel,
      body:          clearanceBody,
      toggle:        clearanceToggle,
      getSelectedId,
      getSymbol,
    });
  }

  // Wire the enable switch (defined in HTML, wired here)
  if (clearanceSwitch) {
    clearanceSwitch.addEventListener("click", () => {
      const next = clearanceSwitch.getAttribute("aria-pressed") !== "true";
      setClearanceEnabled(next);
      scheduleRender();
    });
  }

  // dimEntry (handles its own pointer-isolation and unit-cancel binding internally)
  initDimEntry({ stage, dimLabels: dimLabelsEl });

  // symbolDimEntry — mirrors dimEntry for symbol w/h chips; getLockAspect bridges lock-aspect state
  initSymbolDimEntry({ stage, dimLabels: dimLabelsEl, getLockAspect });

  // symbolRender — reads symbols.model + selection/ghost state, appends to .dim-labels AFTER wall chips
  initSymbolRender(gSymbols, gSymOverlay, dimLabelsEl, getSelectedId, getPlacementGhost, getEditingDim);

  // measureRender — distance annotation lines/ticks/chips, appends to .dim-labels AFTER symbol chips
  if (gMeasure) {
    initMeasureRender(
      gMeasure,
      dimLabelsEl,
      () => measurementsModel.measurements,
      measureGetSelectedId,
      measureGetPendingA,
      measureGetPreviewSnap,
    );
  }

  // symbolTool — placement, selection, inspector
  initSymbolTool({
    stage,
    dock:        dockEl,
    inspector:   inspectorEl,
    setTool,
    isDrawMode,
    snapTag:     snapTagEl,
    symOverlay:  gSymOverlay,
  });

  // roomTool — room selection + whole-room move-drag (LLD 63)
  initRoomTool({ stage });

  // Dock category tabs (session-only UI state; no persistence)
  if (dockEl) initDockTabs(dockEl);

  // Wire select hooks into interactions (no static symbol/room import there).
  // Dispatcher composes symbolTool + roomTool over the one Select tool: symbols
  // win ties, else rooms; selections are mutually exclusive (LLD 63 HIGH fix).
  let _activeSelectOwner = null; // "symbol" | "measure" | "room" | null
  setSelectHooks({
    onDown(sx, sy) {
      // Symbol wins ties (checked first)
      if (onSelectDown(sx, sy)) {
        roomClearSelection();          // MUTEX: picking a symbol drops the room
        measureClearSelection();       // MUTEX: picking a symbol drops the measure
        _activeSelectOwner = "symbol";
        return true;
      }
      // Measurement: checked before room (line hit-test is narrow, beats room interior)
      if (measureOnSelectDown(sx, sy)) {
        symClearSelection();           // MUTEX: picking a measure drops the symbol
        roomClearSelection();          // MUTEX: picking a measure drops the room
        _activeSelectOwner = "measure";
        return true;
      }
      if (roomOnSelectDown(sx, sy)) {  // roomTool clears the symbol selection itself
        measureClearSelection();       // MUTEX: picking a room drops the measure
        _activeSelectOwner = "room";
        return true;
      }
      _activeSelectOwner = null;
      return false;                    // miss: neither selection changes
    },
    onMove(sx, sy) {
      if (_activeSelectOwner === "symbol") onSelectMove(sx, sy);
      else if (_activeSelectOwner === "room") roomOnSelectMove(sx, sy);
      // measure: no-op move (fixed endpoints this phase)
    },
    onUp(sx, sy) {
      if (_activeSelectOwner === "symbol") onSelectUp(sx, sy);
      else if (_activeSelectOwner === "room") roomOnSelectUp(sx, sy);
      _activeSelectOwner = null;
    },
    onTapEmpty() {
      onTapEmpty();
      roomOnTapEmpty();
      measureClearSelection(); // clear measurement selection on empty tap
      scheduleRender();
    },
  });

  // Wire the mutex injection so roomTool can drop the symbol selection without
  // importing symbolTool (mirrors the history/toast injection pattern).
  roomSetClearSymbolSelection(symClearSelection);
  // And the reverse: any symbol selection (incl. dock drag-drop placement, which
  // bypasses the dispatcher via selectSymbol) drops a live room selection.
  symSetClearRoomSelection(roomClearSelection);
  // Measurement mutex injections: selecting a symbol clears measure selection
  measureToolSetClearRoomSelection(roomClearSelection);
  measureToolSetClearSymbolSelection(symClearSelection);

  // When switching to draw mode, clear symbol, room, and measure selection
  document.getElementById("tool-wall")?.addEventListener("click", () => {
    onDrawModeEnter();
    roomOnDrawModeEnter();
    measureClearSelection();
  });
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "w" || e.key === "W") {
      onDrawModeEnter();
      roomOnDrawModeEnter();
      measureClearSelection();
    }
  });

  // Register post-render hooks
  // Order: wallRender (in _wallRender) → symbolRenderFn → clearanceRenderFn →
  //        symbolDimReposition → repositionInspector → dimReposition →
  //        measureUpdate → clearancePanelUpdate → loupeReposition
  onRender(symbolRenderFn);
  onRender(measureRenderFn);      // distance annotations above furniture, below selection overlay
  onRender(repositionFlushGuide); // re-append guide line after symbolRender clears overlay
  onRender(clearanceRenderFn);   // leaders above symbol bodies, below #symbol-overlay
  onRender(symbolDimReposition);
  onRender(repositionInspector);
  onRender(measureUpdate);
  onRender(clearancePanelUpdate);
  onRender(dimReposition);
  onRender(loupeReposition);     // loupe content stays aligned after pan/zoom

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

  // ── Theme toggle (LLD-58) ─────────────────────────────────────────────────
  /** Update toggle button label + aria to reflect the current theme. */
  function _updateThemeToggle(theme) {
    if (!btnThemeToggle) return;
    if (theme === "light") {
      btnThemeToggle.textContent = "☽";
      btnThemeToggle.setAttribute("aria-label", "Switch to dark mode");
      btnThemeToggle.setAttribute("aria-pressed", "true");
    } else {
      btnThemeToggle.textContent = "☀";
      btnThemeToggle.setAttribute("aria-label", "Switch to light mode");
      btnThemeToggle.setAttribute("aria-pressed", "false");
    }
  }
  // Sync button to persisted theme on load
  _updateThemeToggle(getTheme());

  if (btnThemeToggle) {
    btnThemeToggle.addEventListener("click", () => {
      const next = toggleTheme();
      _updateThemeToggle(next);
      scheduleRender();
    });
  }

  // Keep toggle label in sync if theme is changed programmatically
  onThemeChange(_updateThemeToggle);

  // ── History (LLD-21) ──────────────────────────────────────────────────────
  // Wire history.reset into actions.js so _confirmReset can call it
  setHistoryReset(historyReset);

  // Wire history.commit into tool modules (injection to avoid circular imports)
  wallSetHistoryCommit(historyCommit);
  measureToolSetHistoryCommit(historyCommit);
  measureToolSetToastAndHistory(showToast, { undo: historyUndo, depth: historyDepth });
  symDimSetHistoryCommit(historyCommit);
  dimSetHistoryCommit(historyCommit); // wall-edge resize (dimEntry.js)

  // Wire history + showToast into symbolTool
  setHistoryAndToast(
    { commit: historyCommit, undo: historyUndo, depth: historyDepth },
    showToast,
  );

  // Wire history + showToast into roomTool (LLD 63)
  roomSetHistoryAndToast({ commit: historyCommit }, showToast);

  // Seed history baseline (must run before first render)
  initHistory();

  // Rail undo/redo buttons
  if (btnHistoryUndo) {
    btnHistoryUndo.addEventListener("click", () => {
      if (historyUndo()) scheduleRender();
    });
  }
  if (btnHistoryRedo) {
    btnHistoryRedo.addEventListener("click", () => {
      if (historyRedo()) scheduleRender();
    });
  }

  /** Refresh rail button disabled state after any history stack change. */
  function _updateHistoryButtons() {
    if (btnHistoryUndo) btnHistoryUndo.disabled = !canUndo();
    if (btnHistoryRedo) btnHistoryRedo.disabled = !canRedo();
  }
  historyOnChange(_updateHistoryButtons);
  _updateHistoryButtons();

  // Set platform-correct tooltips for undo/redo buttons + symbol inspector
  const _mod = _isMac ? "⌘" : "Ctrl+";
  const _shift = _isMac ? "⇧" : "Shift+";
  if (btnHistoryUndo) btnHistoryUndo.title = `Undo (${_mod}Z)`;
  if (btnHistoryRedo) btnHistoryRedo.title = `Redo (${_shift}${_mod}Z)`;
  // Add tooltips to inspector duplicate/delete buttons
  const inspDuplicate = document.querySelector("#symbol-inspector [data-action='duplicate']");
  const inspDelete    = document.querySelector("#symbol-inspector [data-action='delete']");
  if (inspDuplicate) inspDuplicate.title = `Duplicate (${_mod}D)`;
  if (inspDelete)    inspDelete.title    = "Delete (Del)";

  // ── Global editing keyboard shortcuts (LLD-21, extended LLD-54) ──────────────
  window.addEventListener("keydown", (e) => {
    // Guard: ignore when focus is in an editable element
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    const meta  = e.ctrlKey || e.metaKey;

    // Undo: Ctrl/Cmd+Z (without Shift) — accept both cases so Caps Lock doesn't break it
    if (meta && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      flushNudge(); // flush pending nudge before undo so stack ordering is correct
      if (historyUndo()) scheduleRender();
      return;
    }

    // Redo: Ctrl/Cmd+Shift+Z or Ctrl+Y — accept both cases so Caps Lock doesn't break it
    if (meta && e.shiftKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      flushNudge(); // flush pending nudge before redo
      if (historyRedo()) scheduleRender();
      return;
    }
    if (meta && !e.shiftKey && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      flushNudge(); // flush pending nudge before redo
      if (historyRedo()) scheduleRender();
      return;
    }

    // Duplicate: Ctrl/Cmd+D — only when a symbol is selected (Edge Case 6)
    if (meta && (e.key === "d" || e.key === "D")) {
      if (hasSelection()) {
        e.preventDefault();
        duplicateSelected(); // duplicateSelected flushes nudge internally
      }
      // If nothing selected: do NOT preventDefault → browser bookmark allowed
      return;
    }

    // Delete/Backspace — single owner (GAP-1 resolution, Edge Case 5)
    // If in draw mode with an active chain: do nothing here; the event bubbles
    // to wallTool._onKeyDown which removes the last chain vertex (undoPoint).
    // If in select mode (or draw mode with no chain) and a symbol is selected:
    // consume the event and delegate to the committing deleteSelected().
    // If a measurement is selected: delete it.
    if (e.key === "Delete" || e.key === "Backspace") {
      if (isDrawMode() && wallsModel.chain.length > 0) {
        // Let wallTool bubble-phase listener handle vertex removal
        return;
      }
      if (hasSelection()) {
        e.preventDefault();
        deleteSelected(); // deleteSelected flushes nudge internally
        return;
      }
      if (measureHasSelection()) {
        e.preventDefault();
        measureDeleteSelected();
      }
      return;
    }

    // Esc — deselect selected symbol/measurement (LLD-54 extension).
    // help.js capture-phase listener stops propagation when overlay is open, so
    // this branch only fires when the overlay is already closed.
    // wallTool handles Esc for active wall chains in its own bubble-phase listener
    // (registered earlier); it does not stopPropagation, so we still receive the
    // event — but we must not deselect when wallTool is about to finish a chain.
    // measureTool handles Esc for in-progress placement in its own bubble-phase
    // listener; this branch handles deselect of a committed measurement.
    if (!meta && e.key === "Escape") {
      if (isDrawMode() && wallsModel.chain.length > 0) {
        // Let wallTool bubble-phase listener handle chain finish/cancel
        return;
      }
      if (isMeasureMode()) {
        // measureTool's own listener handles in-progress cancel (pendingA set).
        // If no pendingA, nothing to do in measure mode here.
        return;
      }
      if (hasSelection() || measureHasSelection()) {
        e.preventDefault();
        flushNudge(); // commit any pending nudge before clearing selection
        onTapEmpty(); // clears symbol + inspector
        measureClearSelection(); // clears measure selection
        scheduleRender();
      }
      return;
    }

    // ── New shortcuts (LLD-54) ─────────────────────────────────────────────────

    // Nudge — bare/Shift arrows, only when a symbol is selected and not a chord
    if (!meta && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      if (!hasSelection()) return; // let native scroll happen if nothing selected
      e.preventDefault();
      const base = snapStep() ?? 0.1; // grid step, fallback 0.1m when snap is off
      const step = e.shiftKey ? base * 4 : base;
      let dx = 0, dy = 0;
      if (e.key === "ArrowUp")    dy = -step;
      if (e.key === "ArrowDown")  dy =  step;
      if (e.key === "ArrowLeft")  dx = -step;
      if (e.key === "ArrowRight") dx =  step;
      nudgeSelected(dx, dy);
      return;
    }

    // Rotate — R (Shift+R = CCW), only with a selection, not a chord
    if (!meta && (e.key === "r" || e.key === "R")) {
      if (!hasSelection()) return;
      e.preventDefault();
      rotateSelected(e.shiftKey ? -90 : 90); // rotateSelected flushes nudge internally
      return;
    }

    // Zoom — + / = (in), - / _ (out), 0 (reset), Shift+1 = fit (US layout: "!")
    if (!meta && (e.key === "+" || e.key === "=")) { e.preventDefault(); zoomInStep();  return; }
    if (!meta && (e.key === "-" || e.key === "_")) { e.preventDefault(); zoomOutStep(); return; }
    if (!meta && e.key === "0")                    { e.preventDefault(); zoomReset();   return; }
    if (!meta && e.key === "!") {  // Shift+1 on US layouts produces "!"
      e.preventDefault();
      const b = contentBounds();
      if (b) {
        fitToContent(b, W, H);
      } else {
        resetView(W, H);
      }
      scheduleRender();
      return;
    }

    // Snap toggle — S flips persistent gridSnap pref (coordinate w/ #29)
    // Only when not a chord (Cmd+S = browser save must pass through)
    if (!meta && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      const on = toggleGridSnap();
      showToast(on ? "Snapping on" : "Snapping off");
      scheduleRender();
      return;
    }
  });

  // ── Help overlay (LLD-21) ─────────────────────────────────────────────────
  if (btnHelp && helpOverlayEl) {
    initHelp({ button: btnHelp, overlay: helpOverlayEl });
  }

  // ── Template gallery (LLD-43) ──────────────────────────────────────────────
  const templateOverlayEl = document.getElementById("template-overlay");
  const templateGridEl    = templateOverlayEl?.querySelector(".template-grid");
  const templateCloseBtnEl = templateOverlayEl?.querySelector(".template-overlay-close");
  const emptyCtaEl        = document.getElementById("empty-cta");

  if (templateOverlayEl && templateGridEl && templateCloseBtnEl) {
    // The apply callback encapsulates the full load sequence so templates.js
    // needs no direct imports of history/view/surface.
    initTemplates({
      overlay:  templateOverlayEl,
      grid:     templateGridEl,
      closeBtn: templateCloseBtnEl,
      emptyCta: emptyCtaEl,
      apply: (plan) => {
        saveNow();
        applyPlan(plan);
        historyReset();
        const bounds = contentBounds();
        if (bounds) {
          fitToContent(bounds, W, H);
        } else {
          resetView(W, H);
        }
        render();
      },
      isEmpty: isEmptyPlan,
      toast:   showToast,
    });
  }

  // ── Onboarding coach-marks (LLD-60) ───────────────────────────────────────
  const onboardingEl  = document.getElementById("onboarding");
  const coachWallEl   = document.getElementById("coach-wall");
  const coachTmplEl   = document.getElementById("coach-template");
  const coachDismiss  = document.getElementById("coach-dismiss");

  if (onboardingEl && coachWallEl && coachTmplEl && coachDismiss && btnWall) {
    initOnboarding({
      container:   onboardingEl,
      wallTip:     coachWallEl,
      templateTip: coachTmplEl,
      dismissBtn:  coachDismiss,
      stage,
      wallBtn:     btnWall,
      emptyCta:    emptyCtaEl || undefined,
      isEmpty:     isEmptyPlan,
    });
  }

  // Wire openTemplates into actions.js overflow handler.
  // Wrap with onboardingDismiss so the overflow "Start from a template" path
  // (LLD-60 Edge Case 8 / Frontend Design §Entry/dismissal wiring) also
  // dismisses coach-marks — the same dismissal set as #empty-cta click.
  setOpenTemplates(() => {
    onboardingDismiss();
    openTemplates();
  });

  // Register onRender hook to keep #empty-cta visibility in sync
  if (emptyCtaEl) {
    onRender(() => {
      emptyCtaEl.hidden = !isEmptyPlan();
    });
  }

  // Default measure inspector to collapsed on narrow screens (Edge Case 13)
  if (window.matchMedia("(max-width: 640px)").matches) {
    measurePanel.classList.add("measure--collapsed");
    measureToggle.textContent = "▸";
    measureToggle.setAttribute("aria-expanded", "false");
    // Also default clearance panel to collapsed on mobile
    if (clearancePanel && clearanceToggle) {
      clearancePanel.classList.add("clearance--collapsed");
      clearanceToggle.textContent = "▸";
      clearanceToggle.setAttribute("aria-expanded", "false");
    }
  }

  // ── Wire re-render on view / unit / snap-mode / clearance-state changes ──
  onViewChange(scheduleRender);
  onUnitChange(scheduleRender);
  // Snap mode change: reschedule render so live placement ghosts re-snap on next move
  onSnapModeChange(scheduleRender);
  // Clearance state change (threshold / density / enabled) triggers re-render
  onClearanceChange(scheduleRender);

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
        historyReset(); // reseed baseline after restore (Edge Case 12)
        if (toastEl) showToast("Restored your last plan");
        render();
      } else {
        // Conflict: hash present AND differs from local. A present hash is explicit
        // user intent — auto-open the shared plan, offer a one-tap undo to local.
        const applyShared = () => {
          applyPlan(hashPlan);
          historyReset(); // reseed baseline after restore (Edge Case 12)
          const bounds = contentBounds();
          if (bounds) fitToContent(bounds, vW, vH); else resetView(vW, vH);
        };
        const applyLocal = () => {
          applyPlan(localPlan);
          historyReset(); // reseed baseline after restore (Edge Case 12)
          render();
        };
        applyShared();
        render();
        showToast("Opened shared plan", {
          label: "Keep my last plan instead",
          onClick: applyLocal,
        });
        return;
      }
    } else if (hashPlan) {
      // Only hash plan: apply with fit-to-content
      applyPlan(hashPlan);
      historyReset(); // reseed baseline after restore (Edge Case 12)
      const bounds = contentBounds();
      if (bounds) {
        fitToContent(bounds, vW, vH);
      } else {
        resetView(vW, vH);
      }
      if (toastEl) showToast("Opened shared plan");
      render();
    } else if (localPlan) {
      // Only local plan: restore verbatim (view included)
      applyPlan(localPlan);
      historyReset(); // reseed baseline after restore (Edge Case 12)
      if (toastEl) showToast("Restored your last plan");
      render();
    } else {
      // Empty start: use default frame
      resetView(vW, vH);
      render();
      // Show first-run coach-marks only on an empty start (LLD-60)
      if (onboardingEl && coachWallEl && coachTmplEl && coachDismiss) {
        onboardingMaybeShow();
      }
    }
  })();

  // ── Window resize ──────────────────────────────────────────────────────────
  window.addEventListener("resize", () => {
    resize();
    render();
  });
});
