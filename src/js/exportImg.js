/**
 * exportImg.js — standalone SVG builder + PNG rasteriser for export
 *
 * Headless render: independent of the live view transform. Computes world-space
 * bounds, applies a fixed export scale, and emits a clean SVG with dimension
 * labels. No grid, snap glyphs, or UI chrome.
 */

import { model as wallsModel, edgeLength, WALL_M, roomMetrics } from "./walls.js";
import { model as symbolsModel, corners, CATALOG } from "./symbols.js";
import { model as measurementsModel } from "./measurements.js";
import { fmtLen, unitLabel, M_PER_FT, fmtArea, areaUnitLabel } from "./units.js";
import { palette } from "./theme.js";

/** Export scale: pixels per metre in the exported image */
const EXPORT_PX_PER_M = 96; // ~100px/m for a readable print-scale output
const MARGIN_M = 0.5;        // world-space margin around content, metres
const EXPORT_2X = 2;         // pixel density multiplier for PNG

/** Bottom band constants — used by the scale bar; #147/#148 extend this band */
const BAND_PX     = 56;   // bottom band height, export px
const BAND_PAD_PX = 16;   // inset from band/image edges

/** Top caption band constants */
const CAPTION_PX  = 40;              // top caption band height, export px
const PLAN_TITLE  = "Floor plan";    // fixed title (no custom-name field in v1)

/** Round-length ladders for scale bar selection */
const SCALE_LADDER_M  = [1, 2, 5];       // metres
const SCALE_LADDER_FT = [1, 3, 5, 10];   // feet

const FONT_FAMILY = '"DM Mono", "Courier New", monospace';

/** @typedef {{ minX:number, minY:number, maxX:number, maxY:number }} Bounds */

/**
 * World-space bounds over all room verts + symbol footprints.
 * Returns null if the plan is empty.
 * @returns {Bounds|null}
 */
export function contentBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const room of wallsModel.rooms) {
    for (const v of room.verts) {
      minX = Math.min(minX, v.x);
      minY = Math.min(minY, v.y);
      maxX = Math.max(maxX, v.x);
      maxY = Math.max(maxY, v.y);
    }
  }

  for (const v of wallsModel.chain) {
    minX = Math.min(minX, v.x);
    minY = Math.min(minY, v.y);
    maxX = Math.max(maxX, v.x);
    maxY = Math.max(maxY, v.y);
  }

  for (const sym of symbolsModel.symbols) {
    for (const c of corners(sym)) {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x);
      maxY = Math.max(maxY, c.y);
    }
  }

  for (const me of measurementsModel.measurements) {
    minX = Math.min(minX, me.a.x, me.b.x);
    minY = Math.min(minY, me.a.y, me.b.y);
    maxX = Math.max(maxX, me.a.x, me.b.x);
    maxY = Math.max(maxY, me.a.y, me.b.y);
  }

  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Build a standalone SVG document string.
 * @returns {string}
 */
