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
import { init as initWallTool, isDrawMode, getSnap, onHover, onClick, onLeave, setTool, setHistoryCommit as wallSetHistoryCommit } from "./wallTool.js";
import { init as initMeasure, update as measureUpdate, getHighlightRoomId, setSelectedRoomAccessor as measureSetSelectedRoomAccessor, setHistoryCommit as measureSetHistoryCommit } from "./measure.js";
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
  hasSelection as roomHasSelection,
  nudgeSelected as roomNudgeSelected,
  flushNudge as roomFlushNudge,
  setHistoryAndToast as roomSetHistoryAndToast,
  setClearSymbolSelection as roomSetClearSymbolSelection,
  repositionRoomInspector,
} from "./roomTool.js";
import { init as initStore, loadLocal, saveNow } from "./store.js";
import { readBootHash, encodeShareHash } from "./share.js";
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
import {
  init as initMeasureTool,
  setHistoryCommit as measureToolSetHistoryCommit,
  setClearOtherSelections as measureSetClearOtherSelections,
  isActive as measureIsActive,
  activate as measureActivate,
  deactivate as measureDeactivate,
  onMeasureDown,
  onMeasureMove,
  onMeasureLeave,
  getDraft,
  getSelectedMeasurementId,
  onSelectDown as measureOnSelectDown,
  onSelectMove as measureOnSelectMove,
  onSelectUp as measureOnSelectUp,
  clearSelection as measureClearSelection,
  hasSelection as measureHasSelection,
  deleteSelected as measureDeleteSelected,
  onTapEmpty as measureOnTapEmpty,
} from "./measureTool.js";
import { init as initMeasureRender, render as measureRenderFn } from "./measureRender.js";
import { model as measurementsModel } from "./measurements.js";
import { init as initLoupe, setViewModule as loupeSetViewModule, reposition as loupeReposition } from "./loupe.js";
import { toggleGridSnap } from "./prefs.js";
import { init as initOnboarding, maybeShow as onboardingMaybeShow, dismiss as onboardingDismiss } from "./onboarding.js";
import { isActive as previewIsActive, setActive as previewSetActive, toggle as previewToggle, onChange as previewOnChange } from "./preview.js";
import { initIsoRender, render as isoRenderFn } from "./isoRender.js";
import * as render3d from "./render3d.js";
import * as _wallsModRef from "./walls.js";
import * as _symbolsModRef from "./symbols.js";

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
  const gRugs       = document.getElementById("rugs");
  const gSymbols    = document.getElementById("symbols");
  const gSymOverlay = document.getElementById("symbol-overlay");
  const labelsEl    = document.querySelector(".labels");
  const dimLabelsEl = document.querySelector(".dim-labels");
  const hint     = document.getElementById("hint");
  const dockEl           = document.getElementById("symbol-dock");
  const inspectorEl      = document.getElementById("symbol-inspector");
  const symSwatchStripEl = document.getElementById("sym-swatch-strip");
  const roomInspectorEl  = document.getElementById("room-inspector");
  const roomSwatchStripEl = document.getElementById("room-swatch-strip");

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

  // Measure SVG group
  const gMeasure = document.getElementById("measure");

  // Measure inspector
  const measurePanel  = document.querySelector(".measure");
  const measureList   = document.querySelector(".measure-list");
  const measureTotal  = document.querySelector(".measure-total-val");
  const measureToggle = document.querySelector(".measure-toggle");

  // W×H block (LLD 82)
  const measureWxhBox   = document.querySelector(".measure-wxh");
  const measureWxhW     = document.querySelector(".measure-wxh-w");
  const measureWxhH     = document.querySelector(".measure-wxh-h");
  const measureWxhUnit  = document.querySelector(".measure-wxh-unit");
  const measureWxhApply = document.querySelector(".measure-wxh-apply");

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

  // 3D preview (LLD 128 / LLD 130)
  const gIso            = document.getElementById("iso");
  const btnPreview      = document.getElementById("tool-preview");
  const canvas3d        = document.getElementById("stage3d");
  const previewLoadingEl = document.getElementById("preview-loading");

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
    btnUndo,
    btnFinish,
    stage,
    rail:         railEl,
    railToggle:   railToggleEl,
    railCollapse: railCollapseEl,
  });

  // Wire W×H accessor + history.commit into measure (LLD 82).
  // Must run after roomTool is available (roomGetSelectedRoomId) and after
  // history is available (historyCommit). These are module-level imports so
  // they are available immediately; wiring is deferred to after initMeasure()
  // but the actual injection can be placed anywhere before first render.
  // We do it here (early boot) to keep injections grouped near their consumers.
  measureSetSelectedRoomAccessor(roomGetSelectedRoomId);
  // historyCommit injection happens below alongside other history wiring.

  // Wire wall render into surface loop
  initWallLayer(gDraft, gSnap, labelsEl, wallRender);

  // Inject draw hooks into interactions (no static wall import there)
  setDrawHooks({
    isDrawMode,
    onHover(sx, sy, pt) { if (!previewIsActive()) onHover(sx, sy, pt); },
    onClick(sx, sy) { if (!previewIsActive()) onClick(sx, sy); },
    onLeave,
  });

  initInteractions(stage, hint, btnZoomIn, btnZoomOut, btnReset);

  // Magnifier loupe (LLD 57) — visual affordance for touch drawing
  initLoupe(stage, svg);
  loupeSetViewModule({ view, pxPerM, worldToScreen });

  // Measure inspector
  initMeasure({
    panel:    measurePanel,
    list:     measureList,
    total:    measureTotal,
    toggle:   measureToggle,
    wxhBox:   measureWxhBox,
    wxhW:     measureWxhW,
    wxhH:     measureWxhH,
    wxhUnit:  measureWxhUnit,
    wxhApply: measureWxhApply,
  });

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
  initSymbolRender(gRugs, gSymbols, gSymOverlay, dimLabelsEl, getSelectedId, getPlacementGhost, getEditingDim);

  // symbolTool — placement, selection, inspector
  initSymbolTool({
    stage,
    dock:         dockEl,
    inspector:    inspectorEl,
    swatchStrip:  symSwatchStripEl,
    setTool,
    isDrawMode,
    snapTag:      snapTagEl,
    symOverlay:   gSymOverlay,
  });

  // roomTool — room selection + whole-room move-drag (LLD 63)
  initRoomTool({
    stage,
    roomInspector:    roomInspectorEl,
    roomSwatchStrip:  roomSwatchStripEl,
  });

  // measureTool — measure mode, two-click placement, select/delete (LLD 92)
  initMeasureTool({ stage, btnMeasure, btnSelect, btnWall, snapTag: snapTagEl });

  // Dock category tabs (session-only UI state; no persistence)
  if (dockEl) initDockTabs(dockEl);

  // Wire select hooks into interactions (no static symbol/room/measure import there).
  // Dispatcher composes symbolTool + roomTool + measureTool over the one Select tool:
  // symbols win ties, else rooms, else measurements (lowest priority).
  // Selections are mutually exclusive (LLD 63 HIGH fix + LLD 92 mutex).
  let _activeSelectOwner = null; // "symbol" | "room" | "measurement" | null
  setSelectHooks({
    onDown(sx, sy) {
      if (previewIsActive()) return false; // preview is read-only (LLD 128)
      if (onSelectDown(sx, sy)) {
        roomClearSelection();          // MUTEX: picking a symbol drops the room
        measureClearSelection();       // MUTEX: picking a symbol drops measurement
        _activeSelectOwner = "symbol";
        return true;
      }
      if (roomOnSelectDown(sx, sy)) {  // roomTool clears the symbol selection itself
        measureClearSelection();       // MUTEX: picking a room drops measurement
        _activeSelectOwner = "room";   // via the injected clearSymbolSelection()
        return true;
      }
      // Measurement branch: lowest priority; only in Select mode (not in measure mode)
      if (!measureIsActive() && measureOnSelectDown(sx, sy)) {
        _activeSelectOwner = "measurement";
        return true;
      }
      _activeSelectOwner = null;
      return false;                    // miss: neither selection changes
    },
    onMove(sx, sy) {
      if (_activeSelectOwner === "symbol") onSelectMove(sx, sy);
      else if (_activeSelectOwner === "room") roomOnSelectMove(sx, sy);
      else if (_activeSelectOwner === "measurement") measureOnSelectMove(sx, sy);
    },
    onUp(sx, sy) {
      if (_activeSelectOwner === "symbol") onSelectUp(sx, sy);
      else if (_activeSelectOwner === "room") roomOnSelectUp(sx, sy);
      else if (_activeSelectOwner === "measurement") measureOnSelectUp(sx, sy);
      _activeSelectOwner = null;
    },
    onTapEmpty() {
      onTapEmpty();
      roomOnTapEmpty();
      measureOnTapEmpty(); // clear measurement selection + render
    },
  });

  // Wire the mutex injection so roomTool can drop the symbol selection without
  // importing symbolTool (mirrors the history/toast injection pattern).
  roomSetClearSymbolSelection(symClearSelection);
  // And the reverse: any symbol selection (incl. dock drag-drop placement, which
  // bypasses the dispatcher via selectSymbol) drops a live room selection.
  symSetClearRoomSelection(roomClearSelection);

  // Wire measure tool mutex injection (measure selection clears symbol + room)
  measureSetClearOtherSelections(() => { symClearSelection(); roomClearSelection(); });

  // Inject history.commit into measure tool
  measureToolSetHistoryCommit(historyCommit);

  // Init measure render (reads measurements model + draft + selected id)
  initMeasureRender(gMeasure, dimLabelsEl, () => measurementsModel.measurements, getDraft, getSelectedMeasurementId);

  // Wire measure hooks into interactions (no static measureTool import there)
  setMeasureHooks({
    isActive: measureIsActive,
    onDown(sx, sy) { if (previewIsActive()) return false; return onMeasureDown(sx, sy); },
    onMove:   onMeasureMove,
    onLeave:  onMeasureLeave,
  });

  // Measure tool rail button activates measure mode
  if (btnMeasure) {
    btnMeasure.addEventListener("click", () => {
      measureDeactivate();   // deactivate first (resets any pending A)
      setTool("select");     // exit draw mode (auto-finishes chain)
      onDrawModeEnter();     // clear symbol selection
      roomOnDrawModeEnter(); // clear room selection
      measureActivate();     // enter measure mode
      scheduleRender();
    });
  }

  // When switching to draw mode, deactivate measure mode + clear both symbol and room selection
  document.getElementById("tool-wall")?.addEventListener("click", () => {
    measureDeactivate();
    onDrawModeEnter();
    roomOnDrawModeEnter();
  });
  // Select tool button: deactivate measure mode
  document.getElementById("tool-select")?.addEventListener("click", () => {
    measureDeactivate();
  });

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "w" || e.key === "W") {
      measureDeactivate();
      onDrawModeEnter();
      roomOnDrawModeEnter();
    }
    if (e.key === "v" || e.key === "V") {
      measureDeactivate();
    }
    if (e.key === "m" || e.key === "M") {
      // Activate measure mode
      measureDeactivate();
      setTool("select");     // exit draw mode
      onDrawModeEnter();
      roomOnDrawModeEnter();
      measureActivate();
      scheduleRender();
    }
    // P: toggle 3D preview mode (LLD 128)
    if (e.key === "p" || e.key === "P") {
      previewToggle();
      _syncPreview();
      scheduleRender();
    }
  });

  // 3D isometric preview (LLD 128): bind model refs + active getter for the
  // WebGL-unavailable fallback painter (no longer in the normal onRender chain).
  if (gIso) {
    initIsoRender(gIso, previewIsActive, _wallsModRef, _symbolsModRef);
  }

  // True 3D WebGL preview (LLD 130): bind canvas + model refs + active getter +
  // loading element. three.js is lazy-loaded on first enter().
  if (canvas3d) {
    render3d.initRender3d(canvas3d, previewIsActive, _wallsModRef, _symbolsModRef, previewLoadingEl);
  }

  // Expose the 3D renderer module for headless integration tests (LLD 130 Test
  // Requirements). Introspection-only — the module exports no mutators, so this
  // handle cannot change plan state; it just lets the Playwright rig call the
  // read-only probes (webglAvailable / __liveGeometryCount / __hasRenderer) that
  // drive the real WebGL render/teardown path in the built dist/ app.
  window.__render3d = render3d;

  // Read-only state snapshot for the read-only-preview regression tests (LLD 130).
  // Returns a deep-copied snapshot of the persisted 2D view + room verts so the
  // integration rig can assert that a 3D orbit/zoom gesture and a W×H "Set" during
  // preview leave BOTH the view and the walls unmutated. Pure read — the returned
  // object is a copy, so it cannot be used to mutate app state.
  window.__testState = () => ({
    zoom: view.zoom, panX: view.panX, panY: view.panY,
    rooms: wallsModel.rooms.map((r) => ({ verts: r.verts.map((v) => ({ x: v.x, y: v.y })) })),
  });

  // Expose encodeShareHash for the LLD 136 boot-conflict + pv=1 integration
  // test. Lets the Playwright rig build a valid share hash (with &pv=1) without
  // duplicating the codec in Node.js (which can't use CompressionStream).
  window.__encodeShareHash = encodeShareHash;

  // Register post-render hooks
  // Order: wallRender (in _wallRender) → symbolRenderFn → clearanceRenderFn →
  //        measureRenderFn → symbolDimReposition → repositionInspector →
  //        dimReposition → measureUpdate → clearancePanelUpdate → loupeReposition
  //        → isoRenderFn (last: overlays all 2D layers)
  onRender(symbolRenderFn);
  onRender(repositionFlushGuide); // re-append guide line after symbolRender clears overlay
  onRender(clearanceRenderFn);   // leaders above symbol bodies, below #symbol-overlay
  onRender(measureRenderFn);     // measurement annotations, after clearance, before selection overlays
  onRender(symbolDimReposition);
  onRender(repositionInspector);
  onRender(repositionRoomInspector);
  onRender(measureUpdate);
  onRender(clearancePanelUpdate);
  onRender(dimReposition);
  onRender(loupeReposition);     // loupe content stays aligned after pan/zoom
  // NOTE (LLD 130): isoRenderFn is NO LONGER in the normal onRender chain. The
  // true-3D WebGL renderer (render3d) owns the preview surface behind the
  // #tool-preview toggle; isoRender.render() is invoked only on the
  // WebGL-unavailable fallback path (see previewOnChange wiring below).

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

  // ── 3D preview (LLD 128) ──────────────────────────────────────────────────

  /** Sync button + stage class to current preview state. */
  function _syncPreview() {
    const active = previewIsActive();
    if (btnPreview) btnPreview.setAttribute("aria-pressed", active ? "true" : "false");
    if (stage) {
      if (active) {
        stage.classList.add("stage--preview");
      } else {
        stage.classList.remove("stage--preview");
      }
    }
  }

  if (btnPreview) {
    btnPreview.addEventListener("click", () => {
      previewToggle();
      _syncPreview();
      scheduleRender();
    });
  }

  // LLD 136 fix: when preview is entered at boot (pv=1 in the share URL), the
  // async previewOnChange callback can fire "3D unavailable — showing 2.5D preview"
  // in the microtask immediately after await render3d.enter() resolves, which
  // would overwrite the boot recovery toast ("Opened shared plan" with the
  // "Keep my last plan instead" action button).  Set this flag to true just
  // before the boot-driven previewSetActive(true) call; capture and clear it
  // synchronously at the top of the callback (before the first await) so it
  // suppresses the fallback toast for that specific boot entry only.
  let _suppressFallbackToast = false;

  // Single choke point for the 3D renderer side-effects (LLD 130). Every path
  // that changes preview state — the button click, the P shortcut, the Esc-exit
  // branch, and any programmatic setActive — converges on previewToggle(), which
  // fires this onChange listener. Keeping render3d.enter()/exit() ONLY here (not
  // in the button handler) avoids double-invocation.
  previewOnChange(async () => {
    _syncPreview();
    scheduleRender();
    // Capture and clear synchronously before the first await so subsequent
    // interactive entries (button, keyboard) are never affected.
    const suppressFallback = _suppressFallbackToast;
    _suppressFallbackToast = false;
    if (previewIsActive()) {
      const r = await render3d.enter();       // lazy-load + build + frame
      if (!previewIsActive()) {                // toggled off mid-load (Edge Case 3)
        render3d.exit();
        stage?.classList.remove("preview--fallback");
        return;
      }
      if (r && r.ok === false && r.fallback) { // WebGL/import failed → 2.5D fallback
        stage?.classList.add("preview--fallback");
        isoRenderFn();                          // paint the 2.5D SVG fallback once
        if (!suppressFallback) {
          showToast("3D unavailable — showing 2.5D preview");
        }
      } else {
        stage?.classList.remove("preview--fallback");
      }
    } else {
      render3d.exit();
      stage?.classList.remove("preview--fallback");
    }
  });

  // Release the WebGL context on navigation/unload (bfcache / mobile suspend).
  window.addEventListener("pagehide", () => render3d.dispose());

  // ── History (LLD-21) ──────────────────────────────────────────────────────
  // Wire history.reset into actions.js so _confirmReset can call it
  setHistoryReset(historyReset);

  // Wire history.commit into tool modules (injection to avoid circular imports)
  wallSetHistoryCommit(historyCommit);
  symDimSetHistoryCommit(historyCommit);
  dimSetHistoryCommit(historyCommit);        // wall-edge resize (dimEntry.js)
  measureSetHistoryCommit(historyCommit);    // W×H apply (LLD 82)

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
      measureClearSelection(); // drop dangling id if undo removes the selected measurement
      if (historyUndo()) scheduleRender();
    });
  }
  if (btnHistoryRedo) {
    btnHistoryRedo.addEventListener("click", () => {
      measureClearSelection(); // drop dangling id if redo removes the selected measurement
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
      flushNudge();     // flush pending symbol nudge before undo so stack ordering is correct
      roomFlushNudge(); // flush pending room nudge before undo (LLD 96)
      measureClearSelection(); // drop dangling id if undo removes the selected measurement
      if (historyUndo()) scheduleRender();
      return;
    }

    // Redo: Ctrl/Cmd+Shift+Z or Ctrl+Y — accept both cases so Caps Lock doesn't break it
    if (meta && e.shiftKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      flushNudge();     // flush pending symbol nudge before redo
      roomFlushNudge(); // flush pending room nudge before redo (LLD 96)
      measureClearSelection(); // drop dangling id if redo removes the selected measurement
      if (historyRedo()) scheduleRender();
      return;
    }
    if (meta && !e.shiftKey && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      flushNudge();     // flush pending symbol nudge before redo
      roomFlushNudge(); // flush pending room nudge before redo (LLD 96)
      measureClearSelection(); // drop dangling id if redo removes the selected measurement
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
    // If a measurement is selected (and no symbol): consume and delete measurement.
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

    // Esc — deselect selected symbol (LLD-54 extension: symbolTool "extended").
    // help.js capture-phase listener stops propagation when overlay is open, so
    // this branch only fires when the overlay is already closed.
    // wallTool handles Esc for active wall chains in its own bubble-phase listener
    // (registered earlier); it does not stopPropagation, so we still receive the
    // event — but we must not deselect when wallTool is about to finish a chain.
    if (!meta && e.key === "Escape") {
      // Exit 3D preview mode on Esc (LLD 128)
      if (previewIsActive()) {
        e.preventDefault();
        previewToggle(); // setActive(false)
        _syncPreview();
        scheduleRender();
        return;
      }
      if (isDrawMode() && wallsModel.chain.length > 0) {
        // Let wallTool bubble-phase listener handle chain finish/cancel
        return;
      }
      if (hasSelection()) {
        e.preventDefault();
        flushNudge(); // commit any pending nudge before clearing selection
        onTapEmpty(); // clears selection + hides inspector; no-op if dim edit active
        return;
      }
      // Esc in Select mode with a measurement selected: clear it
      if (measureHasSelection()) {
        e.preventDefault();
        measureClearSelection();
        scheduleRender();
        return;
      }
      // Esc in Measure mode: measureTool's own keydown handles cancel of in-progress placement
      return;
    }

    // ── New shortcuts (LLD-54) ─────────────────────────────────────────────────

    // Nudge — bare/Shift arrows, when a symbol or room is selected and not a chord
    if (!meta && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const base = snapStep() ?? 0.1; // grid step, fallback 0.1m when snap is off
      const step = e.shiftKey ? base * 4 : base;
      let dx = 0, dy = 0;
      if (e.key === "ArrowUp")    dy = -step;
      if (e.key === "ArrowDown")  dy =  step;
      if (e.key === "ArrowLeft")  dx = -step;
      if (e.key === "ArrowRight") dx =  step;
      if (hasSelection()) {
        // Symbol selected — symbol wins; mutex guarantees no room selected simultaneously
        e.preventDefault();
        nudgeSelected(dx, dy);
        return;
      }
      if (roomHasSelection()) {
        // Room selected — nudge the room (LLD 96)
        e.preventDefault();
        roomNudgeSelected(dx, dy);
        return;
      }
      return; // nothing selected → native scroll (unchanged)
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
    // LLD 136: hashPreview must be scoped OUTSIDE the try so every branch
    // (including the catch and all conflict sub-branches) can read it.
    let hashPlan = null;
    let hashPreview = false; // safe default; readable in catch + all branches
    try {
      const boot = await readBootHash();
      hashPlan = boot.plan;
      hashPreview = boot.preview;
    } catch {
      showToast("That share link couldn't be opened.");
      // hashPreview stays false → no preview entry
    }

    const localPlan = loadLocal();

    // LLD 136: tracks whether the plan ultimately displayed is the hash (shared) plan.
    // Set to true in every branch that applies the hash plan; the single
    // setActive(true) call at the end avoids duplicating per-branch logic.
    let enterPreview = false;

    if (hashPlan && localPlan) {
      // Both present: check if they differ
      const hashSer = serializePlan(hashPlan);
      const localSer = serializePlan(localPlan);

      if (hashSer === localSer) {
        // Identical: treat as local restore (no banner); plan shown == hash plan
        applyPlan(localPlan);
        historyReset(); // reseed baseline after restore (Edge Case 12)
        if (toastEl) showToast("Restored your last plan");
        render();
        enterPreview = hashPreview; // plan shown IS the shared plan
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
          previewSetActive(false); // LLD 136 §4: pv flag described the shared plan; drop preview
          applyPlan(localPlan);
          historyReset(); // reseed baseline after restore (Edge Case 12)
          render();
        };
        applyShared();
        render();
        // LLD 136: applyShared path — enter preview before the early return.
        // previewSetActive(true) fires the previewOnChange choke point (wired
        // below), which does the full lazy-load + build + fallback sequence.
        // applyLocal path ("Keep my last plan instead") — the pv flag described
        // the shared plan; do NOT enter preview for the user's own local plan.
        //
        // IMPORTANT ordering (QA fix): on no-WebGL devices, the previewOnChange
        // callback's `await render3d.enter()` resolves in the very next microtask
        // and would emit "3D unavailable" — overwriting the recovery toast and
        // destroying the "Keep my last plan instead" action button.  Suppress the
        // fallback toast for this boot-driven entry only, then show the recovery
        // toast AFTER previewSetActive so it is always the last toast shown.
        if (hashPreview) {
          _suppressFallbackToast = true;
          previewSetActive(true);
        }
        showToast("Opened shared plan", {
          label: "Keep my last plan instead",
          onClick: applyLocal,
        });
        return; // early return: conflict branch manages its own flow
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
      enterPreview = hashPreview;
    } else if (localPlan) {
      // Only local plan: restore verbatim (view included). No hash → pv cannot be set.
      applyPlan(localPlan);
      historyReset(); // reseed baseline after restore (Edge Case 12)
      if (toastEl) showToast("Restored your last plan");
      render();
      // enterPreview stays false (no hash, pv cannot be set)
    } else {
      // Empty start: use default frame
      resetView(vW, vH);
      render();
      // Show first-run coach-marks only on an empty start (LLD-60)
      if (onboardingEl && coachWallEl && coachTmplEl && coachDismiss) {
        onboardingMaybeShow();
      }
      // enterPreview stays false (no plan, no hash)
    }

    // LLD 136: single end-of-IIFE preview entry for all hash-displaying branches.
    // Does not run for the early-return conflict branch (handled inline above) or
    // when enterPreview is false (local-only, empty-start, or hash-preview=false).
    // Suppress the no-WebGL fallback toast here so it cannot overwrite the boot
    // confirmation toast ("Opened shared plan") that was shown just above.
    if (enterPreview) {
      _suppressFallbackToast = true;
      previewSetActive(true);
    }
  })();

  // ── Window resize ──────────────────────────────────────────────────────────
  window.addEventListener("resize", () => {
    resize();
    render();
    // Keep the 3D renderer's canvas + camera aspect in sync while preview is
    // active (LLD 130 Edge Case 12), otherwise the WebGL output stretches.
    if (previewIsActive()) render3d.resize();
  });
});
