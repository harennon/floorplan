/**
 * wallRender.js — SVG + label rendering for committed rooms and the active chain
 *
 * Reads walls.model and the current snap (via wallTool.getSnap()),
 * renders into #world / #draft / #snap SVG groups and the .labels HTML overlay.
 * Called from surface.js's render loop (_doRender).
 *
 * Nothing in this module fires events or handles input.
 */

import { worldToScreen, pxPerM } from "./view.js";
import { fmtLen, unitLabel } from "./units.js";
import { model, WALL_M, canClose, edgeLength } from "./walls.js";
import { palette } from "./theme.js";

const NS = "http://www.w3.org/2000/svg";

// Snap glyph metrics (screen-constant)
const VERTEX_DOT_R = 3;
const GLYPH_SIZE   = 10;    // half-size for diamond / radius for ring
const GLYPH_SW     = 1.5;   // glyph stroke width

// DOM refs
let _gWorld  = null;
let _gDraft  = null;
let _gSnap   = null;
let _labelsEl = null;
let _dimLabelsEl = null;

// Injected getters (set via init)
let _getSnap           = () => null;
let _getHighlight      = () => null;
let _getEditingEdge    = () => null;
let _getSelectedRoomId = () => null;

/**
 * Bind mount points. Called once from main.js.
 * @param {SVGGElement} gWorld
 * @param {SVGGElement} gDraft
 * @param {SVGGElement} gSnap
 * @param {HTMLElement} labelsEl
 * @param {HTMLElement} dimLabelsEl         interactive committed-dimension chip layer
 * @param {()=>import("./walls.js").Snap|null} getSnap
 * @param {()=>string|null} getHighlight    measure.getHighlightRoomId
 * @param {()=>{roomId:string,edgeIndex:number}|null} getEditingEdge  dimEntry.getEditingEdge
 * @param {()=>string|null} [getSelectedRoomId]  roomTool.getSelectedRoomId (LLD 63)
 */
export function init(gWorld, gDraft, gSnap, labelsEl, dimLabelsEl, getSnap, getHighlight, getEditingEdge, getSelectedRoomId) {
  _gWorld       = gWorld;
  _gDraft       = gDraft;
  _gSnap        = gSnap;
  _labelsEl     = labelsEl;
  _dimLabelsEl  = dimLabelsEl;
  _getSnap      = getSnap;
  _getHighlight = getHighlight  || (() => null);
  _getEditingEdge = getEditingEdge || (() => null);
  _getSelectedRoomId = getSelectedRoomId || (() => null);
}

/**
 * Full idempotent redraw: committed rooms, active chain + rubber band,
 * snap glyph, and drawing-time length chips.
 * Called from surface.js _doRender.
 */
export function render() {
  if (!_gWorld) return;
  _clearGroup(_gWorld);
  _clearGroup(_gDraft);
  _clearGroup(_gSnap);
  _clearLabels();
  _clearDimLabels();

  const p = palette();
  const snap = _getSnap();
  const ppm = pxPerM();
  const highlightId = _getHighlight();
  const editingEdge = _getEditingEdge();
  const selectedRoomId = _getSelectedRoomId();

  // ── Committed rooms ────────────────────────────────────────────────────────
  for (const room of model.rooms) {
    _renderRoom(room, p, ppm, highlightId === room.id, selectedRoomId === room.id);
  }

  // ── Interactive dimension chips for committed rooms ─────────────────────────
  for (const room of model.rooms) {
    _renderDimChips(room, editingEdge);
  }

  // ── Active chain (draft) ───────────────────────────────────────────────────
  const chain = model.chain;
  if (chain.length >= 2) {
    _renderChainSegments(_gDraft, chain, p, ppm, true /* showLengths */);
    _renderVertexDots(_gDraft, chain, p.wallLine);
  } else if (chain.length === 1) {
    _renderVertexDots(_gDraft, chain, p.wallLine);
  }

  // ── Rubber-band segment ────────────────────────────────────────────────────
  if (chain.length >= 1 && snap !== null) {
    const last = chain[chain.length - 1];
    const p0 = worldToScreen(last.x, last.y);
    const p1 = worldToScreen(snap.x, snap.y);
    const line = _makeLine(p0.x, p0.y, p1.x, p1.y);
    line.setAttribute("stroke", p.draft);
    line.setAttribute("stroke-width", "1.5");
    line.setAttribute("stroke-dasharray", "6 4");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("fill", "none");
    _gDraft.appendChild(line);

    // Length chip on rubber-band
    const dx = snap.x - last.x;
    const dy = snap.y - last.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      const mx = (p0.x + p1.x) / 2;
      const my = (p0.y + p1.y) / 2;
      _addLengthChip(len, mx, my, true /* live */);
    }
  }

  // ── Close-preview fill (green polygon preview when close snap) ─────────────
  if (snap !== null && snap.type === "close" && chain.length >= 2) {
    const previewVerts = [...chain, { x: snap.x, y: snap.y }];
    const poly = _buildPolygon(previewVerts);
    poly.setAttribute("fill", p.roomFill);
    poly.setAttribute("stroke", p.snapClose);
    poly.setAttribute("stroke-width", "1");
    poly.setAttribute("stroke-dasharray", "4 3");
    poly.setAttribute("fill-opacity", "0.5");
    _gDraft.appendChild(poly);
  }

  // ── Snap glyph ─────────────────────────────────────────────────────────────
  if (snap !== null) {
    _renderSnapGlyph(snap, p);
  }
}