export function buildExportSvg() {
  // Read the active theme palette at build time — the exported SVG must contain
  // concrete colors, not CSS vars (it may be opened outside the app).
  const p = palette();

  const bounds = contentBounds();

  // If empty, produce a minimal valid SVG
  let wM, hM, originX, originY;
  if (!bounds) {
    wM = 5; hM = 5; originX = 0; originY = 0;
  } else {
    originX = bounds.minX - MARGIN_M;
    originY = bounds.minY - MARGIN_M;
    wM = (bounds.maxX - bounds.minX) + 2 * MARGIN_M;
    hM = (bounds.maxY - bounds.minY) + 2 * MARGIN_M;
  }

  const W = wM * EXPORT_PX_PER_M;
  const contentH = hM * EXPORT_PX_PER_M;
  // Compute caption totals; show caption only when there is enclosed area
  const totals = _planTotals();
  const showCaption = !!bounds && totals.area > 0;
  const topBand = showCaption ? CAPTION_PX : 0;
  // Extend height with bottom band (scale bar) and top band (caption)
  const H = (bounds ? contentH + BAND_PX : contentH) + topBand;

  // Convert world → export pixels
  const wx = (worldX) => (worldX - originX) * EXPORT_PX_PER_M;
  const wy = (worldY) => (worldY - originY) * EXPORT_PX_PER_M;

  const wallPx = Math.max(6, WALL_M * EXPORT_PX_PER_M);

  let body = "";

  // ── Committed rooms ─────────────────────────────────────────────────────────
  for (const room of wallsModel.rooms) {
    const pts = room.verts;
    if (pts.length === 0) continue;

    const ptsStr = pts.map(v => `${wx(v.x)},${wy(v.y)}`).join(" ");

    // Fill (closed rooms only)
    if (room.closed && pts.length >= 3) {
      body += `<polygon points="${ptsStr}" fill="${room.color || p.roomFill}" stroke="none"/>\n`;
    }

    // Wall body
    if (pts.length >= 2) {
      const tag = room.closed ? "polygon" : "polyline";
      body += `<${tag} points="${ptsStr}" fill="none" stroke="${p.wallBody}" stroke-width="${wallPx}" stroke-linejoin="round" stroke-linecap="round"/>\n`;
    }

    // Centerline
    if (pts.length >= 2) {
      const tag = room.closed ? "polygon" : "polyline";
      body += `<${tag} points="${ptsStr}" fill="none" stroke="${p.wallLine}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>\n`;
    }

    // Dimension labels per edge
    const n = pts.length;
    const edgeCount = room.closed ? n : n - 1;
    for (let i = 0; i < edgeCount; i++) {
      const iA = i;
      const iB = room.closed ? (i + 1) % n : i + 1;
      const a = pts[iA];
      const b = pts[iB];
      const len = edgeLength(a, b);
      if (len < 1e-6) continue;
      const mx = wx((a.x + b.x) / 2);
      const my = wy((a.y + b.y) / 2);
      const labelText = `${fmtLen(len)} ${unitLabel()}`;
      // Note: font-family uses single-quote attribute delimiters so the double-quoted font
      // stack is valid XML. Using JSON.stringify() here would produce backslash-escaped quotes
      // inside double-quoted attributes, which DOMParser rejects as a parsererror.
      body += `<text x="${mx}" y="${my}" font-family='${FONT_FAMILY}' font-size="10" fill="${p.dim}" text-anchor="middle" dominant-baseline="middle">${_escapeXml(labelText)}</text>\n`;
    }
  }

  // ── Active chain (draft polyline) ───────────────────────────────────────────
  if (wallsModel.chain.length >= 2) {
    const ptsStr = wallsModel.chain.map(v => `${wx(v.x)},${wy(v.y)}`).join(" ");
    body += `<polyline points="${ptsStr}" fill="none" stroke="${p.draft}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="6 4"/>\n`;
  }

  // ── Rugs (floor layer — painted before furniture so furniture draws on top) ──
  for (const sym of symbolsModel.symbols) {
    if (!CATALOG[sym.type]?.floorLayer) continue;
    const cs = corners(sym);
    const ptsStr = cs.map(c => `${wx(c.x)},${wy(c.y)}`).join(" ");
    // Dashed edge, low-alpha fill; no type label (floor surface, not a boxed object)
    const rugFill = sym.color || `rgba(120,100,70,0.18)`;
    body += `<polygon points="${ptsStr}" fill="${rugFill}" stroke="${p.symStroke}" stroke-width="1.2" stroke-dasharray="5 3" stroke-linejoin="round"/>\n`;
    // Subtle cross-hatch lines at low opacity — three evenly spaced diagonals
    const cx = wx(sym.x), cy = wy(sym.y);
    const sw = sym.w * EXPORT_PX_PER_M;
    const sh = sym.h * EXPORT_PX_PER_M;
    const rot = sym.rot;
    const hatchSpacing = Math.max(10, Math.min(sw, sh) * 0.12);
    const clipId = `rug-exp-${sym.id}`;
    body += `<defs><clipPath id="${clipId}"><polygon points="${ptsStr}"/></clipPath></defs>\n`;
    body += `<g clip-path="url(#${clipId})" opacity="0.10">\n`;
    const radR = (rot * Math.PI) / 180;
    const cosR = Math.cos(radR), sinR = Math.sin(radR);
    const lp = (lx, ly) => ({
      x: cx + lx * cosR - ly * sinR,
      y: cy + lx * sinR + ly * cosR,
    });
    const maxExt = sw + sh;
    for (let d = -maxExt; d < maxExt; d += hatchSpacing) {
      const a = lp(d - sh, -sh);
      const b = lp(d + sh,  sh);
      body += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${p.symStroke}" stroke-width="0.6"/>\n`;
    }
    body += `</g>\n`;
  }

  // ── Symbols (furniture — above rugs) ────────────────────────────────────────
  for (const sym of symbolsModel.symbols) {
    if (CATALOG[sym.type]?.floorLayer) continue; // already painted above
    const cs = corners(sym);
    const ptsStr = cs.map(c => `${wx(c.x)},${wy(c.y)}`).join(" ");
    body += `<polygon points="${ptsStr}" fill="${sym.color || p.symFill}" stroke="${p.symStroke}" stroke-width="1.5" stroke-linejoin="round"/>\n`;

    // Type label at center
    const label = CATALOG[sym.type]?.label || sym.type;
    body += `<text x="${wx(sym.x)}" y="${wy(sym.y)}" font-family='${FONT_FAMILY}' font-size="9" fill="${p.dim}" text-anchor="middle" dominant-baseline="middle">${_escapeXml(label)}</text>\n`;
  }

  // ── Measurements ─────────────────────────────────────────────────────────────
  for (const me of measurementsModel.measurements) {
    const ax = wx(me.a.x), ay = wy(me.a.y);
    const bx = wx(me.b.x), by = wy(me.b.y);
    body += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${p.dim}" stroke-width="1.5" stroke-linecap="round"/>\n`;

    const dist = edgeLength(me.a, me.b);
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const labelText = `${fmtLen(dist)} ${unitLabel()}`;
    body += `<text x="${mx}" y="${my}" font-family='${FONT_FAMILY}' font-size="10" fill="${p.dim}" text-anchor="middle" dominant-baseline="middle">${_escapeXml(labelText)}</text>\n`;
  }

  // Append scale bar when plan is non-empty
  const scaleBar = bounds ? _scaleBarSvg(W, contentH, p) : "";
  // Caption band above the geometry (omitted when no enclosed area)
  const caption = showCaption ? _captionSvg(W, p, totals) : "";

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `  <rect width="${W}" height="${H}" fill="${p.bg}"/>`,
    `<g transform="translate(0,${topBand})">`,
    body,
    scaleBar,
    `</g>`,
    caption,
    `</svg>`,
  ].join("\n");
}

