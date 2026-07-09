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
import { isCoarsePointer } from "./pointerEnv.js";
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
/** Visual rotate handle radius. Coarse pointer: 14px (~28px visual, 44px with pad). Fine: 6px. */
const ROTATE_HANDLE_R      = isCoarsePointer ? 14 : 6;
/** Selection box stroke width. Slightly thicker under coarse pointer for visibility. */
const SEL_BOX_SW           = isCoarsePointer ? 1.5 : 1.5;  // same value; kept symmetric
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
