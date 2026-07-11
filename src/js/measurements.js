/**
 * measurements.js — point-to-point measurement annotation model (LLD 81)
 *
 * Plain fixed world-coordinate endpoints. No DOM, no imports — Node-loadable.
 * Mirrors the walls.js / symbols.js structure exactly.
 *
 * @typedef {{ x:number, y:number }} Endpoint  // #93 will add optional `anchor`
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