// ── Private: committed room rendering ────────────────────────────────────────

function _renderRoom(room, p, ppm, highlighted, selected) {
  const pts = room.verts;
  if (pts.length === 0) return;

  const fillColor = highlighted ? p.roomFillHi : (room.color || p.roomFill);
  const lineColor = highlighted ? p.wallLineHi : p.wallLine;

  // Fill (closed rooms only)
  if (room.closed && pts.length >= 3) {
    const fill = _buildPolygon(pts);
    fill.setAttribute("fill", fillColor);
    fill.setAttribute("stroke", "none");
    _gWorld.appendChild(fill);
  }

  // Wall body (thick translucent stroke along the polyline / polygon)
  const wallPx = Math.max(6, WALL_M * ppm);
  if (pts.length >= 2) {
    const body = room.closed ? _buildPolygon(pts) : _buildPolyline(pts);
    body.setAttribute("fill", "none");
    body.setAttribute("stroke", p.wallBody);
    body.setAttribute("stroke-width", String(wallPx));
    body.setAttribute("stroke-linejoin", "round");
    body.setAttribute("stroke-linecap", "round");
    _gWorld.appendChild(body);
  }

  // Centerline (crisp thin line)
  if (pts.length >= 2) {
    const center = room.closed ? _buildPolygon(pts) : _buildPolyline(pts);
    center.setAttribute("fill", "none");
    center.setAttribute("stroke", lineColor);
    center.setAttribute("stroke-width", highlighted ? "2" : "1.5");
    center.setAttribute("stroke-linejoin", "round");
    center.setAttribute("stroke-linecap", "round");
    _gWorld.appendChild(center);
  }

  // Vertex dots
  _renderVertexDots(_gWorld, pts, lineColor);

  // Selection outline (LLD 63): a distinct 1.5px dashed gold outline drawn on top
  // of the normal room render, kept SEPARATE from the measure-hover `highlighted`
  // treatment so "selected" reads differently from "hovered". Not OR-ed into the
  // solid roomFillHi hover.
  if (selected && pts.length >= 2) {
    const outline = room.closed ? _buildPolygon(pts) : _buildPolyline(pts);
    outline.setAttribute("fill", "none");
    outline.setAttribute("stroke", p.snapPoint);
    outline.setAttribute("stroke-width", "1.5");
    outline.setAttribute("stroke-dasharray", "6 4");
    outline.setAttribute("stroke-linejoin", "round");
    outline.setAttribute("stroke-linecap", "round");
    _gWorld.appendChild(outline);
  }
}

// ── Private: interactive committed dimension chips ────────────────────────────

/**
 * Render one interactive dim-chip per edge into _dimLabelsEl.
 * Skips the edge currently being edited (getEditingEdge).
 * @param {import("./walls.js").Room} room
 * @param {{roomId:string,edgeIndex:number}|null} editingEdge
 */
