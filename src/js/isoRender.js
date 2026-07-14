/**
 * isoRender.js — isometric preview renderer (LLD 128)
 *
 * Pure projection core + SVG painter. Renders a whole-plan 2.5D "peek"
 * of walls and furniture as extruded boxes using a fixed axonometric camera.
 *
 * Architecture:
 *  - Pure functions (no DOM): extrudeFootprint, buildItems, depthSort,
 *    shade, toOpaqueRgb. Unit-testable without a DOM.
 *  - render() (DOM): the surface.onRender hook. Clears #iso, short-circuits
 *    when preview is inactive, otherwise paints floor slabs + sorted boxes.
 *
 * The axonometric projection (worldToScreenIso) lives in view.js so that
 * pan/zoom handling stays inside view.js (its load-bearing invariant).
 *
 * Painter's algorithm (back-to-front): items sorted by sortKey = centroid
 * (wx+wy). Known limitation: per-object centroid sort can mis-order long walls
 * against furniture whose centroid falls "inside" that range. Documented and
 * accepted for this cut.
 */

import { worldToScreenIso, ISO_THETA, ISO_KZ, view } from "./view.js";
import { CATALOG, corners } from "./symbols.js";
import { WALL_M, MIN_SEG_M } from "./walls.js";
import { palette, getTheme } from "./theme.js";
import { pointInRoom, symbolBelongsToRoom } from "./clearance.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Whole-plan ceiling height (metres). Used for wall extrusion. */
export const CEILING_M = 2.4;

/**
 * Per-category opaque base colors for uncolored furniture, by theme.
 * Chosen to harmonise with the blueprint palette.
 * @type {Record<import("./symbols.js").SymCategory, {light:string, dark:string}>}
 */
const CATEGORY_BASE = {
  openings: { light: "#c0a870", dark: "#c9a84c" },
  living:   { light: "#a89070", dark: "#b89a60" },
  kitchen:  { light: "#8ab0b0", dark: "#6ab0b0" },
  bedroom:  { light: "#a098c8", dark: "#9090c0" },
  bath:     { light: "#7ab8d0", dark: "#5aa8c8" },
  outdoor:  { light: "#88b888", dark: "#70a870" },
};

/**
 * Tiny sort bias added to an opening's parent wall sortKey so the reveal
 * paints just over the specific wall segment it cuts (off-center included).
 * (LLD 130)
 */
const OPENING_BIAS = 1e-3;

// SVG namespace
const SVG_NS = "http://www.w3.org/2000/svg";

// ── Module state (set by initIsoRender) ───────────────────────────────────────

/** @type {SVGGElement|null} */
let _gIso = null;
/** @type {(()=>boolean)|null} */
let _getActive = null;
/** @type {(()=>("all"|string))|null} */
let _getScope = null;
/** @type {{ model: { rooms: any[], chain: any[] } }|null} */
let _wallsMod = null;
/** @type {{ model: { symbols: any[] } }|null} */
let _symbolsMod = null;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Parse an opaque hex "#rrggbb" or "rgb(r,g,b)" string to {r,g,b} (0-255).
 * Returns null if parsing fails.
 * @param {string} color
 * @returns {{r:number,g:number,b:number}|null}
 */
function _parseRgb(color) {
  // Try #rrggbb
  const hex6 = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  if (hex6) {
    return {
      r: parseInt(hex6[1], 16),
      g: parseInt(hex6[2], 16),
      b: parseInt(hex6[3], 16),
    };
  }
  // Try #rgb shorthand
  const hex3 = color.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/);
  if (hex3) {
    return {
      r: parseInt(hex3[1] + hex3[1], 16),
      g: parseInt(hex3[2] + hex3[2], 16),
      b: parseInt(hex3[3] + hex3[3], 16),
    };
  }
  // Try rgb(r,g,b) or rgba(r,g,b,a) — extract first 3 numbers
  const rgbMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) {
    return {
      r: parseInt(rgbMatch[1], 10),
      g: parseInt(rgbMatch[2], 10),
      b: parseInt(rgbMatch[3], 10),
    };
  }
  return null;
}