/**
 * Trigger download of the SVG.
 */
export function exportSvg() {
  const svgStr = buildExportSvg();
  const blob = new Blob([svgStr], { type: "image/svg+xml" });
  _triggerDownload(URL.createObjectURL(blob), "floorplan.svg");
}

/**
 * Rasterise the export SVG to PNG (2× device scale) and trigger download.
 * @returns {Promise<void>}
 */
export async function exportPng() {
  const svgStr = buildExportSvg();
  const blob = new Blob([svgStr], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);

  try {
    // Parse viewBox dimensions from the SVG
    const wMatch = svgStr.match(/width="([\d.]+)"/);
    const hMatch = svgStr.match(/height="([\d.]+)"/);
    if (!wMatch || !hMatch) throw new Error("Could not parse SVG dimensions");

    const svgW = parseFloat(wMatch[1]);
    const svgH = parseFloat(hMatch[1]);

    const canvas = document.createElement("canvas");
    canvas.width  = svgW * EXPORT_2X;
    canvas.height = svgH * EXPORT_2X;
    const ctx = canvas.getContext("2d");

    await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve();
      };
      img.onerror = reject;
      img.src = url;
    });

    const pngBlob = await new Promise((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });

    if (!pngBlob) {
      throw new Error("toBlob returned null");
    }

    _triggerDownload(URL.createObjectURL(pngBlob), "floorplan.png");
  } catch {
    // Edge Case 13: toast handled by actions.js caller
    throw new Error("PNG export failed");
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Choose the round scale-bar length for the active unit that fits availPx.
 * @param {number} availPx  usable band width = W - 2*BAND_PAD_PX
 * @returns {{ metres:number, label:string }}
 */
function _pickScaleBar(availPx) {
  const isMetric = unitLabel() === "m";
  const ladder = isMetric ? SCALE_LADDER_M : SCALE_LADDER_FT;

  // Pick the largest round length whose bar pixel width fits availPx
  let chosen = ladder[0];
  for (const L of ladder) {
    const metres = isMetric ? L : L * M_PER_FT;
    const barPx  = metres * EXPORT_PX_PER_M;
    if (barPx <= availPx) {
      chosen = L;
    }
  }

  const label = `${chosen} ${unitLabel()}`;
  const metres = isMetric ? chosen : chosen * M_PER_FT;
  return { metres, label };
}

/**
 * Emit the Style-A ruler-ladder scale bar inside the bottom band.
 * @param {number} W         total image width (px)
 * @param {number} contentH  height of content region (px); band starts here
 * @param {Palette} p        resolved theme palette (concrete colors)
 * @returns {string}         SVG fragment (a single <g class="scale-bar"> …)
 */
function _scaleBarSvg(W, contentH, p) {
  const availPx = W - 2 * BAND_PAD_PX;
  const { metres, label } = _pickScaleBar(availPx);

  const barPx = metres * EXPORT_PX_PER_M;

  // Position: left-anchored at BAND_PAD_PX; vertical centre of the band
  const x0 = BAND_PAD_PX;
  const x1 = x0 + barPx;

  // Baseline sits 10px below the band top (contentH), leaving room for label above
  const baselineY = contentH + 10 + 14; // label row (14px) + tick area
  const tallTickH  = 10;  // end ticks at 0 and L
  const shortTickH =  5;  // interior ticks

  // Determine subdivision ticks
  const isMetric = unitLabel() === "m";
  const L = Math.round(metres / (isMetric ? 1 : M_PER_FT));

  // Build tick x-positions (display-unit boundaries)
  const tickXs = [];
  for (let i = 0; i <= L; i++) {
    const mL = isMetric ? i : i * M_PER_FT;
    tickXs.push(x0 + mL * EXPORT_PX_PER_M);
  }
  // For L===1 metric, add the 0.5 m midpoint
  if (isMetric && L === 1) {
    tickXs.push(x0 + 0.5 * EXPORT_PX_PER_M);
    tickXs.sort((a, b) => a - b);
  }

  let out = `<g class="scale-bar">\n`;

  // Baseline
  out += `  <line class="scale-bar-line" x1="${x0}" y1="${baselineY}" x2="${x1}" y2="${baselineY}" stroke="${p.ink}" stroke-width="1.5" stroke-linecap="round"/>\n`;

  // Ticks
  for (const tx of tickXs) {
    const isEnd = (tx === x0 || Math.abs(tx - x1) < 0.5);
    const h = isEnd ? tallTickH : shortTickH;
    out += `  <line x1="${tx}" y1="${baselineY - h}" x2="${tx}" y2="${baselineY}" stroke="${p.ink}" stroke-width="1.5" stroke-linecap="round"/>\n`;
  }

  // "0" origin mark (below left end tick)
  out += `  <text x="${x0}" y="${baselineY + 12}" font-family='${FONT_FAMILY}' font-size="9" fill="${p.dim}" text-anchor="middle" dominant-baseline="auto">${_escapeXml("0")}</text>\n`;

  // Length label (above / at right end)
  out += `  <text class="scale-bar-label" x="${x1}" y="${contentH + 10}" font-family='${FONT_FAMILY}' font-size="10" fill="${p.dim}" text-anchor="end" dominant-baseline="hanging">${_escapeXml(label)}</text>\n`;

  out += `</g>`;
  return out;
}

/**
 * Sum area + perimeter over closed rooms — same path as measure.js update().
 * @returns {{ area:number, perimeter:number }}
 */
function _planTotals() {
  let area = 0;
  let perim = 0;
  for (const room of wallsModel.rooms) {
    if (!room.closed) continue;
    const m = roomMetrics(room);
    area += m.area;
    perim += m.perimeter;
  }
  return { area, perimeter: perim };
}

/**
 * Emit the Option-A caption band (title left, "area · perimeter" right).
 * @param {number} W        total image width (px)
 * @param {object} p        resolved theme palette (concrete colors)
 * @param {{ area:number, perimeter:number }} totals
 * @returns {string}        SVG fragment (<g class="plan-caption"> … </g>)
 */
function _captionSvg(W, p, totals) {
  const by = CAPTION_PX / 2;
  const metricsStr = `${fmtArea(totals.area)} ${areaUnitLabel()} · ${fmtLen(totals.perimeter)} ${unitLabel()}`;
  let out = `<g class="plan-caption">\n`;
  out += `  <text class="plan-title" x="${BAND_PAD_PX}" y="${by}" font-family='${FONT_FAMILY}' font-size="13" fill="${p.ink}" text-anchor="start" dominant-baseline="middle">${_escapeXml(PLAN_TITLE)}</text>\n`;
  out += `  <text class="plan-metrics" x="${W - BAND_PAD_PX}" y="${by}" font-family='${FONT_FAMILY}' font-size="12" fill="${p.dim}" text-anchor="end" dominant-baseline="middle">${_escapeXml(metricsStr)}</text>\n`;
  out += `</g>`;
  return out;
}

function _triggerDownload(blobUrl, filename) {
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a short delay to allow the download to start
  setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
}

function _escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