function _renderDimChips(room, editingEdge) {
  if (!_dimLabelsEl) return;
  const pts = room.verts;
  const n = pts.length;
  if (n < 2) return;

  const edgeCount = room.closed ? n : n - 1;

  for (let i = 0; i < edgeCount; i++) {
    const iA = i;
    const iB = room.closed ? (i + 1) % n : i + 1;

    // Skip the chip for the edge currently being edited
    if (editingEdge && editingEdge.roomId === room.id && editingEdge.edgeIndex === i) {
      continue;
    }

    const a = pts[iA];
    const b = pts[iB];
    const len = edgeLength(a, b);
    if (len === 0) continue;

    const pa = worldToScreen(a.x, a.y);
    const pb = worldToScreen(b.x, b.y);
    const mx = (pa.x + pb.x) / 2;
    const my = (pa.y + pb.y) / 2;

    const labelText = fmtLen(len) + " " + unitLabel();

    const btn = document.createElement("button");
    btn.className = "dim-chip";
    btn.setAttribute("data-room-id", room.id);
    btn.setAttribute("data-edge", String(i));
    btn.setAttribute("aria-label", `Wall length ${labelText}, click to edit`);
    btn.textContent = labelText;
    btn.style.left = mx + "px";
    btn.style.top  = my + "px";
    _dimLabelsEl.appendChild(btn);
  }
}

// ── Private: chain segment rendering ─────────────────────────────────────────

function _renderChainSegments(parent, chain, p, ppm, showLengths) {
  const wallPx = Math.max(6, WALL_M * ppm);

  // Wall body
  const body = _buildPolyline(chain);
  body.setAttribute("fill", "none");
  body.setAttribute("stroke", p.wallBody);
  body.setAttribute("stroke-width", String(wallPx));
  body.setAttribute("stroke-linejoin", "round");
  body.setAttribute("stroke-linecap", "round");
  parent.appendChild(body);

  // Centerline
  const center = _buildPolyline(chain);
  center.setAttribute("fill", "none");
  center.setAttribute("stroke", p.draft);
  center.setAttribute("stroke-width", "1.5");
  center.setAttribute("stroke-linejoin", "round");
  center.setAttribute("stroke-linecap", "round");
  parent.appendChild(center);

  // Length chips on placed segments (muted)
  if (showLengths) {
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) {
        const pa = worldToScreen(a.x, a.y);
        const pb = worldToScreen(b.x, b.y);
        _addLengthChip(len, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2, false /* muted */);
      }
    }
  }
}

// ── Private: vertex dots ──────────────────────────────────────────────────────

function _renderVertexDots(parent, verts, color) {
  for (const v of verts) {
    const s = worldToScreen(v.x, v.y);
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", String(s.x));
    dot.setAttribute("cy", String(s.y));
    dot.setAttribute("r", String(VERTEX_DOT_R));
    dot.setAttribute("fill", color);
    dot.setAttribute("stroke", "none");
    parent.appendChild(dot);
  }
}

// ── Private: snap glyph ───────────────────────────────────────────────────────