/**
 * Composite a possibly-alpha-bearing `color` over `bgColor` to produce an
 * opaque RGB string. If `color` is already opaque, returns it unchanged.
 * Falls back to `color` if parsing fails.
 *
 * @param {string} color    any hex or rgb(a)() string
 * @param {string} bgColor  opaque background color for compositing
 * @returns {string}  opaque "rgb(r,g,b)" string
 */
export function toOpaqueRgb(color, bgColor) {
  // Check for alpha channel in rgba()
  const rgbaMatch = color.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)/);
  if (rgbaMatch) {
    const a = parseFloat(rgbaMatch[4]);
    if (a >= 1) {
      return `rgb(${rgbaMatch[1]},${rgbaMatch[2]},${rgbaMatch[3]})`;
    }
    const fg = { r: parseInt(rgbaMatch[1], 10), g: parseInt(rgbaMatch[2], 10), b: parseInt(rgbaMatch[3], 10) };
    const bg = _parseRgb(bgColor);
    if (!bg) return `rgb(${rgbaMatch[1]},${rgbaMatch[2]},${rgbaMatch[3]})`; // best effort
    // Alpha composite: out = fg*a + bg*(1-a)
    const r = Math.round(fg.r * a + bg.r * (1 - a));
    const g = Math.round(fg.g * a + bg.g * (1 - a));
    const b = Math.round(fg.b * a + bg.b * (1 - a));
    return `rgb(${r},${g},${b})`;
  }
  // Already opaque — parse and re-emit as rgb()
  const parsed = _parseRgb(color);
  if (!parsed) return color;
  return `rgb(${parsed.r},${parsed.g},${parsed.b})`;
}

/**
 * Darken/lighten an opaque base color by multiplying its RGB channels by
 * `factor` (0..1 for darken, >1 for lighten — clamped to [0,255]).
 * `baseColor` must be opaque (no alpha); use toOpaqueRgb first.
 *
 * @param {string} baseColor  opaque hex or rgb() string
 * @param {number} factor     multiply each channel by this value
 * @returns {string}  "rgb(r,g,b)" — deterministic, no alpha
 */
export function shade(baseColor, factor) {
  const parsed = _parseRgb(baseColor);
  if (!parsed) return baseColor;
  const r = Math.min(255, Math.max(0, Math.round(parsed.r * factor)));
  const g = Math.min(255, Math.max(0, Math.round(parsed.g * factor)));
  const b = Math.min(255, Math.max(0, Math.round(parsed.b * factor)));
  return `rgb(${r},${g},${b})`;
}

// ── Geometry: wall quad footprint ─────────────────────────────────────────────

/**
 * Expand a wall edge (a→b) to a WALL_M-thick quad footprint, centered on the
 * centerline. Returns 4 world-metre corners in the footprint plane, or null
 * for degenerate edges (< MIN_SEG_M).
 *
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {{x:number,y:number}[]|null}
 */
function _wallQuad(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < MIN_SEG_M) return null;
  const nx = (-dy / len) * WALL_M / 2;
  const ny = ( dx / len) * WALL_M / 2;
  return [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny },
  ];
}

// ── Projection / extrusion ────────────────────────────────────────────────────

/**
 * Compute the visible extruded faces of a polygon footprint given the fixed
 * axonometric camera (LLD 128 §3).
 *
 * Draws:
 *  - bottom face: footprint at z0 (mostly occluded; included for ordering)
 *  - side faces: each edge whose outward normal faces the camera
 *    (camera is in the +x+y direction, so dot(normal, (1,1)) > 0)
 *  - top face: footprint at z1 (lightest shade, drawn last)
 *
 * Each face is { role:"top"|"left"|"right"|"bottom", pts:{x,y}[] } in
 * screen pixels (projected via view.worldToScreenIso).
 *
 * @param {{x:number,y:number}[]} footprint  world-metre polygon corners
 * @param {number} z0  base height (metres)
 * @param {number} z1  top height (metres)
 * @returns {{ role:"top"|"left"|"right"|"bottom", pts:{x,y}[] }[]}
 */
