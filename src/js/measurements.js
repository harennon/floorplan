/**
 * measurements.js — point-to-point measurement annotation model (LLD 81 + 92)
 *
 * Plain fixed world-coordinate endpoints. No DOM — Node-loadable.
 * Imports view.js for worldToScreen (needed by nearestMeasurement).
 * Mirrors the walls.js / symbols.js structure exactly.
 *
 * @typedef {{ x:number, y:number }} Endpoint  // #93 will add optional `anchor`
 * @typedef {{ id:string, a:Endpoint, b:Endpoint }} Measurement
 */

import { worldToScreen } from "./view.js";

// ── In-memory model ───────────────────────────────────────────────────────────

let _counter = 0;

/**
 * Serializable model — plain JSON-safe objects.
 * Mirrors symbols.model.
 */
export const model = { measurements: /** @type {Measurement[]} */ ([]) };

// ── Id management ─────────────────────────────────────────────────────────────

/**
 * Mint the next measurement id ("m<n>"). Used by #92 (measure tool).
 * @returns {string}
 */
export function newId() {
  return `m${_counter++}`;
}

// ── Hydrate (LLD 81) ─────────────────────────────────────────────────────────

/**
 * Replace model.measurements IN PLACE (same array identity) and re-sync the id
 * counter past the max "m<n>" so a later newId() cannot collide with a loaded id.
 * @param {{ measurements: Measurement[] }} next
 */
export function hydrate(next) {
  model.measurements.splice(0, model.measurements.length, ...next.measurements);

  let maxId = -1;
  for (const m of model.measurements) {
    const match = typeof m.id === "string" ? m.id.match(/^m(\d+)$/) : null;
    if (match) maxId = Math.max(maxId, parseInt(match[1], 10));
  }
  _counter = maxId + 1;
}

// ── CRUD (LLD 92) ─────────────────────────────────────────────────────────────

/**
 * Create and append a fixed-endpoint measurement. Mints id via newId(). Returns it.
 * a, b are world-metre points. Does NOT dirty history/plan (caller commits).
 * @param {Endpoint} a
 * @param {Endpoint} b
 * @returns {Measurement}
 */
export function add(a, b) {
  const m = { id: newId(), a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
  model.measurements.push(m);
  return m;
}

/**
 * Remove by id. No-op if absent. Returns true if removed, false if not found.
 * @param {string} id
 * @returns {boolean}
 */
export function remove(id) {
  const idx = model.measurements.findIndex(m => m.id === id);
  if (idx === -1) return false;
  model.measurements.splice(idx, 1);
  return true;
}

/**
 * Find a measurement by id, or null.
 * @param {string} id
 * @returns {Measurement|null}
 */
export function getById(id) {
  return model.measurements.find(m => m.id === id) ?? null;
}

/**
 * Euclidean length in metres of a measurement (or any {a,b} pair). Pure.
 * @param {{ a:Endpoint, b:Endpoint }} m
 * @returns {number}
 */
export function length(m) {
  const dx = m.b.x - m.a.x;
  const dy = m.b.y - m.a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Nearest measurement whose segment passes within tolPx (screen px) of (sx,sy),
 * or null. Uses worldToScreen on both endpoints + point-to-segment distance in
 * SCREEN space (so tolerance is zoom-independent). Last match wins on ties
 * (topmost draw order), mirroring pickSymbol/room hit rules.
 * @param {number} sx
 * @param {number} sy
 * @param {number} tolPx
 * @returns {Measurement|null}
 */
export function nearestMeasurement(sx, sy, tolPx) {
  let result = null;
  for (const m of model.measurements) {
    const sa = worldToScreen(m.a.x, m.a.y);
    const sb = worldToScreen(m.b.x, m.b.y);
    const dist = _pointToSegmentDist(sx, sy, sa.x, sa.y, sb.x, sb.y);
    if (dist <= tolPx) {
      result = m; // last match wins (topmost draw order)
    }
  }
  return result;
}

/**
 * Point-to-segment distance in 2D.
 * @param {number} px  point x
 * @param {number} py  point y
 * @param {number} ax  segment start x
 * @param {number} ay  segment start y
 * @param {number} bx  segment end x
 * @param {number} by  segment end y
 * @returns {number}
 */
function _pointToSegmentDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) {
    // Degenerate segment: measure to the point itself
    const dx = px - ax;
    const dy = py - ay;
    return Math.sqrt(dx * dx + dy * dy);
  }
  let t = ((px - ax) * abx + (py - ay) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  const dx = px - cx;
  const dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy);
}
