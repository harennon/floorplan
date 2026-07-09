/**
 * symbolRender.js — SVG + chip rendering for symbols
 *
 * Reads symbols.model + selection/ghost state and paints into two SVG groups:
 *   #symbols      — symbol bodies
 *   #symbol-overlay — selection box, handles, ghost
 *
 * Also appends dimension chips to the shared .dim-labels container. Does NOT
 * clear .dim-labels (wallRender clears it first; we only append).
 *
 * Registered as a surface.onRender hook AFTER wallRender runs (per LLD
 * .dim-labels ordering contract).
 *
 * Nothing in this module fires events or handles input.
 */

import { worldToScreen, pxPerM } from "./view.js";
import { fmtLen, unitLabel } from "./units.js";
import { model, corners, CATALOG } from "./symbols.js";

const NS = "http://www.w3.org/2000/svg";

// ── Palette ────────────────────────────────────────────────────────────────────

const GOLD         = "#c9a84c";
const GOLD_SOFT    = "rgba(201,168,76,0.55)";
const GOLD_FILL    = "rgba(201,168,76,0.12)";
const GOLD_STROKE  = "#d9be6e";
const SNAP_TEAL    = "#7fd0c8";
const GHOST_FILL   = "rgba(201,168,76,0.25)";
const GHOST_STROKE = GOLD;

// Handle geometry (screen-space constants)
const ROTATE_HANDLE_OFFSET = 22;  // px above top-center
const ROTATE_HANDLE_R      = 6;   // px radius
const SEL_BOX_SW           = 1.5;
const CHIP_OFFSET_PX       = 2;   // extra offset so chip doesn't overlap the box line

// ── DOM refs ───────────────────────────────────────────────────────────────────

let _gSymbols   = null;
let _gOverlay   = null;
let _dimLabels  = null;

// ── Injected getters ───────────────────────────────────────────────────────────

let _getSelectedId     = () => null;
let _getPlacementGhost = () => null;
let _getEditingDim     = () => null;

// ── Init ───────────────────────────────────────────────────────────────────────

/**
 * @param {SVGGElement} gSymbols
 * @param {SVGGElement} gOverlay
 * @param {HTMLElement} dimLabels
 * @param {()=>string|null} getSelectedId
 * @param {()=>{type,x,y,w,h,rot}|null} getPlacementGhost
 * @param {()=>{symbolId:string,dim:"w"|"h"}|null} getEditingDim
 */
export function init(gSymbols, gOverlay, dimLabels, getSelectedId, getPlacementGhost, getEditingDim) {
  _gSymbols          = gSymbols;
  _gOverlay          = gOverlay;
  _dimLabels         = dimLabels;
  _getSelectedId     = getSelectedId     || (() => null);
  _getPlacementGhost = getPlacementGhost || (() => null);
  _getEditingDim     = getEditingDim     || (() => null);
}

// ── Main render ────────────────────────────────────────────────────────────────

/**
 * Full idempotent redraw of symbol bodies, selection overlay, ghost, and chips.
 * Called as a surface.onRender hook. MUST run after wallRender.
 */
export function render() {
  if (!_gSymbols) return;

  // Clear only our two SVG groups — never clear .dim-labels
  _clearGroup(_gSymbols);
  _clearGroup(_gOverlay);

  const selectedId = _getSelectedId();
  const editingDim = _getEditingDim();
  const ghost = _getPlacementGhost();

  // ── Symbol bodies ──────────────────────────────────────────────────────────
  for (const sym of model.symbols) {
    _renderSymbolBody(_gSymbols, sym, sym.id === selectedId);
  }

  // ── Selection overlay + chips for selected symbol ─────────────────────────
  if (selectedId) {
    const sym = model.symbols.find(s => s.id === selectedId);
    if (sym) {
      _renderSelectionBox(_gOverlay, sym);
      _renderRotateHandle(_gOverlay, sym);
      _renderDimChips(sym, editingDim);
    }
  }

  // ── Placement ghost ────────────────────────────────────────────────────────
  if (ghost) {
    _renderGhost(_gOverlay, ghost);
  }
}

