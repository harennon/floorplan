/**
 * wallTool.js — drawing controller: tool/mode, keyboard, pointer hooks, rail
 *
 * Owns: current tool ("wall"|"select"), altHeld bool, current Snap|null,
 * keyboard handling (V/W/Esc/Enter/Backspace/Alt), and rail-button wiring.
 *
 * Updates #hud-snap cell and the cursor-side snap-tag directly.
 * Pointer hooks (onHover / onClick / onLeave) are injected into interactions.js
 * via main.js → setDrawHooks().
 */

import { screenToWorld } from "./view.js";
import { chooseGridStep } from "./grid.js";
import { model, resolveSnap, placeVertex, closeRoom, finishChain, undoPoint } from "./walls.js";
import { scheduleRender } from "./surface.js";

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {"wall"|"select"} */
let _tool = "wall";

let _altHeld = false;

/** @type {import("./walls.js").Snap|null} */
let _snap = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────

let _hudSnapEl     = null;   // <span id="hud-snap-val">
let _snapTagEl     = null;   // .snap-tag
let _btnSelect     = null;
let _btnWall       = null;
let _btnUndo       = null;
let _btnFinish     = null;
let _stage         = null;
let _railEl        = null;
let _railToggleEl  = null;

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Bind DOM references and wire keyboard + rail.
 * @param {{ hudSnap:Element, snapTag:Element, btnSelect:Element, btnWall:Element,
 *            btnUndo:Element, btnFinish:Element, stage:Element,
 *            rail:Element, railToggle:Element }} refs
 */