export function extrudeFootprint(footprint, z0, z1) {
  const n = footprint.length;
  if (n < 3) return [];

  const bottom = footprint.map(p => worldToScreenIso(p.x, p.y, z0));
  const top    = footprint.map(p => worldToScreenIso(p.x, p.y, z1));

  const faces = [];

  // Bottom face first
  faces.push({ role: "bottom", pts: bottom });

  // Footprint centroid (world metres) — used to orient each edge normal
  // outward. This is winding-independent, so it works for both furniture
  // footprints (corners(), CCW) and wall quads (_wallQuad, CW) alike.
  let fcx = 0, fcy = 0;
  for (const p of footprint) { fcx += p.x; fcy += p.y; }
  fcx /= n; fcy /= n;

  // Side faces: camera looks from the +x+y direction, so an edge is visible
  // when its OUTWARD normal has a positive dot with (1,1).
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = footprint[i].x, ay = footprint[i].y;
    const bx = footprint[j].x, by = footprint[j].y;
    const ex = bx - ax, ey = by - ay;

    // Edge perpendicular, flipped to point away from the centroid (outward).
    let nx = ey, ny = -ex;
    const mx = (ax + bx) / 2 - fcx;
    const my = (ay + by) / 2 - fcy;
    if (nx * mx + ny * my < 0) { nx = -nx; ny = -ny; }

    const dot = nx + ny; // dot(outwardNormal, cameraDir=(1,1))
    if (dot <= 0) continue; // edge faces away from camera

    const pts = [bottom[i], bottom[j], top[j], top[i]];
    // Left face: normal has (nx-ny) < 0 (roughly along world-y axis facing camera)
    // Right face: normal has (nx-ny) >= 0 (roughly along world-x axis facing camera)
    const role = (nx - ny) >= 0 ? "right" : "left";
    faces.push({ role, pts });
  }

  // Top face last
  faces.push({ role: "top", pts: top });

  return faces;
}

// ── Item builder ──────────────────────────────────────────────────────────────

/**
 * Build the list of extrudable items from filtered rooms and symbols arrays.
 *
 * Walls: iterates rooms, keeps only closed rooms. Emits one item per edge
 *   (including closing edge). Open rooms are NEVER read.
 *
 * Furniture: one item per symbol. floorLayer symbols (rugs) are emitted as
 *   flat decals (z1 ≈ z0 = 0). openings-category symbols emit kind:"opening"
 *   at [sill, head] from the catalog, with sortKey bound to the parent wall's
 *   sortKey + OPENING_BIAS (LLD 130).
 *
 * @param {{closed:boolean, verts:{x:number,y:number}[]}[]} rooms
 * @param {{id:string, type:string, x:number, y:number, w:number, h:number, rot:number, color?:string}[]} symbols
 * @returns {{ kind:"wall"|"furniture"|"rug"|"opening", footprint:{x:number,y:number}[], z0:number, z1:number, baseColor:string, sortKey:number }[]}
 */
