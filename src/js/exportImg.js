/**
 * exportImg.js — standalone SVG builder + PNG rasteriser for export
 *
 * Headless render: independent of the live view transform. Computes world-space
 * bounds, applies a fixed export scale, and emits a clean SVG with dimension
 * labels. No grid, snap glyphs, or UI chrome.
 */

import { model as wallsModel, edgeLength, WALL_M } from "./walls.js";
import { model as symbolsModel, corners, CATALOG } from "./symbols.js";
import { fmtLen, unitLabel } from "./units.js";

/** Export scale: pixels per metre in the exported image */
const EXPORT_PX_PER_M = 96; // ~100px/m for a readable print-scale output
const MARGIN_M = 0.5;        // world-space margin around content, metres
const EXPORT_2X = 2;         // pixel density multiplier for PNG

// Palette (blueprint theme, opaque background)
const BG_COLOR         = "#14140f";
const WALL_BODY_COLOR  = "rgba(201,168,76,0.30)";
const WALL_LINE_COLOR  = "#d9be6e";
const ROOM_FILL_COLOR  = "rgba(201,168,76,0.07)";
const CHAIN_COLOR      = "#d9be6e";
const SYM_FILL         = "rgba(201,168,76,0.12)";
const SYM_STROKE       = "#d9be6e";
const DIM_COLOR        = "#8f8a78";
const FONT_FAMILY      = '"DM Mono", "Courier New", monospace';

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

  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Build a standalone SVG document string.
 * @returns {string}
 */
export function buildExportSvg() {
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
  const H = hM * EXPORT_PX_PER_M;

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
      body += `<polygon points="${ptsStr}" fill="${ROOM_FILL_COLOR}" stroke="none"/>\n`;
    }

    // Wall body
    if (pts.length >= 2) {
      const tag = room.closed ? "polygon" : "polyline";
      body += `<${tag} points="${ptsStr}" fill="none" stroke="${WALL_BODY_COLOR}" stroke-width="${wallPx}" stroke-linejoin="round" stroke-linecap="round"/>\n`;
    }

    // Centerline
    if (pts.length >= 2) {
      const tag = room.closed ? "polygon" : "polyline";
      body += `<${tag} points="${ptsStr}" fill="none" stroke="${WALL_LINE_COLOR}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>\n`;
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
      body += `<text x="${mx}" y="${my}" font-family=${JSON.stringify(FONT_FAMILY)} font-size="10" fill="${DIM_COLOR}" text-anchor="middle" dominant-baseline="middle">${_escapeXml(labelText)}</text>\n`;
    }
  }

  // ── Active chain (draft polyline) ───────────────────────────────────────────
  if (wallsModel.chain.length >= 2) {
    const ptsStr = wallsModel.chain.map(v => `${wx(v.x)},${wy(v.y)}`).join(" ");
    body += `<polyline points="${ptsStr}" fill="none" stroke="${CHAIN_COLOR}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="6 4"/>\n`;
  }

  // ── Symbols ─────────────────────────────────────────────────────────────────
  for (const sym of symbolsModel.symbols) {
    const cs = corners(sym);
    const ptsStr = cs.map(c => `${wx(c.x)},${wy(c.y)}`).join(" ");
    body += `<polygon points="${ptsStr}" fill="${SYM_FILL}" stroke="${SYM_STROKE}" stroke-width="1.5" stroke-linejoin="round"/>\n`;

    // Type label at center
    const label = CATALOG[sym.type]?.label || sym.type;
    body += `<text x="${wx(sym.x)}" y="${wy(sym.y)}" font-family=${JSON.stringify(FONT_FAMILY)} font-size="9" fill="${DIM_COLOR}" text-anchor="middle" dominant-baseline="middle">${_escapeXml(label)}</text>\n`;
  }

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `  <rect width="${W}" height="${H}" fill="${BG_COLOR}"/>`,
    body,
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
