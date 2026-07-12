/**
 * measurements.js — point-to-point measurement annotation model (LLD 81 + 93)
 *
 * Plain fixed world-coordinate endpoints. No DOM, no imports — Node-loadable.
 * Mirrors the walls.js / symbols.js structure exactly.
 *
 * @typedef {{ x:number, y:number }} Endpoint  // #93: anchor field reserved for follow-up
 * @typedef {{ id:string, a:Endpoint, b:Endpoint }} Measurement
 */

// ── In-memory model ───────────────────────────────────────────────────────────

let _counter = 0;

/**
 * Serializable model — plain JSON-safe objects.
 * Mirrors symbols.model.
 */
export const model = { measurements: /** @type {Measurement[]} */ ([]) };

// ── Id management ─────────────────────────────────────────────────────────────

/**
 * Mint the next measurement id ("m<n>"). Used by #93 (measure tool).
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

// ── Mutators (LLD 93) ────────────────────────────────────────────────────────

/**
 * Build a Measurement with a fresh id from two fixed world points.
 * Does NOT add it to model.
 * @param {{ x:number, y:number }} a
 * @param {{ x:number, y:number }} b
 * @returns {Measurement}
 */
export function createMeasurement(a, b) {
  return { id: newId(), a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
}

/**
 * Append a measurement to model.measurements (mirrors addSymbol).
 * @param {Measurement} m
 */
export function addMeasurement(m) {
  model.measurements.push(m);
}

/**
 * Remove by id; returns true if removed (mirrors removeSymbol).
 * @param {string} id
 * @returns {boolean}
 */
export function removeMeasurement(id) {
  const idx = model.measurements.findIndex(m => m.id === id);
  if (idx === -1) return false;
  model.measurements.splice(idx, 1);
  return true;
}

/**
 * Hit-test: nearest measurement whose segment passes within tolWorld of (wx, wy).
 * Last match wins on ties (topmost draw order), mirroring pickSymbol.
 * Pure geometry; screen-tolerance conversion is the caller's job.
 * @param {number} wx  world x
 * @param {number} wy  world y
 * @param {number} tolWorld  distance threshold in world metres
 * @returns {Measurement|null}
 */
export function pickMeasurement(wx, wy, tolWorld) {
  let result = null;
  for (const m of model.measurements) {
    if (_distToSegment(wx, wy, m.a, m.b) <= tolWorld) {
      result = m; // last match wins (topmost draw order)
    }
  }
  return result;
}

/**
 * Point-to-segment distance (world metres).
 * @param {number} px
 * @param {number} py
 * @param {{ x:number, y:number }} a
 * @param {{ x:number, y:number }} b
 * @returns {number}
 */
function _distToSegment(px, py, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? ((px - a.x) * abx + (py - a.y) * aby) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = a.x + t * abx;
  const cy = a.y + t * aby;
  const dx = px - cx;
  const dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy);
}