export function buildItems(rooms, symbols) {
  const pal = palette();
  const bg = toOpaqueRgb(pal.bg, "#14140f");
  const theme = getTheme();

  // Opaque wall base: use the wallLine token (already nearly-opaque gold)
  const wallBase = toOpaqueRgb(pal.wallLine, bg);

  // Opaque recess color for opening reveals: heavily-darkened wall base (LLD 130)
  const recessBase = shade(wallBase, 0.4);

  /** @type {ReturnType<typeof buildItems>} */
  const items = [];

  // ── Walls ────────────────────────────────────────────────────────────────
  // Retain wall centerline endpoints + sortKey for opening parent-binding.
  /** @type {{ a:{x:number,y:number}, b:{x:number,y:number}, sortKey:number }[]} */
  const wallEdges = [];

  for (const room of rooms) {
    if (!room.closed) continue;
    const verts = room.verts;
    const n = verts.length;
    if (n < 2) continue;

    for (let i = 0; i < n; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % n];
      const quad = _wallQuad(a, b);
      if (!quad) continue;

      let cx = 0, cy = 0;
      for (const p of quad) { cx += p.x; cy += p.y; }
      cx /= quad.length; cy /= quad.length;
      const sk = cx + cy;

      items.push({
        kind: "wall",
        footprint: quad,
        z0: 0,
        z1: CEILING_M,
        baseColor: wallBase,
        sortKey: sk,
      });

      // Retain centerline for opening binding (LLD 130)
      wallEdges.push({ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, sortKey: sk });
    }
  }

  // ── Symbols ──────────────────────────────────────────────────────────────
  for (const sym of symbols) {
    const cat = CATALOG[sym.type];
    if (!cat) continue;

    const isRug = !!cat.floorLayer;
    const isOpening = !!cat.openings;

    // ── Opening reveal (LLD 130) ─────────────────────────────────────────
    if (isOpening) {
      const z0 = cat.sill ?? 0;
      const z1 = Math.min(cat.head ?? cat.z, CEILING_M); // clamped to wall top

      const footprint = corners(sym);

      // Find parent wall: wall segment minimising squared point-to-segment distance
      // from the opening center to the segment a→b. This guarantees the reveal
      // sorts immediately after the exact wall it cuts (off-center included).
      let parentSortKey = null;
      let minDist2 = Infinity;
      for (const edge of wallEdges) {
        const d2 = _pointToSegDist2(sym.x, sym.y, edge.a, edge.b);
        if (d2 < minDist2) {
          minDist2 = d2;
          parentSortKey = edge.sortKey;
        }
      }

      // Fallback: own-centroid if no wall exists (opening on open polyline, EC2)
      let ownCx = 0, ownCy = 0;
      for (const p of footprint) { ownCx += p.x; ownCy += p.y; }
      ownCx /= footprint.length; ownCy /= footprint.length;

      const sortKey = parentSortKey !== null
        ? parentSortKey + OPENING_BIAS
        : ownCx + ownCy + OPENING_BIAS;

      items.push({
        kind: "opening",
        footprint,
        z0,
        z1,
        baseColor: recessBase,
        sortKey,
      });
      continue;
    }

    const z1 = isRug ? 0 : (cat.z ?? 0.75);

    // Resolve opaque base color
    let baseColor;
    if (sym.color) {
      baseColor = toOpaqueRgb(sym.color, bg);
    } else {
      const catBase = CATEGORY_BASE[cat.category];
      if (catBase) {
        baseColor = toOpaqueRgb(catBase[theme] || catBase.dark, bg);
      } else {
        baseColor = wallBase;
      }
    }

    const footprint = corners(sym);

    let cx = 0, cy = 0;
    for (const p of footprint) { cx += p.x; cy += p.y; }
    cx /= footprint.length; cy /= footprint.length;

    items.push({
      kind: isRug ? "rug" : "furniture",
      footprint,
      z0: 0,
      z1,
      baseColor,
      sortKey: cx + cy,
    });
  }

  return items;
}

/**
 * Squared point-to-segment distance from (px,py) to segment a→b. Pure.
 * @param {number} px
 * @param {number} py
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {number}
 */
function _pointToSegDist2(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-18) {
    // degenerate segment — point-to-point
    return (px - a.x) ** 2 + (py - a.y) ** 2;
  }
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lenSq));
  const qx = a.x + t * dx, qy = a.y + t * dy;
  return (px - qx) ** 2 + (py - qy) ** 2;
}

/**
 * Stable back-to-front sort of items (ascending sortKey). Pure; returns a
 * new array without mutating the input.
 *
 * @param {ReturnType<typeof buildItems>} items
 * @returns {ReturnType<typeof buildItems>}
 */
export function depthSort(items) {
  return items.slice().sort((a, b) => a.sortKey - b.sortKey);
}

// ── Scope filter (LLD 130) ────────────────────────────────────────────────────

