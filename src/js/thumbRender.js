/**
 * thumbRender.js — static SVG thumbnail renderer for template gallery cards
 *
 * Renders a top-down, silent miniature of a plan:
 *   room fills + walls → rugs (floor layer) → furniture footprints + glyphs
 *   (including openings, which are non-floor symbols)
 *
 * Returns an <svg>…</svg> fragment string suitable for innerHTML injection.
 * Takes an explicit plan argument — never reads the live editor models.
 * No dimension labels, type-text labels, grid, snap glyphs, or measurements.
 */

import { corners, CATALOG } from "./symbols.js";
import { WALL_M } from "./walls.js";
import { palette } from "./theme.js";
import { appendSymbolInterior } from "./symbolRender.js";

const NS = "http://www.w3.org/2000/svg";

/** Export scale: pixels per metre (matches EXPORT_PX_PER_M in exportImg.js) */
const PX_PER_M = 96;
/** World-space margin around content, metres */
const DEFAULT_MARGIN_M = 0.5;

/**
 * @typedef {Object} ThumbOpts
 * @property {number} [marginM=0.5]  world-space margin around content (metres)
 */

/**
 * Render a static, silent SVG-markup string from a plan.
 * Rooms + fills + rug/furniture footprints + interior glyphs + opening glyphs.
 * NO dimension labels, type text, grid, snap glyphs, or measurements.
 * Colors are read from the active theme palette at call time.
 * Returns a minimal, valid placeholder <svg> if the plan has no drawable content.
 *
 * @param {import("./plan.js").Plan} plan
 * @param {ThumbOpts} [opts]
 * @returns {string}   an <svg …>…</svg> fragment (no <?xml?> prolog)
 */
