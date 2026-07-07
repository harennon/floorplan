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
import { fmtLen, unitLabel, fmtArea, areaUnitLabel } from "./units.js";
import { model, WALL_M, canClose, edgeCount, edgeEndpoints, polygonArea, polygonPerimeter, centroid } from "./walls.js";

const NS = "http://www.w3.org/2000/svg";

// Palette tokens (from LLD / Direction A)
const WALL_BODY_COLOR = "rgba(201,168,76,0.30)";
const WALL_LINE_COLOR = "#d9be6e";
const DRAFT_COLOR     = "#d9be6e";
const ROOM_FILL_COLOR = "rgba(201,168,76,0.07)";
const SNAP_GRID_COLOR = "#7fd0c8";
const SNAP_POINT_COLOR = "#e0b64f";
const SNAP_CLOSE_COLOR = "#9cd67a";

// Snap glyph metrics (screen-constant)
const VERTEX_DOT_R = 3;
const GLYPH_SIZE   = 10;    // half-size for diamond / radius for ring
const GLYPH_SW     = 1.5;   // glyph stroke width

// DOM refs
let _gWorld    = null;
let _gDraft    = null;
let _gSnap     = null;
let _labelsEl  = null;
let _dimLayerEl = null;

// Injected getter for current snap (set via init, populated by wallTool)
let _getSnap = () => null;

/**
 * Bind mount points. Called once from main.js.
 * @param {SVGGElement} gWorld
 * @param {SVGGElement} gDraft
 * @param {SVGGElement} gSnap
 * @param {HTMLElement} labelsEl
 * @param {HTMLElement} dimLayerEl  - the .dim-layer overlay (NOT aria-hidden)
 * @param {()=>import("./walls.js").Snap|null} getSnap
 */
export function init(gWorld, gDraft, gSnap, labelsEl, dimLayerEl, getSnap) {
  _gWorld     = gWorld;
  _gDraft     = gDraft;
  _gSnap      = gSnap;
  _labelsEl   = labelsEl;
  _dimLayerEl = dimLayerEl;
  _getSnap    = getSnap;
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
  _clearDimLayer();

  const snap = _getSnap();
  const ppm = pxPerM();

  // ── Committed rooms ────────────────────────────────────────────────────────
  for (const room of model.rooms) {
    _renderRoom(room, ppm);
  }

  // ── Active chain (draft) ───────────────────────────────────────────────────
  const chain = model.chain;
  if (chain.length >= 2) {
    _renderChainSegments(_gDraft, chain, ppm, true /* showLengths */);
    _renderVertexDots(_gDraft, chain, WALL_LINE_COLOR);
  } else if (chain.length === 1) {
    _renderVertexDots(_gDraft, chain, WALL_LINE_COLOR);
  }

  // ── Rubber-band segment ────────────────────────────────────────────────────
  if (chain.length >= 1 && snap !== null) {
    const last = chain[chain.length - 1];
    const p0 = worldToScreen(last.x, last.y);
    const p1 = worldToScreen(snap.x, snap.y);
    const line = _makeLine(p0.x, p0.y, p1.x, p1.y);
    line.setAttribute("stroke", DRAFT_COLOR);
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
    poly.setAttribute("fill", ROOM_FILL_COLOR);
    poly.setAttribute("stroke", SNAP_CLOSE_COLOR);
    poly.setAttribute("stroke-width", "1");
    poly.setAttribute("stroke-dasharray", "4 3");
    poly.setAttribute("fill-opacity", "0.5");
    _gDraft.appendChild(poly);
  }

  // ── Snap glyph ─────────────────────────────────────────────────────────────
  if (snap !== null) {
    _renderSnapGlyph(snap, ppm);
  }
}

// ── Private: committed room rendering ────────────────────────────────────────