/**
 * Filter live models to the in-scope subset. Pure.
 *
 * "all" → the models' rooms and symbols unchanged.
 * A room id → that single closed room (if it resolves) + the symbols belonging
 * to it, decided by clearance.symbolBelongsToRoom (furniture by center-in-room;
 * openings by near-wall). An unresolved id behaves as "all" (fail-safe).
 *
 * @param {{ rooms: any[] }} wallsModel
 * @param {{ symbols: any[] }} symbolsModel
 * @param {"all"|string} scopeId
 * @returns {{ rooms: any[], symbols: any[] }}
 */
export function scopeFilter(wallsModel, symbolsModel, scopeId) {
  if (scopeId === "all") {
    return { rooms: wallsModel.rooms, symbols: symbolsModel.symbols };
  }
  // Find the target closed room
  const room = wallsModel.rooms.find(r => r.id === scopeId && r.closed);
  if (!room) {
    // Stale / unresolved id — fail-safe: treat as "all"
    return { rooms: wallsModel.rooms, symbols: symbolsModel.symbols };
  }
  const rooms = [room];
  const symbols = symbolsModel.symbols.filter(sym => symbolBelongsToRoom(room, sym));
  return { rooms, symbols };
}

/**
 * Folded-world AABB of the in-scope geometry for framing. Pure, no pan/zoom.
 *
 * Takes the BUILT-items list (buildItems output); folds each item's footprint
 * corners at z0 and z1 with the iso projection math and returns
 * { minX, minY, maxX, maxY } in folded-world metres for view.fitToContent.
 * Returns null when the items list is empty.
 *
 * @param {ReturnType<typeof buildItems>} items
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}
 */
