/**
 * exporter.js — JSON / SVG / PNG generation + JSON import (LLD 15)
 *
 * All exports are standalone world-space renders, independent of the live
 * viewport (wallRender.js / symbolRender.js screen-space render not used here).
 * Fonts in SVG/PNG use generic monospace (no external font fetch required).
 */

import { serialize, validate } from "./persist.js";
import { model as wallsModel, WALL_M, edgeLength } from "./walls.js";
import { model as symbolsModel, corners, CATALOG } from "./symbols.js";
import { fmtLen, unitLabel } from "./units.js";

// ── Palette (warm-blueprint, self-contained) ─────────────────────────────────

const BG          = "#14140f";
const WALL_BODY   = "rgba(201,168,76,0.30)";
const WALL_LINE   = "#d9be6e";
const ROOM_FILL   = "rgba(201,168,76,0.07)";
const SYMBOL_FILL = "rgba(201,168,76,0.12)";
const SYMBOL_LINE = "#d9be6e";
const LABEL_BG    = "rgba(20,20,15,0.75)";
const LABEL_FG    = "#8f8a78";
const FONT        = "monospace";

// ── Bounding box ─────────────────────────────────────────────────────────────

/**
 * Compute the world-space bounding box over all rooms + symbols.
 * Returns null for an empty plan.
 * @returns {{ minX:number, minY:number, maxX:number, maxY:number }|null}
 */
export function planBBox() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;

  for (const room of wallsModel.rooms) {
    for (const v of room.verts) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
      any = true;
    }
  }

  for (const sym of symbolsModel.symbols) {
    for (const c of corners(sym)) {
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.x > maxX) maxX = c.x;
      if (c.y > maxY) maxY = c.y;
      any = true;
    }
  }

  return any ? { minX, minY, maxX, maxY } : null;
}

// ── Date-stamp helper ─────────────────────────────────────────────────────────

function _datestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// ── Download helper ───────────────────────────────────────────────────────────

function _download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // Slight delay before cleanup to let the browser initiate the download
  setTimeout(() => {
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }, 200);
}

// ── JSON export / import ──────────────────────────────────────────────────────

/**
 * Export the current plan as a pretty-printed JSON file download.
 */
export function exportJSON() {
  const doc = serialize();
  const json = JSON.stringify(doc, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  _download(blob, `floorplan-${_datestamp()}.json`);
}

/**
 * Read, parse, and validate a JSON File. Returns the PlanDoc or null on failure.
 * The caller is responsible for loading the doc into the model.
 * @param {File} file
 * @returns {Promise<any|null>}
 */
export async function importJSON(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    return validate(parsed);
  } catch {
    return null;
  }
}

// ── SVG export ────────────────────────────────────────────────────────────────

const PX_PER_M_SVG = 100; // 100 svg-px = 1 metre in the standalone output

/**
 * XML-escape a string for safe use in SVG text/attributes.
 * @param {string} str
 * @returns {string}
 */
