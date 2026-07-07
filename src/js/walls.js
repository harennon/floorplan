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