export function isoBounds(items) {
  if (items.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const cos = Math.cos(Math.PI / 6); // ISO_THETA
  const sin = Math.sin(Math.PI / 6);
  const kz  = 0.82;                  // ISO_KZ

  for (const item of items) {
    for (const z of [item.z0, item.z1]) {
      for (const p of item.footprint) {
        // iso fold (without pan/zoom — gives the "folded world" coords)
        const fx = (p.x - p.y) * cos;
        const fy = (p.x + p.y) * sin - z * kz;
        if (fx < minX) minX = fx;
        if (fx > maxX) maxX = fx;
        if (fy < minY) minY = fy;
        if (fy > maxY) maxY = fy;
      }
    }
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

// ── DOM: initialise ───────────────────────────────────────────────────────────

/**
 * Bind SVG group, preview-active getter, scope getter, and model refs.
 * Call once from main.js.
 *
 * @param {SVGGElement} gIso
 * @param {()=>boolean} getActive
 * @param {()=>("all"|string)} getScope
 * @param {{ model: object }} wallsMod
 * @param {{ model: object }} symbolsMod
 */
export function initIsoRender(gIso, getActive, getScope, wallsMod, symbolsMod) {
  _gIso = gIso;
  _getActive = getActive;
  _getScope = getScope;
  _wallsMod = wallsMod;
  _symbolsMod = symbolsMod;
}

// ── DOM: render hook ──────────────────────────────────────────────────────────

/**
 * surface.onRender hook (LLD 128, extended in LLD 130).
 *
 * When preview is OFF: clears #iso (returns quickly — 2D layers remain).
 * When preview is ON:  clears #iso, applies scopeFilter, builds items from
 *   live models, sorts back-to-front, paints floor slabs + box faces as SVG
 *   polygons. Openings render as recessed dark reveals at [sill, head].
 *   Empty scope → shows a "No walls to preview" hint text.
 *
 * Never mutates walls.model or symbols.model (read-only guarantee).
 */
export function render() {
  if (!_gIso) return;
  while (_gIso.firstChild) _gIso.removeChild(_gIso.firstChild);
  if (!_getActive || !_getActive()) return;
  if (!_wallsMod || !_symbolsMod) return;

  const wallsModel   = /** @type {any} */ (_wallsMod.model);
  const symbolsModel = /** @type {any} */ (_symbolsMod.model);
  const pal = palette();

  // Apply scope filter (LLD 130)
  const scopeId = _getScope ? _getScope() : "all";
  const { rooms, symbols } = scopeFilter(wallsModel, symbolsModel, scopeId);

  // ── Empty state ───────────────────────────────────────────────────────────
  // Show hint when there are no closed rooms (no wall geometry to extrude).
  // Symbols-only (e.g. a rug with no walls) are still rendered — no early return.
  const hasClosedRooms = rooms.some(r => r.closed && r.verts && r.verts.length >= 3);
  if (!hasClosedRooms && symbols.length === 0) {
    const txt = document.createElementNS(SVG_NS, "text");
    txt.setAttribute("x", "50%");
    txt.setAttribute("y", "50%");
    txt.setAttribute("text-anchor", "middle");
    txt.setAttribute("dominant-baseline", "middle");
    txt.setAttribute("fill", pal.wallLine || "#c9a84c");
    txt.setAttribute("fill-opacity", "0.45");
    txt.setAttribute("font-size", "14");
    txt.textContent = "No walls to preview";
    _gIso.appendChild(txt);
    return;
  }

  // ── Floor slabs (drawn first, behind all boxes) ───────────────────────────
  for (const room of rooms) {
    if (!room.closed) continue;
    const verts = room.verts;
    if (verts.length < 3) continue;

    const projPts = verts.map(v => worldToScreenIso(v.x, v.y, 0));
    const poly = document.createElementNS(SVG_NS, "polygon");
    poly.setAttribute("points", projPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
    poly.setAttribute("fill", pal.roomFill || "rgba(201,168,76,0.07)");
    poly.setAttribute("fill-opacity", "0.55");
    poly.setAttribute("stroke", "none");
    _gIso.appendChild(poly);
  }

  // ── Extruded boxes ────────────────────────────────────────────────────────
  const items = depthSort(buildItems(rooms, symbols));

  for (const item of items) {
    if (item.footprint.length < 3) continue;

    if (item.kind === "rug") {
      // Flat decal — top face only
      const projPts = item.footprint.map(p => worldToScreenIso(p.x, p.y, 0));
      const poly = document.createElementNS(SVG_NS, "polygon");
      poly.setAttribute("points", projPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
      poly.setAttribute("fill", item.baseColor);
      poly.setAttribute("fill-opacity", "0.6");
      poly.setAttribute("stroke", "none");
      _gIso.appendChild(poly);
      continue;
    }

    // Opening reveal (LLD 130): extruded at [sill, head] with darker recess shades
    // Wall box is unmodified beneath it — reads as wall-with-an-opening.
    if (item.kind === "opening") {
      const faces = extrudeFootprint(item.footprint, item.z0, item.z1);
      for (const face of faces) {
        if (face.pts.length < 3) continue;
        // Darker shading for the recess to read as shadow/depth
        let fillColor;
        switch (face.role) {
          case "top":    fillColor = shade(item.baseColor, 0.80); break;
          case "left":   fillColor = shade(item.baseColor, 0.60); break;
          case "right":  fillColor = shade(item.baseColor, 0.50); break;
          case "bottom": fillColor = shade(item.baseColor, 0.35); break;
          default:       fillColor = item.baseColor;
        }
        const poly = document.createElementNS(SVG_NS, "polygon");
        poly.setAttribute("points", face.pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
        poly.setAttribute("fill", fillColor);
        poly.setAttribute("stroke", "none");
        _gIso.appendChild(poly);
      }
      continue;
    }

    const faces = extrudeFootprint(item.footprint, item.z0, item.z1);
    for (const face of faces) {
      if (face.pts.length < 3) continue;

      let fillColor;
      switch (face.role) {
        case "top":    fillColor = shade(item.baseColor, 1.0);  break;
        case "left":   fillColor = shade(item.baseColor, 0.72); break;
        case "right":  fillColor = shade(item.baseColor, 0.58); break;
        case "bottom": fillColor = shade(item.baseColor, 0.45); break;
        default:       fillColor = item.baseColor;
      }

      const poly = document.createElementNS(SVG_NS, "polygon");
      poly.setAttribute("points", face.pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
      poly.setAttribute("fill", fillColor);
      poly.setAttribute("stroke", "none");
      _gIso.appendChild(poly);
    }
  }
}