function _renderSnapGlyph(snap, p) {
  const s = worldToScreen(snap.x, snap.y);
  const sx = s.x;
  const sy = s.y;

  if (snap.type === "grid") {
    // Teal diamond + center dot
    const d = GLYPH_SIZE;
    const diamond = document.createElementNS(NS, "polygon");
    diamond.setAttribute("points", `${sx},${sy - d} ${sx + d},${sy} ${sx},${sy + d} ${sx - d},${sy}`);
    diamond.setAttribute("fill", "none");
    diamond.setAttribute("stroke", p.snapGrid);
    diamond.setAttribute("stroke-width", String(GLYPH_SW));
    _gSnap.appendChild(diamond);

    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", String(sx));
    dot.setAttribute("cy", String(sy));
    dot.setAttribute("r", "2");
    dot.setAttribute("fill", p.snapGrid);
    _gSnap.appendChild(dot);

  } else if (snap.type === "point") {
    // Gold pulsing ring + inner dot
    const ring = document.createElementNS(NS, "circle");
    ring.setAttribute("cx", String(sx));
    ring.setAttribute("cy", String(sy));
    ring.setAttribute("r", String(GLYPH_SIZE));
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", p.snapPoint);
    ring.setAttribute("stroke-width", String(GLYPH_SW));
    ring.setAttribute("class", "snap-pulse");
    _gSnap.appendChild(ring);

    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", String(sx));
    dot.setAttribute("cy", String(sy));
    dot.setAttribute("r", "3");
    dot.setAttribute("fill", p.snapPoint);
    _gSnap.appendChild(dot);

  } else if (snap.type === "close") {
    // Green pulsing ring + inner dot (close-preview fill is drawn separately in #draft)
    const ring = document.createElementNS(NS, "circle");
    ring.setAttribute("cx", String(sx));
    ring.setAttribute("cy", String(sy));
    ring.setAttribute("r", String(GLYPH_SIZE));
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", p.snapClose);
    ring.setAttribute("stroke-width", String(GLYPH_SW));
    ring.setAttribute("class", "snap-pulse");
    _gSnap.appendChild(ring);

    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", String(sx));
    dot.setAttribute("cy", String(sy));
    dot.setAttribute("r", "3");
    dot.setAttribute("fill", p.snapClose);
    _gSnap.appendChild(dot);

  } else if (snap.type === "free") {
    // Muted crosshair
    const arm = GLYPH_SIZE;
    const opacity = "0.45";
    const hLine = _makeLine(sx - arm, sy, sx + arm, sy);
    hLine.setAttribute("stroke", p.muted);
    hLine.setAttribute("stroke-width", String(GLYPH_SW));
    hLine.setAttribute("opacity", opacity);
    _gSnap.appendChild(hLine);

    const vLine = _makeLine(sx, sy - arm, sx, sy + arm);
    vLine.setAttribute("stroke", p.muted);
    vLine.setAttribute("stroke-width", String(GLYPH_SW));
    vLine.setAttribute("opacity", opacity);
    _gSnap.appendChild(vLine);
  }
}

// ── Private: length chips ─────────────────────────────────────────────────────

/**
 * Add a length chip HTML element to the labels overlay.
 * @param {number} metres   segment length in metres
 * @param {number} sx       screen x of chip center
 * @param {number} sy       screen y of chip center
 * @param {boolean} live    true = rubber-band (gold), false = placed (muted)
 */
function _addLengthChip(metres, sx, sy, live) {
  if (!_labelsEl) return;
  const chip = document.createElement("span");
  chip.className = "length-chip" + (live ? " length-chip--live" : " length-chip--placed");
  chip.textContent = fmtLen(metres) + " " + unitLabel();
  chip.style.left = sx + "px";
  chip.style.top  = sy + "px";
  _labelsEl.appendChild(chip);
}

// ── Private: SVG helpers ──────────────────────────────────────────────────────

function _clearGroup(g) {
  while (g.firstChild) g.removeChild(g.firstChild);
}

function _clearLabels() {
  if (!_labelsEl) return;
  while (_labelsEl.firstChild) _labelsEl.removeChild(_labelsEl.firstChild);
}

function _clearDimLabels() {
  if (!_dimLabelsEl) return;
  while (_dimLabelsEl.firstChild) _dimLabelsEl.removeChild(_dimLabelsEl.firstChild);
}

function _makeLine(x1, y1, x2, y2) {
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", String(x1));
  line.setAttribute("y1", String(y1));
  line.setAttribute("x2", String(x2));
  line.setAttribute("y2", String(y2));
  return line;
}

/** Build a polyline from an array of world-space vertices. */
function _buildPolyline(verts) {
  const pts = verts.map(v => {
    const s = worldToScreen(v.x, v.y);
    return `${s.x},${s.y}`;
  }).join(" ");
  const el = document.createElementNS(NS, "polyline");
  el.setAttribute("points", pts);
  return el;
}

/** Build a polygon from an array of world-space vertices. */
function _buildPolygon(verts) {
  const pts = verts.map(v => {
    const s = worldToScreen(v.x, v.y);
    return `${s.x},${s.y}`;
  }).join(" ");
  const el = document.createElementNS(NS, "polygon");
  el.setAttribute("points", pts);
  return el;
}
