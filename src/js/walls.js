/**
 * walls.js — wall geometry data model and pure geometry functions
 *
 * World coordinates in metres. Snap tolerances in screen pixels.
 * This is the testable pure-logic core — no DOM, no events.
 */

import { worldToScreen, screenToWorld } from "./view.js";

// ── Constants ────────────────────────────────────────────────────────────────

export const WALL_M     = 0.12;  // wall body thickness, world metres (to-scale)
export const SNAP_PT_PX = 15;    // endpoint-snap tolerance, screen px
export const CLOSE_PX   = 16;    // room-close tolerance, screen px (>= SNAP_PT_PX)
export const MIN_SEG_M  = 1e-4;  // reject zero-length segments below this

// ── Types (JSDoc) ─────────────────────────────────────────────────────────────

/** @typedef {{ x:number, y:number }} Vertex */
/** @typedef {{ id:string, closed:boolean, verts:Vertex[] }} Room */
/** @typedef {{ x:number, y:number, type:"grid"|"point"|"close"|"free" }} Snap */

// ── In-memory model ──────────────────────────────────────────────────────────

let _roomCounter = 0;

/**
 * In-memory geometry model. Plain serializable objects — #MVP-6 can
 * JSON.stringify(model) directly.
 */
export const model = {
  rooms: /** @type {Room[]} */ ([]),
  chain: /** @type {Vertex[]} */ ([]),
};

// ── Pure geometry ─────────────────────────────────────────────────────────────

/**
 * Collect every placed vertex: all committed rooms + the active chain.
 * Used as the candidate list for endpoint snapping.
 * @returns {Vertex[]}
 */
export function allVertices() {
  const out = [];
  for (const room of model.rooms) {
    for (const v of room.verts) out.push(v);
  }
  for (const v of model.chain) out.push(v);
  return out;
}

/**
 * Round a world point to the nearest grid step (metres).
 * @param {{ x:number, y:number }} wpt
 * @param {number} step  metres per grid cell
 * @returns {{ x:number, y:number }}
 */
export function gridSnap(wpt, step) {
  return {
    x: Math.round(wpt.x / step) * step,
    y: Math.round(wpt.y / step) * step,
  };
}

/**
 * Find the nearest vertex from `verts` to screen position (sx, sy) within
 * `tolPx`, skipping the `skip` vertex (typically the chain's active last point).
 * Distance is measured in screen-px via worldToScreen projection.
 *
 * @param {number} sx
 * @param {number} sy
 * @param {Vertex[]} verts
 * @param {Vertex|null} skip
 * @param {number} tolPx
 * @returns {Vertex|null}
 */
export function closestEndpoint(sx, sy, verts, skip, tolPx) {
  let bestDist = tolPx;
  let bestVert = null;
  for (const v of verts) {
    if (skip !== null && v === skip) continue;
    const s = worldToScreen(v.x, v.y);
    const dx = s.x - sx;
    const dy = s.y - sy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= bestDist) {
      bestDist = dist;
      bestVert = v;
    }
  }
  return bestVert;
}

/**
 * Can the current chain be closed into a polygon? Requires >= 3 vertices.
 * @param {Vertex[]} chain
 * @returns {boolean}
 */
export function canClose(chain) {
  return chain.length >= 3;
}

/**
 * Resolve the snap point + type for a raw screen position.
 *
 * Precedence (mirroring the mockup, reconciled to the live view):
 *  1. close  — chain >= 3 and screen-dist(cursor, chain[0]) <= CLOSE_PX
 *  2. point  — nearest vertex within SNAP_PT_PX (skipping chain's last vertex)
 *  3. free   — altHeld (raw world point; endpoint/close still supersede)
 *  4. grid   — default: gridSnap(raw, step)
 *
 * @param {number} sx
 * @param {number} sy
 * @param {{ chain:Vertex[], rooms:Room[], altHeld:boolean, step:number }} opts
 * @returns {Snap}
 */
export function resolveSnap(sx, sy, opts) {
  const { chain, rooms, altHeld, step } = opts;
  const raw = screenToWorld(sx, sy);

  // 1. Close snap: chain >= 3 and cursor near chain[0]
  if (canClose(chain)) {
    const s0 = worldToScreen(chain[0].x, chain[0].y);
    const dx = s0.x - sx;
    const dy = s0.y - sy;
    if (Math.sqrt(dx * dx + dy * dy) <= CLOSE_PX) {
      return { x: chain[0].x, y: chain[0].y, type: "close" };
    }
  }

  // 2. Endpoint snap: nearest vertex from all rooms + chain, skipping chain's last
  const skip = chain.length > 0 ? chain[chain.length - 1] : null;
  const allVerts = [];
  for (const room of rooms) {
    for (const v of room.verts) allVerts.push(v);
  }
  for (const v of chain) allVerts.push(v);
  const nearest = closestEndpoint(sx, sy, allVerts, skip, SNAP_PT_PX);
  if (nearest !== null) {
    return { x: nearest.x, y: nearest.y, type: "point" };
  }

  // 3. Free (Alt held): skip grid, use raw world point
  if (altHeld) {
    return { x: raw.x, y: raw.y, type: "free" };
  }

  // 4. Grid snap (default)
  const snapped = gridSnap(raw, step);
  return { x: snapped.x, y: snapped.y, type: "grid" };
}

