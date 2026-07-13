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

import { worldToScreenIso } from "./view.js";
import { CATALOG, corners } from "./symbols.js";
import { WALL_M, MIN_SEG_M } from "./walls.js";
import { palette, getTheme } from "./theme.js";

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

// SVG namespace
const SVG_NS = "http://www.w3.org/2000/svg";

// ── Module state (set by initIsoRender) ───────────────────────────────────────

/** @type {SVGGElement|null} */
let _gIso = null;
/** @type {(()=>boolean)|null} */
let _getActive = null;
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

  // Side faces: camera looks from +x+y direction
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = footprint[i].x, ay = footprint[i].y;
    const bx = footprint[j].x, by = footprint[j].y;
    const ex = bx - ax, ey = by - ay;

    // Two candidate outward normals (CW and CCW orientation)
    const nx1 =  ey, ny1 = -ex;
    const nx2 = -ey, ny2 =  ex;
    const dot1 = nx1 + ny1;
    const dot2 = nx2 + ny2;
    const dot = Math.max(dot1, dot2);
    if (dot <= 0) continue; // edge faces away from camera

    const pts = [bottom[i], bottom[j], top[j], top[i]];
    // Left face: normal has (nx-ny) < 0 (roughly along world-y axis facing camera)
    // Right face: normal has (nx-ny) >= 0 (roughly along world-x axis facing camera)
    const winner = (dot1 >= dot2) ? { nx: nx1, ny: ny1 } : { nx: nx2, ny: ny2 };
    const role = (winner.nx - winner.ny) >= 0 ? "right" : "left";
    faces.push({ role, pts });
  }

  // Top face last
  faces.push({ role: "top", pts: top });

  return faces;
}

// ── Item builder ──────────────────────────────────────────────────────────────

/**
 * Build the list of extrudable items from the provided models.
 *
 * Walls: iterates wallsModel.rooms, keeps only closed rooms. Emits one item
 *   per edge (including closing edge). Open rooms and wallsModel.chain are
 *   NEVER read (ensures open walls and the draft chain don't appear).
 *
 * Furniture: one item per symbol. floorLayer symbols (rugs) are emitted as
 *   flat decals (z1 ≈ z0 = 0), not boxes.
 *
 * @param {{ rooms: {closed:boolean, verts:{x:number,y:number}[]}[], chain: any[] }} wallsModel
 * @param {{ symbols: {id:string, type:string, x:number, y:number, w:number, h:number, rot:number, color?:string}[] }} symbolsModel
 * @returns {{ kind:"wall"|"furniture"|"rug", footprint:{x:number,y:number}[], z0:number, z1:number, baseColor:string, sortKey:number }[]}
 */
export function buildItems(wallsModel, symbolsModel) {
  const pal = palette();
  const bg = toOpaqueRgb(pal.bg, "#14140f");
  const theme = getTheme();

  // Opaque wall base: use the wallLine token (already nearly-opaque gold)
  const wallBase = toOpaqueRgb(pal.wallLine, bg);

  /** @type {ReturnType<typeof buildItems>} */
  const items = [];

  // ── Walls ────────────────────────────────────────────────────────────────
  for (const room of wallsModel.rooms) {
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

      items.push({
        kind: "wall",
        footprint: quad,
        z0: 0,
        z1: CEILING_M,
        baseColor: wallBase,
        sortKey: cx + cy,
      });
    }
  }

  // ── Symbols ──────────────────────────────────────────────────────────────
  for (const sym of symbolsModel.symbols) {
    const cat = CATALOG[sym.type];
    if (!cat) continue;

    const isRug = !!cat.floorLayer;
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
 * Stable back-to-front sort of items (ascending sortKey). Pure; returns a
 * new array without mutating the input.
 *
 * @param {ReturnType<typeof buildItems>} items
 * @returns {ReturnType<typeof buildItems>}
 */
export function depthSort(items) {
  return items.slice().sort((a, b) => a.sortKey - b.sortKey);
}

// ── DOM: initialise ───────────────────────────────────────────────────────────

/**
 * Bind SVG group, preview-active getter, and model refs. Call once from main.js.
 *
 * @param {SVGGElement} gIso
 * @param {()=>boolean} getActive
 * @param {{ model: object }} wallsMod
 * @param {{ model: object }} symbolsMod
 */
export function initIsoRender(gIso, getActive, wallsMod, symbolsMod) {
  _gIso = gIso;
  _getActive = getActive;
  _wallsMod = wallsMod;
  _symbolsMod = symbolsMod;
}

// ── DOM: render hook ──────────────────────────────────────────────────────────

/**
 * surface.onRender hook (LLD 128).
 *
 * When preview is OFF: clears #iso (returns quickly — 2D layers remain).
 * When preview is ON:  clears #iso, builds items from live models, sorts
 *   back-to-front, paints floor slabs + box faces as SVG polygons.
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

  // ── Floor slabs (drawn first, behind all boxes) ───────────────────────────
  for (const room of wallsModel.rooms) {
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
  const items = depthSort(buildItems(wallsModel, symbolsModel));

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