function _xmlEscape(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build a standalone SVG string from the current model in world space.
 * @param {{ padM?: number }} [opts]  padM = padding in metres (default 0.5)
 * @returns {string}
 */
export function buildSVG(opts = {}) {
  const padM = opts.padM ?? 0.5;
  const bbox = planBBox();

  // Coordinate system: top-left is (minX - padM, minY - padM) in world metres.
  // svgX(wx) = (wx - ox) * PX_PER_M_SVG,  svgY(wy) = (wy - oy) * PX_PER_M_SVG
  const ox = bbox ? bbox.minX - padM : -padM;
  const oy = bbox ? bbox.minY - padM : -padM;
  const bw = bbox ? (bbox.maxX - bbox.minX) + 2 * padM : 2 * padM;
  const bh = bbox ? (bbox.maxY - bbox.minY) + 2 * padM : 2 * padM;

  const svgW = Math.round(bw * PX_PER_M_SVG);
  const svgH = Math.round(bh * PX_PER_M_SVG);

  const wx = (worldX) => ((worldX - ox) * PX_PER_M_SVG).toFixed(3);
  const wy = (worldY) => ((worldY - oy) * PX_PER_M_SVG).toFixed(3);

  const lines = [];

  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">`);
  lines.push(`<title>floorplan</title>`);

  // Background
  lines.push(`<rect x="0" y="0" width="${svgW}" height="${svgH}" fill="${BG}"/>`);

  // ── Rooms ──────────────────────────────────────────────────────────────────

  for (const room of wallsModel.rooms) {
    const pts = room.verts;
    if (pts.length === 0) continue;

    const ptStr = pts.map(v => `${wx(v.x)},${wy(v.y)}`).join(" ");
    const wallPx = Math.max(6, WALL_M * PX_PER_M_SVG);

    // Fill
    if (room.closed && pts.length >= 3) {
      lines.push(`<polygon points="${ptStr}" fill="${ROOM_FILL}" stroke="none"/>`);
    }

    // Wall body
    if (pts.length >= 2) {
      const tag = room.closed ? "polygon" : "polyline";
      lines.push(`<${tag} points="${ptStr}" fill="none" stroke="${WALL_BODY}" stroke-width="${wallPx}" stroke-linejoin="round" stroke-linecap="round"/>`);
    }

    // Centerline
    if (pts.length >= 2) {
      const tag = room.closed ? "polygon" : "polyline";
      lines.push(`<${tag} points="${ptStr}" fill="none" stroke="${WALL_LINE}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    }

    // Edge dimension labels
    const n = pts.length;
    const edgeCount = room.closed ? n : n - 1;
    for (let i = 0; i < edgeCount; i++) {
      const iA = i;
      const iB = room.closed ? (i + 1) % n : i + 1;
      const a = pts[iA], b = pts[iB];
      const len = edgeLength(a, b);
      if (len === 0) continue;
      const labelText = _xmlEscape(fmtLen(len) + " " + unitLabel());
      const mx = ((a.x + b.x) / 2);
      const my = ((a.y + b.y) / 2);
      lines.push(
        `<text x="${wx(mx)}" y="${wy(my)}" ` +
        `font-family="${FONT}" font-size="10" fill="${LABEL_FG}" ` +
        `text-anchor="middle" dominant-baseline="middle" ` +
        `style="paint-order:stroke;stroke:${BG};stroke-width:3;">${labelText}</text>`
      );
    }
  }

  // ── Symbols ────────────────────────────────────────────────────────────────

  for (const sym of symbolsModel.symbols) {
    const cs = corners(sym);
    const ptStr = cs.map(c => `${wx(c.x)},${wy(c.y)}`).join(" ");
    lines.push(`<polygon points="${ptStr}" fill="${SYMBOL_FILL}" stroke="${SYMBOL_LINE}" stroke-width="2" stroke-linejoin="round"/>`);

    // Type label inside
    const labelText = _xmlEscape(CATALOG[sym.type]?.label ?? sym.type);
    lines.push(
      `<text x="${wx(sym.x)}" y="${wy(sym.y)}" ` +
      `font-family="${FONT}" font-size="9" fill="${LABEL_FG}" ` +
      `text-anchor="middle" dominant-baseline="middle" ` +
      `transform="rotate(${sym.rot.toFixed(2)},${wx(sym.x)},${wy(sym.y)})">${labelText}</text>`
    );
  }

  lines.push(`</svg>`);
  return lines.join("\n");
}

/**
 * Trigger a .svg file download of the current plan.
 */
export function exportSVG() {
  const svgStr = buildSVG();
  const blob = new Blob([svgStr], { type: "image/svg+xml" });
  _download(blob, `floorplan-${_datestamp()}.svg`);
}

// ── PNG export ────────────────────────────────────────────────────────────────

/**
 * Rasterize the SVG to a PNG and trigger a download.
 * @param {{ scale?: number, maxPx?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function exportPNG(opts = {}) {
  const scale = opts.scale ?? 2;
  const maxPx = opts.maxPx ?? 4096;

  const svgStr = buildSVG();
  const parser = new DOMParser();
  const svgDoc = parser.parseFromString(svgStr, "image/svg+xml");
  const svgEl = svgDoc.documentElement;

  const naturalW = parseInt(svgEl.getAttribute("width") || "800", 10);
  const naturalH = parseInt(svgEl.getAttribute("height") || "600", 10);

  // Scale + clamp to maxPx, preserving aspect
  let canvasW = naturalW * scale;
  let canvasH = naturalH * scale;
  if (canvasW > maxPx || canvasH > maxPx) {
    const ratio = Math.min(maxPx / canvasW, maxPx / canvasH);
    canvasW = Math.round(canvasW * ratio);
    canvasH = Math.round(canvasH * ratio);
  }

  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;

  const ctx = canvas.getContext("2d");
  ctx.scale(canvasW / naturalW, canvasH / naturalH);

  // Load SVG into an Image via data URL
  const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);

  await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG failed to load as Image"));
    };
    img.src = url;
  });

  await new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) { reject(new Error("toBlob returned null")); return; }
      _download(blob, `floorplan-${_datestamp()}.png`);
      resolve();
    }, "image/png");
  });
}