// ── Private: symbol body ───────────────────────────────────────────────────────

function _renderSymbolBody(parent, sym, selected) {
  const cs = corners(sym).map(c => worldToScreen(c.x, c.y));
  const pts = cs.map(s => `${s.x},${s.y}`).join(" ");

  const poly = document.createElementNS(NS, "polygon");
  poly.setAttribute("points", pts);
  poly.setAttribute("fill", selected ? "rgba(201,168,76,0.18)" : GOLD_FILL);
  poly.setAttribute("stroke", selected ? GOLD : GOLD_STROKE);
  poly.setAttribute("stroke-width", selected ? "2" : "1.5");
  poly.setAttribute("stroke-linejoin", "round");
  parent.appendChild(poly);

  // Type-specific interior glyph
  _renderInterior(parent, sym, cs);
}

/**
 * Draw a simple interior glyph so the symbol type is recognisable.
 */
function _renderInterior(parent, sym, cs) {
  // cs = [TL, TR, BR, BL] in screen space
  const ppm = pxPerM();
  const sc = worldToScreen(sym.x, sym.y); // screen center
  const sw = sym.w * ppm;
  const sh = sym.h * ppm;
  const rad = (sym.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // Helper: offset by local (lx,ly) from center in rotated screen space
  const lp = (lx, ly) => ({
    x: sc.x + lx * cos - ly * sin,
    y: sc.y + lx * sin + ly * cos,
  });

  const cat = CATALOG[sym.type];

  if (cat?.openings) {
    // Door/window: simple opening marker line
    const topMid = { x: (cs[0].x + cs[1].x) / 2, y: (cs[0].y + cs[1].y) / 2 };
    const botMid = { x: (cs[3].x + cs[2].x) / 2, y: (cs[3].y + cs[2].y) / 2 };
    const line = _makeLine(topMid.x, topMid.y, botMid.x, botMid.y);
    line.setAttribute("stroke", GOLD);
    line.setAttribute("stroke-width", "1");
    line.setAttribute("stroke-dasharray", "3 2");
    parent.appendChild(line);

    if (sym.type === "door") {
      // Door arc: quarter-circle from one end of door width
      const r = sw * 0.9; // swing radius in screen px
      const a0 = lp(-sw / 2, sh / 2); // hinge point (BL in local)
      const a1 = lp(-sw / 2 + sw, sh / 2); // swing end (BR in local)
      const arc = document.createElementNS(NS, "path");
      // Simple 90-degree arc sweep
      const dx = a1.x - a0.x;
      const dy = a1.y - a0.y;
      arc.setAttribute("d", `M ${a0.x} ${a0.y} L ${a1.x} ${a1.y}`);
      arc.setAttribute("stroke", GOLD);
      arc.setAttribute("stroke-width", "1");
      arc.setAttribute("fill", "none");
      arc.setAttribute("opacity", "0.6");
      parent.appendChild(arc);
    }
    return;
  }

  if (sym.type === "bed") {
    // Pillow indicator (small rect top ~30% of depth)
    const pw = sw * 0.8;
    const ph = sh * 0.25;
    const p0 = lp(-pw / 2, -sh / 2 + 4);
    const p1 = lp( pw / 2, -sh / 2 + 4);
    const p2 = lp( pw / 2, -sh / 2 + 4 + ph);
    const p3 = lp(-pw / 2, -sh / 2 + 4 + ph);
    const pillowPts = [p0, p1, p2, p3].map(p => `${p.x},${p.y}`).join(" ");
    const pillow = document.createElementNS(NS, "polygon");
    pillow.setAttribute("points", pillowPts);
    pillow.setAttribute("fill", "rgba(201,168,76,0.2)");
    pillow.setAttribute("stroke", GOLD_STROKE);
    pillow.setAttribute("stroke-width", "0.8");
    parent.appendChild(pillow);
    // Center line
    const l0 = lp(0, -sh / 2 + 4 + ph);
    const l1 = lp(0,  sh / 2);
    const cLine = _makeLine(l0.x, l0.y, l1.x, l1.y);
    cLine.setAttribute("stroke", GOLD_STROKE);
    cLine.setAttribute("stroke-width", "0.6");
    cLine.setAttribute("opacity", "0.5");
    parent.appendChild(cLine);
    return;
  }

  if (sym.type === "sofa") {
    // Back rest: strip across top ~25%
    const bw = sw * 0.9;
    const bh = sh * 0.22;
    const b0 = lp(-bw / 2, -sh / 2 + 2);
    const b1 = lp( bw / 2, -sh / 2 + 2);
    const b2 = lp( bw / 2, -sh / 2 + 2 + bh);
    const b3 = lp(-bw / 2, -sh / 2 + 2 + bh);
    const backPts = [b0, b1, b2, b3].map(p => `${p.x},${p.y}`).join(" ");
    const back = document.createElementNS(NS, "polygon");
    back.setAttribute("points", backPts);
    back.setAttribute("fill", "rgba(201,168,76,0.15)");
    back.setAttribute("stroke", GOLD_STROKE);
    back.setAttribute("stroke-width", "0.8");
    parent.appendChild(back);
    // Two armrests
    for (const side of [-1, 1]) {
      const ax = side * (sw / 2 - (sw * 0.08));
      const a0 = lp(ax - sw * 0.04, -sh / 2 + bh + 2);
      const a1 = lp(ax + sw * 0.04, -sh / 2 + bh + 2);
      const a2 = lp(ax + sw * 0.04,  sh / 2 - 2);
      const a3 = lp(ax - sw * 0.04,  sh / 2 - 2);
      const armPts = [a0, a1, a2, a3].map(p => `${p.x},${p.y}`).join(" ");
      const arm = document.createElementNS(NS, "polygon");
      arm.setAttribute("points", armPts);
      arm.setAttribute("fill", "rgba(201,168,76,0.1)");
      arm.setAttribute("stroke", GOLD_STROKE);
      arm.setAttribute("stroke-width", "0.7");
      parent.appendChild(arm);
    }
    return;
  }

  if (sym.type === "table") {
    // Cross lines
    for (const [ax, ay, bx, by] of [
      [-sw / 2 + 3, -sh / 2 + 3, sw / 2 - 3, sh / 2 - 3],
      [ sw / 2 - 3, -sh / 2 + 3, -sw / 2 + 3, sh / 2 - 3],
    ]) {
      const pa = lp(ax, ay), pb = lp(bx, by);
      const l = _makeLine(pa.x, pa.y, pb.x, pb.y);
      l.setAttribute("stroke", GOLD_STROKE);
      l.setAttribute("stroke-width", "0.7");
      l.setAttribute("opacity", "0.5");
      parent.appendChild(l);
    }
    return;
  }

  if (sym.type === "chair") {
    // Circle (seat)
    const r = Math.min(sw, sh) / 2 * 0.65;
    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("cx", String(sc.x));
    circle.setAttribute("cy", String(sc.y));
    circle.setAttribute("r", String(r));
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", GOLD_STROKE);
    circle.setAttribute("stroke-width", "0.8");
    parent.appendChild(circle);
    return;
  }

  if (sym.type === "desk") {
    // L-shape hint: two lines forming corner
    const lx1 = -sw / 2 + 3, lx2 = sw / 2 - 3;
    const ly1 = -sh / 2 + 3, ly2 = sh / 2 - 3;
    const corner = lp(lx1, ly1);
    const edgeH  = lp(lx2, ly1);
    const edgeV  = lp(lx1, ly2);
    const l1 = _makeLine(corner.x, corner.y, edgeH.x, edgeH.y);
    l1.setAttribute("stroke", GOLD_STROKE);
    l1.setAttribute("stroke-width", "0.8");
    l1.setAttribute("opacity", "0.6");
    parent.appendChild(l1);
    const l2 = _makeLine(corner.x, corner.y, edgeV.x, edgeV.y);
    l2.setAttribute("stroke", GOLD_STROKE);
    l2.setAttribute("stroke-width", "0.8");
    l2.setAttribute("opacity", "0.6");
    parent.appendChild(l2);
    return;
  }

  if (sym.type === "fridge") {
    // Horizontal divider 30% from top + handle
    const divY = -sh / 2 + sh * 0.3;
    const d0 = lp(-sw / 2 + 2, divY);
    const d1 = lp( sw / 2 - 2, divY);
    const divL = _makeLine(d0.x, d0.y, d1.x, d1.y);
    divL.setAttribute("stroke", GOLD_STROKE);
    divL.setAttribute("stroke-width", "0.8");
    parent.appendChild(divL);
    // Handle: short line on right edge near center
    const h0 = lp(sw / 2 - 4, -sh * 0.08);
    const h1 = lp(sw / 2 - 4,  sh * 0.08);
    const handle = _makeLine(h0.x, h0.y, h1.x, h1.y);
    handle.setAttribute("stroke", GOLD);
    handle.setAttribute("stroke-width", "1.2");
    handle.setAttribute("stroke-linecap", "round");
    parent.appendChild(handle);
    return;
  }

  if (sym.type === "toilet") {
    // Oval seat (ellipse ~70% width, upper 65% of depth) + tank rect across top edge (~20% depth)
    // Tank: thin rectangle at the top
    const tankH = sh * 0.20;
    const tankW = sw * 0.85;
    const t0 = lp(-tankW / 2, -sh / 2);
    const t1 = lp( tankW / 2, -sh / 2);
    const t2 = lp( tankW / 2, -sh / 2 + tankH);
    const t3 = lp(-tankW / 2, -sh / 2 + tankH);
    const tankPts = [t0, t1, t2, t3].map(p => `${p.x},${p.y}`).join(" ");
    const tank = document.createElementNS(NS, "polygon");
    tank.setAttribute("points", tankPts);
    tank.setAttribute("fill", "rgba(201,168,76,0.1)");
    tank.setAttribute("stroke", GOLD_STROKE);
    tank.setAttribute("stroke-width", "0.8");
    parent.appendChild(tank);
    // Oval seat: ellipse centered slightly below tank
    const seatCY = -sh / 2 + tankH + (sh - tankH) * 0.5;
    const seatRX = sw * 0.35;
    const seatRY = (sh - tankH) * 0.42;
    const seatCenter = lp(0, seatCY);
    const seat = document.createElementNS(NS, "ellipse");
    seat.setAttribute("cx", String(seatCenter.x));
    seat.setAttribute("cy", String(seatCenter.y));
    // For rotated symbols, approximate with an ellipse at the rotated angle
    seat.setAttribute("rx", String(seatRX));
    seat.setAttribute("ry", String(seatRY));
    seat.setAttribute("transform", `rotate(${sym.rot},${seatCenter.x},${seatCenter.y})`);
    seat.setAttribute("fill", "none");
    seat.setAttribute("stroke", GOLD_STROKE);
    seat.setAttribute("stroke-width", "0.8");
    seat.setAttribute("opacity", "0.7");
    parent.appendChild(seat);
    return;
  }

  if (sym.type === "bathtub") {
    // Inner basin (rounded rect inset ~10%) + small drain circle near one short end
    const insetX = sw * 0.10;
    const insetY = sh * 0.10;
    const basinW = sw - 2 * insetX;
    const basinH = sh - 2 * insetY;
    const b0 = lp(-basinW / 2, -basinH / 2);
    const b1 = lp( basinW / 2, -basinH / 2);
    const b2 = lp( basinW / 2,  basinH / 2);
    const b3 = lp(-basinW / 2,  basinH / 2);
    const basinPts = [b0, b1, b2, b3].map(p => `${p.x},${p.y}`).join(" ");
    const basin = document.createElementNS(NS, "polygon");
    basin.setAttribute("points", basinPts);
    basin.setAttribute("fill", "rgba(201,168,76,0.08)");
    basin.setAttribute("stroke", GOLD_STROKE);
    basin.setAttribute("stroke-width", "0.8");
    parent.appendChild(basin);
    // Drain circle near bottom short end
    const drainCenter = lp(0, basinH / 2 - sh * 0.12);
    const drain = document.createElementNS(NS, "circle");
    drain.setAttribute("cx", String(drainCenter.x));
    drain.setAttribute("cy", String(drainCenter.y));
    drain.setAttribute("r", String(Math.max(2, sw * 0.04)));
    drain.setAttribute("fill", "none");
    drain.setAttribute("stroke", GOLD_STROKE);
    drain.setAttribute("stroke-width", "0.7");
    drain.setAttribute("opacity", "0.7");
    parent.appendChild(drain);
    return;
  }

  if (sym.type === "sink") {
    // Inner rounded basin centered + small faucet dot on back (top) edge
    const insetX = sw * 0.12;
    const insetY = sh * 0.12;
    const basinW = sw - 2 * insetX;
    const basinH = sh - 2 * insetY;
    const s0 = lp(-basinW / 2, -basinH / 2);
    const s1 = lp( basinW / 2, -basinH / 2);
    const s2 = lp( basinW / 2,  basinH / 2);
    const s3 = lp(-basinW / 2,  basinH / 2);
    const basinPts = [s0, s1, s2, s3].map(p => `${p.x},${p.y}`).join(" ");
    const basin = document.createElementNS(NS, "polygon");
    basin.setAttribute("points", basinPts);
    basin.setAttribute("fill", "rgba(201,168,76,0.08)");
    basin.setAttribute("stroke", GOLD_STROKE);
    basin.setAttribute("stroke-width", "0.8");
    parent.appendChild(basin);
    // Faucet dot on top (back) edge center
    const faucetPt = lp(0, -sh / 2 + sh * 0.06);
    const faucet = document.createElementNS(NS, "circle");
    faucet.setAttribute("cx", String(faucetPt.x));
    faucet.setAttribute("cy", String(faucetPt.y));
    faucet.setAttribute("r", String(Math.max(1.5, sw * 0.05)));
    faucet.setAttribute("fill", GOLD_STROKE);
    faucet.setAttribute("opacity", "0.7");
    parent.appendChild(faucet);
    return;
  }

  if (sym.type === "stove") {
    // 4 burner circles in a 2×2 grid
    const bx = sw * 0.26;
    const by = sh * 0.26;
    const br = Math.min(sw, sh) * 0.12;
    for (const [ox, oy] of [[-bx, -by], [bx, -by], [-bx, by], [bx, by]]) {
      const bc = lp(ox, oy);
      const burner = document.createElementNS(NS, "circle");
      burner.setAttribute("cx", String(bc.x));
      burner.setAttribute("cy", String(bc.y));
      burner.setAttribute("r", String(br));
      burner.setAttribute("fill", "none");
      burner.setAttribute("stroke", GOLD_STROKE);
      burner.setAttribute("stroke-width", "0.8");
      burner.setAttribute("opacity", "0.7");
      parent.appendChild(burner);
    }
    return;
  }

  if (sym.type === "wardrobe") {
    // Vertical center divider (two doors) + two small handle dots
    const divTop = lp(0, -sh / 2 + 2);
    const divBot = lp(0,  sh / 2 - 2);
    const divL = _makeLine(divTop.x, divTop.y, divBot.x, divBot.y);
    divL.setAttribute("stroke", GOLD_STROKE);
    divL.setAttribute("stroke-width", "0.8");
    divL.setAttribute("opacity", "0.7");
    parent.appendChild(divL);
    // Handle dots on each door panel
    for (const side of [-1, 1]) {
      const hPt = lp(side * sw * 0.15, 0);
      const hdot = document.createElementNS(NS, "circle");
      hdot.setAttribute("cx", String(hPt.x));
      hdot.setAttribute("cy", String(hPt.y));
      hdot.setAttribute("r", "1.5");
      hdot.setAttribute("fill", GOLD_STROKE);
      hdot.setAttribute("opacity", "0.7");
      parent.appendChild(hdot);
    }
    return;
  }

  if (sym.type === "bookshelf") {
    // 3 evenly spaced shelf lines parallel to the long (width) axis
    const nShelves = 3;
    for (let i = 0; i < nShelves; i++) {
      const t = (i + 1) / (nShelves + 1);
      const lineY = -sh / 2 + sh * t;
      const l0 = lp(-sw / 2 + 2, lineY);
      const l1 = lp( sw / 2 - 2, lineY);
      const shelf = _makeLine(l0.x, l0.y, l1.x, l1.y);
      shelf.setAttribute("stroke", GOLD_STROKE);
      shelf.setAttribute("stroke-width", "0.7");
      shelf.setAttribute("opacity", "0.6");
      parent.appendChild(shelf);
    }
    return;
  }

  if (sym.type === "tv") {
    // Screen rect across top ~70% height + short center stand line to bottom edge
    const screenH = sh * 0.65;
    const screenW = sw * 0.88;
    const sTopY = -sh / 2 + 2;
    const sBotY = sTopY + screenH;
    const sv0 = lp(-screenW / 2, sTopY);
    const sv1 = lp( screenW / 2, sTopY);
    const sv2 = lp( screenW / 2, sBotY);
    const sv3 = lp(-screenW / 2, sBotY);
    const screenPts = [sv0, sv1, sv2, sv3].map(p => `${p.x},${p.y}`).join(" ");
    const screen = document.createElementNS(NS, "polygon");
    screen.setAttribute("points", screenPts);
    screen.setAttribute("fill", "rgba(201,168,76,0.08)");
    screen.setAttribute("stroke", GOLD_STROKE);
    screen.setAttribute("stroke-width", "0.8");
    parent.appendChild(screen);
    // Stand: short center line from bottom of screen to bottom edge
    const standTop = lp(0, sBotY);
    const standBot = lp(0, sh / 2 - 2);
    const stand = _makeLine(standTop.x, standTop.y, standBot.x, standBot.y);
    stand.setAttribute("stroke", GOLD_STROKE);
    stand.setAttribute("stroke-width", "0.8");
    stand.setAttribute("opacity", "0.6");
    parent.appendChild(stand);
    return;
  }

  if (sym.type === "washer") {
    // Large center circle (drum door) + small detergent-tray rect on top edge
    const drumR = Math.min(sw, sh) * 0.33;
    const drumCenter = lp(0, sh * 0.06);
    const drum = document.createElementNS(NS, "circle");
    drum.setAttribute("cx", String(drumCenter.x));
    drum.setAttribute("cy", String(drumCenter.y));
    drum.setAttribute("r", String(drumR));
    drum.setAttribute("fill", "none");
    drum.setAttribute("stroke", GOLD_STROKE);
    drum.setAttribute("stroke-width", "0.9");
    parent.appendChild(drum);
    // Detergent tray: small rect near top edge
    const trayW = sw * 0.30;
    const trayH = sh * 0.10;
    const tray0 = lp(-trayW / 2, -sh / 2 + 2);
    const tray1 = lp( trayW / 2, -sh / 2 + 2);
    const tray2 = lp( trayW / 2, -sh / 2 + 2 + trayH);
    const tray3 = lp(-trayW / 2, -sh / 2 + 2 + trayH);
    const trayPts = [tray0, tray1, tray2, tray3].map(p => `${p.x},${p.y}`).join(" ");
    const tray = document.createElementNS(NS, "polygon");
    tray.setAttribute("points", trayPts);
    tray.setAttribute("fill", "rgba(201,168,76,0.1)");
    tray.setAttribute("stroke", GOLD_STROKE);
    tray.setAttribute("stroke-width", "0.7");
    parent.appendChild(tray);
    return;
  }
}

// ── Private: selection box ────────────────────────────────────────────────────

function _renderSelectionBox(parent, sym) {
  const cs = corners(sym).map(c => worldToScreen(c.x, c.y));
  const pts = cs.map(s => `${s.x},${s.y}`).join(" ");
  const box = document.createElementNS(NS, "polygon");
  box.setAttribute("points", pts);
  box.setAttribute("fill", "none");
  box.setAttribute("stroke", GOLD);
  box.setAttribute("stroke-width", String(SEL_BOX_SW));
  box.setAttribute("stroke-dasharray", "5 3");
  box.setAttribute("stroke-linejoin", "round");
  parent.appendChild(box);
}

// ── Private: rotate handle ────────────────────────────────────────────────────

/**
 * Rotate handle: gold circle above the top-center of the bounding box.
 * The handle position is stored as a data attribute so symbolTool can read it.
 */
function _renderRotateHandle(parent, sym) {
  const pos = getRotateHandleScreen(sym);

  // Stem line from top-center to handle
  const cs = corners(sym).map(c => worldToScreen(c.x, c.y));
  const topMid = {
    x: (cs[0].x + cs[1].x) / 2,
    y: (cs[0].y + cs[1].y) / 2,
  };
  const stem = _makeLine(topMid.x, topMid.y, pos.x, pos.y);
  stem.setAttribute("stroke", GOLD_SOFT);
  stem.setAttribute("stroke-width", "1");
  parent.appendChild(stem);

  const knob = document.createElementNS(NS, "circle");
  knob.setAttribute("cx", String(pos.x));
  knob.setAttribute("cy", String(pos.y));
  knob.setAttribute("r", String(ROTATE_HANDLE_R));
  knob.setAttribute("fill", GOLD);
  knob.setAttribute("stroke", "none");
  knob.setAttribute("class", "rotate-handle");
  parent.appendChild(knob);
}

/**
 * Return screen-space center of the rotate handle for a symbol.
 * @param {Sym} sym
 * @returns {{ x:number, y:number }}
 */
export function getRotateHandleScreen(sym) {
  const cs = corners(sym).map(c => worldToScreen(c.x, c.y));
  const topMid = {
    x: (cs[0].x + cs[1].x) / 2,
    y: (cs[0].y + cs[1].y) / 2,
  };
  // The handle is ROTATE_HANDLE_OFFSET px along the normal direction from topMid
  const rad = (sym.rot * Math.PI) / 180;
  // Normal of the top edge = perpendicular to the edge direction, pointing away from center
  // Top edge direction in screen = (cos(rot), sin(rot)), so normal = (-sin(rot), cos(rot))
  // But we want "outward" (away from center), which is "upward" in local frame = (-sin(rot), cos(rot))
  // Wait: screen y is down. In local frame "up" is -y direction. After CW rotation:
  // "up" direction in screen = (-sin(rot), -cos(rot)) ... let me work it out:
  // local (0,-1) → screen: (0*cos - (-1)*sin, 0*sin + (-1)*cos) = (sin, -cos)
  // So the outward normal of the top edge is (sin(rot), -cos(rot)) in screen space.
  const nx = Math.sin(rad);
  const ny = -Math.cos(rad);
  return {
    x: topMid.x + nx * ROTATE_HANDLE_OFFSET,
    y: topMid.y + ny * ROTATE_HANDLE_OFFSET,
  };
}

// ── Private: dim chips ─────────────────────────────────────────────────────────

/**
 * Append dim chips for a selected symbol to the shared .dim-labels layer.
 * Openings show only width chip.
 * @param {Sym} sym
 * @param {{symbolId:string,dim:"w"|"h"}|null} editingDim
 */
function _renderDimChips(sym, editingDim) {
  if (!_dimLabels) return;
  const cat = CATALOG[sym.type];
  if (!cat) return;

  // Width chip: centered on the top edge
  const isEditingW = editingDim && editingDim.symbolId === sym.id && editingDim.dim === "w";
  if (!isEditingW) {
    const cs = corners(sym).map(c => worldToScreen(c.x, c.y));
    const topMid = {
      x: (cs[0].x + cs[1].x) / 2,
      y: (cs[0].y + cs[1].y) / 2,
    };
    // Offset outward a few pixels (along outward normal)
    const rad = (sym.rot * Math.PI) / 180;
    const nx = Math.sin(rad);
    const ny = -Math.cos(rad);
    const cx = topMid.x + nx * (CHIP_OFFSET_PX + 10);
    const cy = topMid.y + ny * (CHIP_OFFSET_PX + 10);
    _appendSymbolChip(sym.id, "w", sym.w, cx, cy);
  }

  // Depth chip: centered on the left edge (not for openings)
  if (!cat.openings) {
    const isEditingH = editingDim && editingDim.symbolId === sym.id && editingDim.dim === "h";
    if (!isEditingH) {
      const cs = corners(sym).map(c => worldToScreen(c.x, c.y));
      // Left edge midpoint: TL to BL
      const leftMid = {
        x: (cs[0].x + cs[3].x) / 2,
        y: (cs[0].y + cs[3].y) / 2,
      };
      // Left edge outward normal = pointing left in local frame
      // local (-1, 0) → screen: (-cos(rot), -sin(rot))
      const rad = (sym.rot * Math.PI) / 180;
      const nx = -Math.cos(rad);
      const ny = -Math.sin(rad);
      const cx = leftMid.x + nx * (CHIP_OFFSET_PX + 10);
      const cy = leftMid.y + ny * (CHIP_OFFSET_PX + 10);
      _appendSymbolChip(sym.id, "h", sym.h, cx, cy);
    }
  }
}

/**
 * Create and append a symbol dim chip to _dimLabels.
 */
function _appendSymbolChip(symbolId, dim, metres, sx, sy) {
  const labelText = fmtLen(metres) + " " + unitLabel();
  const btn = document.createElement("button");
  btn.className = "dim-chip sym-dim-chip";
  btn.setAttribute("data-symbol-id", symbolId);
  btn.setAttribute("data-sym-dim", dim);
  btn.setAttribute("aria-label", `Symbol ${dim === "w" ? "width" : "depth"} ${labelText}, click to edit`);
  btn.textContent = labelText;
  btn.style.left = sx + "px";
  btn.style.top  = sy + "px";
  _dimLabels.appendChild(btn);
}

// ── Private: ghost ────────────────────────────────────────────────────────────

function _renderGhost(parent, ghost) {
  const sc = worldToScreen(ghost.x, ghost.y);
  const ppm = pxPerM();
  const sw = ghost.w * ppm;
  const sh = ghost.h * ppm;
  const rad = (ghost.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = ghost.w / 2;
  const hh = ghost.h / 2;

  // Corners in world
  const worldCorners = [
    { x: ghost.x + (-hw) * cos - (-hh) * sin, y: ghost.y + (-hw) * sin + (-hh) * cos },
    { x: ghost.x + ( hw) * cos - (-hh) * sin, y: ghost.y + ( hw) * sin + (-hh) * cos },
    { x: ghost.x + ( hw) * cos - ( hh) * sin, y: ghost.y + ( hw) * sin + ( hh) * cos },
    { x: ghost.x + (-hw) * cos - ( hh) * sin, y: ghost.y + (-hw) * sin + ( hh) * cos },
  ];
  const screenCorners = worldCorners.map(c => worldToScreen(c.x, c.y));
  const pts = screenCorners.map(s => `${s.x},${s.y}`).join(" ");

  const poly = document.createElementNS(NS, "polygon");
  poly.setAttribute("points", pts);
  poly.setAttribute("fill", GHOST_FILL);
  poly.setAttribute("stroke", GHOST_STROKE);
  poly.setAttribute("stroke-width", "1.5");
  poly.setAttribute("stroke-dasharray", "5 3");
  poly.setAttribute("stroke-linejoin", "round");
  poly.setAttribute("opacity", "0.7");
  parent.appendChild(poly);

  // Snap dot at center
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", String(sc.x));
  dot.setAttribute("cy", String(sc.y));
  dot.setAttribute("r", "4");
  dot.setAttribute("fill", SNAP_TEAL);
  dot.setAttribute("stroke", "none");
  parent.appendChild(dot);
}

// ── Private: SVG helpers ───────────────────────────────────────────────────────

function _clearGroup(g) {
  while (g.firstChild) g.removeChild(g.firstChild);
}

function _makeLine(x1, y1, x2, y2) {
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", String(x1));
  line.setAttribute("y1", String(y1));
  line.setAttribute("x2", String(x2));
  line.setAttribute("y2", String(y2));
  return line;
}