export function init(refs) {
  _hudSnapEl    = refs.hudSnap;
  _snapTagEl    = refs.snapTag;
  _btnSelect    = refs.btnSelect;
  _btnWall      = refs.btnWall;
  _btnUndo      = refs.btnUndo;
  _btnFinish    = refs.btnFinish;
  _stage        = refs.stage;
  _railEl       = refs.rail;
  _railToggleEl = refs.railToggle;

  // Rail buttons
  _btnSelect.addEventListener("click", () => setTool("select"));
  _btnWall.addEventListener("click",   () => setTool("wall"));
  _btnUndo.addEventListener("click",   () => { undoPoint(); _updateRail(); scheduleRender(); });
  _btnFinish.addEventListener("click", () => { finishChain(); _updateRail(); scheduleRender(); });

  // Rail collapse toggle (mobile)
  if (_railToggleEl) {
    _railToggleEl.addEventListener("click", () => {
      _railEl.classList.toggle("rail--collapsed");
    });
  }

  // Keyboard
  window.addEventListener("keydown", _onKeyDown);
  window.addEventListener("keyup",   _onKeyUp);
  // Reset Alt free-draw when the window loses focus (Alt+Tab etc. miss the keyup)
  window.addEventListener("blur", _onWindowBlur);

  // Set initial tool state
  setTool("wall");
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Whether draw-wall mode is active. */
export function isDrawMode() {
  return _tool === "wall";
}

/** Current resolved snap, or null when cursor is absent. */
export function getSnap() {
  return _snap;
}

/** Switch tool. Finishing the active chain if switching away from wall. */
export function setTool(t) {
  if (_tool === "wall" && t !== "wall") {
    // Auto-finish open chain on tool switch (edge case 8)
    finishChain();
  }
  _tool = t;
  _snap = null;
  _updateRail();
  _updateCursor();
  scheduleRender();
}

// ── Pointer hooks (called by interactions.js) ─────────────────────────────────

/**
 * Update snap on hover (desktop: pointermove with buttons==0; mobile: while finger down).
 * @param {number} sx screen x
 * @param {number} sy screen y
 */
export function onHover(sx, sy) {
  _snap = resolveSnap(sx, sy, {
    chain: model.chain,
    rooms: model.rooms,
    altHeld: _altHeld,
    step: chooseGridStep(),
  });
  _positionSnapTag(sx, sy);
  _updateHudSnap();
  scheduleRender();
}

/**
 * Commit a vertex at a screen position (on tap/click in draw mode).
 * @param {number} sx
 * @param {number} sy
 */
export function onClick(sx, sy) {
  const snap = resolveSnap(sx, sy, {
    chain: model.chain,
    rooms: model.rooms,
    altHeld: _altHeld,
    step: chooseGridStep(),
  });
  _snap = snap;
  placeVertex(snap);
  // If the tap closed the room (or the chain is now empty for any reason),
  // clear the snap so the green ring / HUD 'close room' lingers are not
  // displayed until the next pointer interaction.
  if (model.chain.length === 0) {
    _snap = null;
    _hideSnapTag();
    _updateHudSnap();
  }
  _updateRail();
  scheduleRender();
}

/** Clear snap when cursor leaves the canvas. */
export function onLeave() {
  _snap = null;
  _hideSnapTag();
  _updateHudSnap();
  scheduleRender();
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

function _onKeyDown(e) {
  // Guard: ignore when modifier keys other than Alt accompany (except Alt itself)
  if (e.ctrlKey || e.metaKey) return;
  // Guard: ignore when focus is in an editable element
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  if (e.code === "AltLeft" || e.code === "AltRight") {
    _altHeld = true;
    scheduleRender();
    return;
  }

  switch (e.key) {
    case "v":
    case "V":
      setTool("select");
      break;
    case "w":
    case "W":
      setTool("wall");
      break;
    case "Escape":
      if (_tool === "wall" && model.chain.length > 0) {
        finishChain();
        _snap = null;
        _hideSnapTag();
        _updateHudSnap();
        _updateRail();
        scheduleRender();
      }
      break;
    case "Enter":
      if (_tool === "wall" && model.chain.length > 0) {
        finishChain();
        _snap = null;
        _hideSnapTag();
        _updateHudSnap();
        _updateRail();
        scheduleRender();
      }
      break;
    case "Backspace":
      if (_tool === "wall" && model.chain.length > 0) {
        e.preventDefault(); // prevent browser back navigation
        undoPoint();
        _updateRail();
        scheduleRender();
      }
      break;
  }
}

function _onKeyUp(e) {
  if (e.code === "AltLeft" || e.code === "AltRight") {
    _altHeld = false;
    scheduleRender();
  }
}

function _onWindowBlur() {
  if (_altHeld) {
    _altHeld = false;
    scheduleRender();
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _updateRail() {
  if (!_btnSelect) return;
  const drawing = _tool === "wall";
  const hasChain = model.chain.length > 0;

  _btnSelect.setAttribute("aria-pressed", _tool === "select" ? "true" : "false");
  _btnWall.setAttribute("aria-pressed",   drawing             ? "true" : "false");
  _btnUndo.disabled   = !hasChain;
  _btnFinish.disabled = !hasChain;

  // Update toggle icon to match active tool (collapsed state shows active-tool button)
  _updateToggleIcon();
}

/**
 * Mirror the active tool's SVG icon into the rail toggle so collapsed state
 * shows the active tool rather than a generic hamburger.
 */
function _updateToggleIcon() {
  if (!_railToggleEl) return;
  const activeBtn = _tool === "wall" ? _btnWall : _btnSelect;
  if (!activeBtn) return;
  const srcSvg = activeBtn.querySelector("svg");
  if (!srcSvg) return;
  // Replace toggle content with a clone of the active tool icon
  _railToggleEl.innerHTML = "";
  _railToggleEl.appendChild(srcSvg.cloneNode(true));
  // Keep aria-label in sync
  _railToggleEl.setAttribute(
    "aria-label",
    (_tool === "wall" ? "Draw wall tool — tap to expand tool rail" : "Select tool — tap to expand tool rail")
  );
}

function _updateCursor() {
  if (!_stage) return;
  if (_tool === "wall") {
    _stage.style.cursor = "crosshair";
  } else {
    _stage.style.cursor = "";
  }
}

const SNAP_LABELS = {
  grid:  "grid",
  point: "point",
  close: "close room",
  free:  "free",
};

const SNAP_COLORS = {
  grid:  "#7fd0c8",
  point: "#e0b64f",
  close: "#9cd67a",
  free:  "#8f8a78",
};

function _updateHudSnap() {
  if (!_hudSnapEl) return;
  if (_snap === null || !isDrawMode()) {
    _hudSnapEl.textContent = "—";
    _hudSnapEl.style.color = "";
    return;
  }
  _hudSnapEl.textContent = SNAP_LABELS[_snap.type] || _snap.type;
  _hudSnapEl.style.color = SNAP_COLORS[_snap.type] || "";
}

function _positionSnapTag(sx, sy) {
  if (!_snapTagEl || !isDrawMode() || _snap === null) {
    _hideSnapTag();
    return;
  }
  const label = SNAP_LABELS[_snap.type] || _snap.type;
  const color  = SNAP_COLORS[_snap.type] || "";
  _snapTagEl.textContent = label;
  _snapTagEl.style.color = color;
  _snapTagEl.style.display = "block";

  // Position near cursor; clamp to viewport
  const offset = 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = _snapTagEl.offsetWidth  || 60;
  const h = _snapTagEl.offsetHeight || 18;
  let lx = sx + offset;
  let ly = sy - offset;
  if (lx + w > vw - 8) lx = sx - w - offset;
  if (ly < 8) ly = sy + offset;
  if (ly + h > vh - 8) ly = vh - h - 8;
  _snapTagEl.style.left = lx + "px";
  _snapTagEl.style.top  = ly + "px";
}

function _hideSnapTag() {
  if (_snapTagEl) _snapTagEl.style.display = "none";
}