// ── Mutations (operate on model) ─────────────────────────────────────────────

/**
 * Place a vertex from a resolved snap into the active chain.
 * - "close" snap: routes to closeRoom().
 * - Others: push to chain, unless it would make a < MIN_SEG_M segment.
 * @param {Snap} snap
 */
export function placeVertex(snap) {
  if (snap.type === "close") {
    closeRoom();
    return;
  }
  const { chain } = model;
  if (chain.length > 0) {
    const last = chain[chain.length - 1];
    const dx = snap.x - last.x;
    const dy = snap.y - last.y;
    if (Math.sqrt(dx * dx + dy * dy) < MIN_SEG_M) return; // zero-length guard
  }
  chain.push({ x: snap.x, y: snap.y });
}

/**
 * Close the active chain into a closed Room polygon.
 * Requires >= 3 vertices. Returns true on success, false (no-op) below 3.
 * @returns {boolean}
 */
export function closeRoom() {
  const { chain } = model;
  if (chain.length < 3) return false;
  model.rooms.push({
    id: `w${_roomCounter++}`,
    closed: true,
    verts: [...chain],
  });
  model.chain.length = 0;
  return true;
}

/**
 * Finish the active chain as an open polyline.
 * >= 2 vertices → commits as open Room. < 2 → discards. Always clears chain.
 */
export function finishChain() {
  const { chain } = model;
  if (chain.length >= 2) {
    model.rooms.push({
      id: `w${_roomCounter++}`,
      closed: false,
      verts: [...chain],
    });
  }
  model.chain.length = 0;
}

/**
 * Pop the last vertex from the active chain. No-op on empty chain.
 */
export function undoPoint() {
  if (model.chain.length > 0) {
    model.chain.pop();
  }
}

// ── New pure geometry (LLD 10) ───────────────────────────────────────────────

/**
 * Number of edges in a room.
 * Closed: verts.length (includes the closing edge back to verts[0]).
 * Open:   verts.length - 1.
 * @param {Room} room
 * @returns {number}
 */
export function edgeCount(room) {
  if (room.verts.length === 0) return 0;
  return room.closed ? room.verts.length : room.verts.length - 1;
}

/**
 * Endpoints of edge i as [A, B] vertex refs.
 * For the closing edge of a closed room, B wraps to verts[0].
 * @param {Room} room
 * @param {number} i
 * @returns {[Vertex, Vertex]}
 */
export function edgeEndpoints(room, i) {
  const n = room.verts.length;
  const a = room.verts[i];
  const b = room.verts[(i + 1) % n];
  return [a, b];
}

/**
 * Signed-area shoelace magnitude in m² (0 for < 3 verts).
 * Returns absolute area — meaningful for closed rooms.
 * @param {Vertex[]} verts
 * @returns {number}
 */
export function polygonArea(verts) {
  const n = verts.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * Total edge length in metres.
 * When closed is true, includes the closing edge from verts[n-1] back to verts[0].
 * @param {Vertex[]} verts
 * @param {boolean} closed
 * @returns {number}
 */
export function polygonPerimeter(verts, closed) {
  const n = verts.length;
  if (n < 2) return 0;
  let total = 0;
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

/**
 * Area-weighted polygon centroid in world metres.
 * Falls back to vertex mean if the polygon has zero area (degenerate/collinear).
 * @param {Vertex[]} verts
 * @returns {{ x:number, y:number }}
 */
export function centroid(verts) {
  const n = verts.length;
  if (n === 0) return { x: 0, y: 0 };
  if (n === 1) return { x: verts[0].x, y: verts[0].y };

  // Shoelace-based centroid formula
  let cx = 0;
  let cy = 0;
  let area2 = 0; // 2 * signed area
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    const cross = a.x * b.y - b.x * a.y;
    area2 += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }

  if (Math.abs(area2) < 1e-12) {
    // Degenerate: fall back to vertex mean
    let sx = 0, sy = 0;
    for (const v of verts) { sx += v.x; sy += v.y; }
    return { x: sx / n, y: sy / n };
  }

  const inv = 1 / (3 * area2);
  return { x: cx * inv, y: cy * inv };
}

/**
 * Find a committed room by id, or null.
 * @param {string} id
 * @returns {Room|null}
 */
export function findRoom(id) {
  for (const room of model.rooms) {
    if (room.id === id) return room;
  }
  return null;
}

/**
 * Set edge i of `room` to exactly `metres`, keeping the start vertex fixed
 * and moving the end vertex along the current edge direction.
 * No-op (returns false) if:
 *   - the edge is degenerate (zero-length, can't derive a direction)
 *   - metres < MIN_SEG_M
 * Mutates room.verts in place.
 * @param {Room} room
 * @param {number} i  edge index
 * @param {number} metres  desired length in metres
 * @returns {boolean} true if geometry changed
 */
export function setEdgeLength(room, i, metres) {
  if (metres < MIN_SEG_M) return false;

  const [a, b] = edgeEndpoints(room, i);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < MIN_SEG_M) return false; // degenerate edge: no direction

  // Unit vector from A to B
  const ux = dx / len;
  const uy = dy / len;

  // Move B to A + metres * unit direction
  b.x = a.x + ux * metres;
  b.y = a.y + uy * metres;
  return true;
}