function _renderRoom(room, ppm) {
  const pts = room.verts;
  if (pts.length === 0) return;

  // Fill (closed rooms only)
  if (room.closed && pts.length >= 3) {
    const fill = _buildPolygon(pts);
    fill.setAttribute("fill", ROOM_FILL_COLOR);
    fill.setAttribute("stroke", "none");
    _gWorld.appendChild(fill);
  }

  // Wall body (thick translucent stroke along the polyline / polygon)
  const wallPx = Math.max(6, WALL_M * ppm);
  if (pts.length >= 2) {
    const body = room.closed ? _buildPolygon(pts) : _buildPolyline(pts);
    body.setAttribute("fill", "none");
    body.setAttribute("stroke", WALL_BODY_COLOR);
    body.setAttribute("stroke-width", String(wallPx));
    body.setAttribute("stroke-linejoin", "round");
    body.setAttribute("stroke-linecap", "round");
    _gWorld.appendChild(body);
  }

  // Centerline (crisp thin line)
  if (pts.length >= 2) {
    const center = room.closed ? _buildPolygon(pts) : _buildPolyline(pts);
    center.setAttribute("fill", "none");
    center.setAttribute("stroke", WALL_LINE_COLOR);
    center.setAttribute("stroke-width", "1.5");
    center.setAttribute("stroke-linejoin", "round");
    center.setAttribute("stroke-linecap", "round");
    _gWorld.appendChild(center);
  }

  // Vertex dots
  _renderVertexDots(_gWorld, pts, WALL_LINE_COLOR);

  // Dimension chips on each committed edge (interactive, into .dim-layer)
  const n = edgeCount(room);
  for (let i = 0; i < n; i++) {
    const [a, b] = edgeEndpoints(room, i);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      const pa = worldToScreen(a.x, a.y);
      const pb = worldToScreen(b.x, b.y);
      _addDimChip(len, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2, room.id, i);
    }
  }

  // Room tag at centroid (closed rooms only, with min-size gate)
  if (room.closed && pts.length >= 3) {
    _renderRoomTag(room, ppm);
  }
}

// ── Private: chain segment rendering ─────────────────────────────────────────