export function renderThumbnail(plan, opts = {}) {
  const marginM = opts.marginM != null ? opts.marginM : DEFAULT_MARGIN_M;
  const p = palette();

  const bounds = planBounds(plan);

  let originX, originY, wM, hM;
  if (!bounds) {
    // Empty plan — produce a minimal placeholder
    originX = 0; originY = 0; wM = 5; hM = 5;
  } else {
    originX = bounds.minX - marginM;
    originY = bounds.minY - marginM;
    wM = (bounds.maxX - bounds.minX) + 2 * marginM;
    hM = (bounds.maxY - bounds.minY) + 2 * marginM;
  }

  // Guard against zero/negative extents (degenerate single-point plans)
  if (wM <= 0) wM = 2 * marginM || 1;
  if (hM <= 0) hM = 2 * marginM || 1;

  const W = wM * PX_PER_M;
  const H = hM * PX_PER_M;

  // World → pixel projector (folds origin into the function, viewBox starts at 0,0)
  const project = (wx, wy) => ({
    x: (wx - originX) * PX_PER_M,
    y: (wy - originY) * PX_PER_M,
  });

  const wallPx = Math.max(6, WALL_M * PX_PER_M);

  let floorStr = "";

  const rooms = plan.walls?.rooms ?? [];
  const symbols = plan.symbols?.symbols ?? [];

  // ── Room fills and walls ────────────────────────────────────────────────────
  for (const room of rooms) {
    const pts = room.verts;
    if (!pts || pts.length === 0) continue;

    const ptsStr = pts.map(v => `${project(v.x, v.y).x},${project(v.x, v.y).y}`).join(" ");

    // Fill (closed rooms with ≥3 verts only)
    if (room.closed && pts.length >= 3) {
      floorStr += `<polygon points="${ptsStr}" fill="${room.color || p.roomFill}" stroke="none"/>\n`;
    }

    // Wall body
    if (pts.length >= 2) {
      const tag = room.closed ? "polygon" : "polyline";
      floorStr += `<${tag} points="${ptsStr}" fill="none" stroke="${p.wallBody}" stroke-width="${wallPx}" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>\n`;
    }

    // Centerline
    if (pts.length >= 2) {
      const tag = room.closed ? "polygon" : "polyline";
      floorStr += `<${tag} points="${ptsStr}" fill="none" stroke="${p.wallLine}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>\n`;
    }
  }

  // ── Rugs (floor-layer symbols — below furniture) ────────────────────────────
  for (const sym of symbols) {
    if (!CATALOG[sym.type]?.floorLayer) continue;

    const cs = corners(sym);
    const ptsStr = cs.map(c => {
      const sp = project(c.x, c.y);
      return `${sp.x},${sp.y}`;
    }).join(" ");

    const fillColor = sym.color ? sym.color : `rgba(${p.symInkRgb},0.12)`;
    floorStr += `<polygon points="${ptsStr}" fill="${fillColor}" stroke="${p.symStroke}" stroke-width="1.2" stroke-dasharray="5 3" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>\n`;

    // Hatch lines
    const sc = project(sym.x, sym.y);
    const sw = sym.w * PX_PER_M;
    const sh = sym.h * PX_PER_M;
    const rot = sym.rot;
    const hatchSpacing = Math.max(10, Math.min(sw, sh) * 0.12);
    const clipId = `rug-thumb-${sym.id}`;
    floorStr += `<defs><clipPath id="${clipId}"><polygon points="${ptsStr}"/></clipPath></defs>\n`;
    floorStr += `<g clip-path="url(#${clipId})" opacity="0.10">\n`;
    const radR = (rot * Math.PI) / 180;
    const cosR = Math.cos(radR), sinR = Math.sin(radR);
    const lp = (lx, ly) => ({
      x: sc.x + lx * cosR - ly * sinR,
      y: sc.y + lx * sinR + ly * cosR,
    });
    const maxExt = sw + sh;
    for (let d = -maxExt; d < maxExt; d += hatchSpacing) {
      const a = lp(d - sh, -sh);
      const b = lp(d + sh,  sh);
      floorStr += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${p.symStroke}" stroke-width="0.6"/>\n`;
    }
    floorStr += `</g>\n`;
  }

  // ── Furniture + openings (all non-floor symbols) ────────────────────────────
  // Build as a detached DOM group so we can reuse appendSymbolInterior (which
  // calls createElementNS/appendChild). After building, serialize once.
  let furnitureStr = "";

  const nonFloorSyms = symbols.filter(s => !CATALOG[s.type]?.floorLayer);
  if (nonFloorSyms.length > 0) {
    const g = document.createElementNS(NS, "g");

    for (const sym of nonFloorSyms) {
      const cs = corners(sym).map(c => project(c.x, c.y));
      const ptsStr = cs.map(s => `${s.x},${s.y}`).join(" ");

      // Footprint polygon
      const poly = document.createElementNS(NS, "polygon");
      poly.setAttribute("points", ptsStr);
      poly.setAttribute("fill", sym.color || p.symFill);
      poly.setAttribute("stroke", p.symStroke);
      poly.setAttribute("stroke-width", "1.5");
      poly.setAttribute("stroke-linejoin", "round");
      poly.setAttribute("vector-effect", "non-scaling-stroke");
      g.appendChild(poly);

      // Interior glyph (shared recipe with live view)
      appendSymbolInterior(g, sym, cs, p, project, PX_PER_M);
    }

    furnitureStr = new XMLSerializer().serializeToString(g);
    // XMLSerializer wraps in the element tag — unwrap the outer <g>…</g> to
    // inline the children directly; or keep the group (it's valid SVG either way).
    // Keeping the group is simpler.
  }

  const svgParts = [
    `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true"`,
    `     viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`,
    floorStr,
    furnitureStr,
    `</svg>`,
  ];

  return svgParts.join("\n");
}

/**
 * World-space bounds over a plan's room verts + symbol footprints.
 * Mirrors exportImg.contentBounds but reads the passed plan, not globals.
 * @param {import("./plan.js").Plan} plan
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}  null when nothing is drawable
 */
function planBounds(plan) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  const rooms = plan.walls?.rooms ?? [];
  const chain = plan.walls?.chain ?? [];
  const symbols = plan.symbols?.symbols ?? [];

  for (const room of rooms) {
    for (const v of room.verts) {
      minX = Math.min(minX, v.x);
      minY = Math.min(minY, v.y);
      maxX = Math.max(maxX, v.x);
      maxY = Math.max(maxY, v.y);
    }
  }

  for (const v of chain) {
    minX = Math.min(minX, v.x);
    minY = Math.min(minY, v.y);
    maxX = Math.max(maxX, v.x);
    maxY = Math.max(maxY, v.y);
  }

  for (const sym of symbols) {
    for (const c of corners(sym)) {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x);
      maxY = Math.max(maxY, c.y);
    }
  }

  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}