function _renderChainSegments(parent, chain, ppm, showLengths) {
  const wallPx = Math.max(6, WALL_M * ppm);

  // Wall body
  const body = _buildPolyline(chain);
  body.setAttribute("fill", "none");
  body.setAttribute("stroke", WALL_BODY_COLOR);
  body.setAttribute("stroke-width", String(wallPx));
  body.setAttribute("stroke-linejoin", "round");
  body.setAttribute("stroke-linecap", "round");
  parent.appendChild(body);

  // Centerline
  const center = _buildPolyline(chain);
  center.setAttribute("fill", "none");
  center.setAttribute("stroke", DRAFT_COLOR);
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

function _renderSnapGlyph(snap, ppm) {
  const s = worldToScreen(snap.x, snap.y);
  const sx = s.x;
  const sy = s.y;

  if (snap.type === "grid") {
    // Teal diamond + center dot
    const d = GLYPH_SIZE;
    const diamond = document.createElementNS(NS, "polygon");
    diamond.setAttribute("points", `${sx},${sy - d} ${sx + d},${sy} ${sx},${sy + d} ${sx - d},${sy}`);
    diamond.setAttribute("fill", "none");
    diamond.setAttribute("stroke", SNAP_GRID_COLOR);
    diamond.setAttribute("stroke-width", String(GLYPH_SW));
    _gSnap.appendChild(diamond);

    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", String(sx));
    dot.setAttribute("cy", String(sy));
    dot.setAttribute("r", "2");
    dot.setAttribute("fill", SNAP_GRID_COLOR);
    _gSnap.appendChild(dot);

  } else if (snap.type === "point") {
    // Gold pulsing ring + inner dot
    const ring = document.createElementNS(NS, "circle");
    ring.setAttribute("cx", String(sx));
    ring.setAttribute("cy", String(sy));
    ring.setAttribute("r", String(GLYPH_SIZE));
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", SNAP_POINT_COLOR);
    ring.setAttribute("stroke-width", String(GLYPH_SW));
    ring.setAttribute("class", "snap-pulse");
    _gSnap.appendChild(ring);

    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", String(sx));
    dot.setAttribute("cy", String(sy));
    dot.setAttribute("r", "3");
    dot.setAttribute("fill", SNAP_POINT_COLOR);
    _gSnap.appendChild(dot);

  } else if (snap.type === "close") {
    // Green pulsing ring + inner dot (close-preview fill is drawn separately in #draft)
    const ring = document.createElementNS(NS, "circle");
    ring.setAttribute("cx", String(sx));
    ring.setAttribute("cy", String(sy));
    ring.setAttribute("r", String(GLYPH_SIZE));
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", SNAP_CLOSE_COLOR);
    ring.setAttribute("stroke-width", String(GLYPH_SW));
    ring.setAttribute("class", "snap-pulse");
    _gSnap.appendChild(ring);

    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", String(sx));
    dot.setAttribute("cy", String(sy));
    dot.setAttribute("r", "3");
    dot.setAttribute("fill", SNAP_CLOSE_COLOR);
    _gSnap.appendChild(dot);

  } else if (snap.type === "free") {
    // Muted crosshair
    const arm = GLYPH_SIZE;
    const opacity = "0.45";
    const hLine = _makeLine(sx - arm, sy, sx + arm, sy);
    hLine.setAttribute("stroke", WALL_LINE_COLOR);
    hLine.setAttribute("stroke-width", String(GLYPH_SW));
    hLine.setAttribute("opacity", opacity);
    _gSnap.appendChild(hLine);

    const vLine = _makeLine(sx, sy - arm, sx, sy + arm);
    vLine.setAttribute("stroke", WALL_LINE_COLOR);
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

/**
 * Add an interactive dimension chip to the .dim-layer overlay.
 * @param {number} metres    segment length in metres
 * @param {number} sx        screen x of chip center
 * @param {number} sy        screen y of chip center
 * @param {string} roomId    data attribute for delegation
 * @param {number} edgeIndex data attribute for delegation
 */
function _addDimChip(metres, sx, sy, roomId, edgeIndex) {
  if (!_dimLayerEl) return;
  const chip = document.createElement("span");
  chip.className = "dim-chip";
  chip.textContent = fmtLen(metres) + " " + unitLabel();
  chip.style.left = sx + "px";
  chip.style.top  = sy + "px";
  chip.dataset.roomId    = roomId;
  chip.dataset.edgeIndex = String(edgeIndex);
  chip.setAttribute("tabindex", "0");
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-label", "Edit wall: " + fmtLen(metres) + " " + unitLabel());
  _dimLayerEl.appendChild(chip);
}

/**
 * Render the centroid area+perimeter tag for a closed room.
 * Suppresses the tag if the room's on-screen bounding box is too small (Edge Case 8).
 * @param {import("./walls.js").Room} room
 * @param {number} ppm  pixels per metre
 */
function _renderRoomTag(room, ppm) {
  if (!_dimLayerEl) return;
  const pts = room.verts;

  // Compute screen bounding box
  let minSx = Infinity, maxSx = -Infinity;
  let minSy = Infinity, maxSy = -Infinity;
  for (const v of pts) {
    const s = worldToScreen(v.x, v.y);
    if (s.x < minSx) minSx = s.x;
    if (s.x > maxSx) maxSx = s.x;
    if (s.y < minSy) minSy = s.y;
    if (s.y > maxSy) maxSy = s.y;
  }
  const boxW = maxSx - minSx;
  const boxH = maxSy - minSy;
  const MIN_TAG_PX = 64;
  if (boxW < MIN_TAG_PX || boxH < MIN_TAG_PX) return;

  const area      = polygonArea(pts);
  const perimeter = polygonPerimeter(pts, true);
  const c         = centroid(pts);
  const sc        = worldToScreen(c.x, c.y);

  const tag = document.createElement("div");
  tag.className = "room-tag";
  tag.style.left = sc.x + "px";
  tag.style.top  = sc.y + "px";

  const areaLine = document.createElement("div");
  areaLine.textContent = fmtArea(area) + " " + areaUnitLabel();
  const perimLine = document.createElement("div");
  perimLine.textContent = fmtLen(perimeter) + " " + unitLabel();

  tag.appendChild(areaLine);
  tag.appendChild(perimLine);
  _dimLayerEl.appendChild(tag);
}

// ── Private: SVG helpers ──────────────────────────────────────────────────────

function _clearGroup(g) {
  while (g.firstChild) g.removeChild(g.firstChild);
}

function _clearLabels() {
  if (!_labelsEl) return;
  while (_labelsEl.firstChild) _labelsEl.removeChild(_labelsEl.firstChild);
}

function _clearDimLayer() {
  if (!_dimLayerEl) return;
  while (_dimLayerEl.firstChild) _dimLayerEl.removeChild(_dimLayerEl.firstChild);
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
