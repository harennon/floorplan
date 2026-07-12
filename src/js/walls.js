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
/** @typedef {{ id:string, closed:boolean, verts:Vertex[], color?:string }} Room */
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

  // 3. Free (Alt held OR step is null / Off mode): skip grid, use raw world point
  if (altHeld || step == null) {
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

// ── New geometry (LLD 9) ──────────────────────────────────────────────────────

/**
 * Length of a single edge, metres.
 * @param {Vertex} a
 * @param {Vertex} b
 * @returns {number}
 */
export function edgeLength(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Shoelace absolute area of the ring verts[0..n-1] (implicit close), metres².
 * < 3 verts → 0.
 * @param {Vertex[]} verts
 * @returns {number}
 */
export function polygonArea(verts) {
  const n = verts.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += verts[i].x * verts[j].y;
    sum -= verts[j].x * verts[i].y;
  }
  return Math.abs(sum) / 2;
}

/**
 * Sum of edge lengths; when closed, adds the verts[n-1]→verts[0] edge. metres.
 * @param {Vertex[]} verts
 * @param {boolean} closed
 * @returns {number}
 */
export function perimeter(verts, closed) {
  const n = verts.length;
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    total += edgeLength(verts[i], verts[i + 1]);
  }
  if (closed && n >= 2) {
    total += edgeLength(verts[n - 1], verts[0]);
  }
  return total;
}

/**
 * Convenience: { area, perimeter } for a room. area = 0 when !closed.
 * @param {Room} room
 * @returns {{ area:number, perimeter:number }}
 */
export function roomMetrics(room) {
  return {
    area: room.closed ? polygonArea(room.verts) : 0,
    perimeter: perimeter(room.verts, room.closed),
  };
}

// ── Hydrate (LLD 16) ─────────────────────────────────────────────────────────

/**
 * Replace rooms+chain arrays IN PLACE (same array identity) and re-sync
 * _roomCounter past the max w<n> id so the next closeRoom/finishChain
 * doesn't collide with a loaded room id.
 * @param {{ rooms: Room[], chain: Vertex[] }} next
 */
export function hydrate(next) {
  model.rooms.splice(0, model.rooms.length, ...next.rooms);
  model.chain.splice(0, model.chain.length, ...next.chain);

  let maxId = -1;
  for (const r of model.rooms) {
    const m = typeof r.id === "string" ? r.id.match(/^w(\d+)$/) : null;
    if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
  }
  _roomCounter = maxId + 1;
}

// ── New export (LLD 26) ──────────────────────────────────────────────────────

/**
 * All wall segments as {a,b} vertex pairs:
 *   - Each committed room contributes consecutive vertex pairs (plus the closing
 *     edge verts[n-1]→verts[0] when the room is closed).
 *   - The active chain contributes consecutive vertex pairs from model.chain.
 *
 * Short segments (< MIN_SEG_M) are silently skipped — they have no usable
 * direction and cannot be flush targets.
 *
 * @returns {{ a:Vertex, b:Vertex }[]}
 */
export function wallSegments() {
  const out = [];

  for (const room of model.rooms) {
    const verts = room.verts;
    const n = verts.length;
    if (n < 2) continue;
    for (let i = 0; i < n - 1; i++) {
      _pushSegIfLong(out, verts[i], verts[i + 1]);
    }
    if (room.closed && n >= 2) {
      _pushSegIfLong(out, verts[n - 1], verts[0]);
    }
  }

  const chain = model.chain;
  const cn = chain.length;
  for (let i = 0; i < cn - 1; i++) {
    _pushSegIfLong(out, chain[i], chain[i + 1]);
  }

  return out;
}

function _pushSegIfLong(out, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.sqrt(dx * dx + dy * dy) >= MIN_SEG_M) {
    out.push({ a, b });
  }
}

/**
 * Rescale room edge `edgeIndex` to exactly `targetLenM`, keeping verts[i] fixed
 * and moving the far endpoint along the current edge direction. Mutates room.verts
 * in place.
 *
 * For a closed room the edge index ranges 0..n-1 (edge n-1 is verts[n-1]→verts[0]).
 * For an open room the edge index ranges 0..n-2.
 *
 * Returns false (no-op) on: targetLenM < MIN_SEG_M, edge length ~0 (no direction),
 * or edgeIndex out of range. Returns true on success.
 *
 * @param {Room} room
 * @param {number} edgeIndex
 * @param {number} targetLenM
 * @returns {boolean}
 */
export function rescaleEdge(room, edgeIndex, targetLenM) {
  if (targetLenM < MIN_SEG_M) return false;

  const verts = room.verts;
  const n = verts.length;

  // Validate edgeIndex
  const maxIndex = room.closed ? n - 1 : n - 2;
  if (edgeIndex < 0 || edgeIndex > maxIndex) return false;

  const iA = edgeIndex;
  const iB = room.closed ? (edgeIndex + 1) % n : edgeIndex + 1;

  const a = verts[iA];
  const b = verts[iB];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < MIN_SEG_M) return false; // degenerate edge, no direction

  const ux = dx / len;
  const uy = dy / len;

  // Move iB along the edge direction so the edge length equals targetLenM
  verts[iB] = { x: a.x + ux * targetLenM, y: a.y + uy * targetLenM };
  return true;
}

// ── Room editing (LLD 63) ─────────────────────────────────────────────────────

/** Right-angle tolerance: |cos(theta)| below this counts as square (~5° of 90°). */
export const RIGHT_ANGLE_COS_TOL = 0.087; // cos(85°)

/**
 * True if world point (x, y) lies within `tolM` of ANY of this room's own wall
 * segments (edges between consecutive verts, plus the closing edge for a closed
 * room). Pure; no global reads. Used by room-move to carry wall-mounted openings
 * (doors/windows), whose centers sit ON the wall line and so fail the strict
 * pointInRoom interior test. Scoped to the given room's edges only, so an opening
 * on a NEIGHBOUR's wall (or a shared wall) is not falsely attributed here.
 * @param {Room} room
 * @param {number} x  world metres
 * @param {number} y  world metres
 * @param {number} tolM  distance threshold, world metres
 * @returns {boolean}
 */
export function pointNearRoomWall(room, x, y, tolM) {
  const verts = room.verts;
  const n = verts.length;
  if (n < 2) return false;
  const tol2 = tolM * tolM;
  const last = room.closed ? n : n - 1; // closed: include verts[n-1]→verts[0]
  for (let i = 0; i < last; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    // Squared distance from (x,y) to segment ab.
    const abx = b.x - a.x, aby = b.y - a.y;
    const apx = x - a.x, apy = y - a.y;
    const len2 = abx * abx + aby * aby;
    let t = len2 > 0 ? (apx * abx + apy * aby) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = a.x + t * abx, cy = a.y + t * aby;
    const ddx = x - cx, ddy = y - cy;
    if (ddx * ddx + ddy * ddy <= tol2) return true;
  }
  return false;
}

/**
 * Translate every vertex of a room by (dx, dy) world metres. Rigid — shape,
 * angles, and edge lengths are all preserved. Mutates room.verts in place.
 * No-op-safe on dx===0 && dy===0. Works for closed and open rooms.
 * @param {Room} room
 * @param {number} dx  world metres
 * @param {number} dy  world metres
 */
export function moveRoom(room, dx, dy) {
  for (const v of room.verts) {
    v.x += dx;
    v.y += dy;
  }
}

/**
 * True iff room is an axis-agnostic rectangle: closed, exactly 4 verts, all four
 * corner turns within RIGHT_ANGLE_COS_TOL of 90°, no edge < MIN_SEG_M.
 * Rotation-agnostic (a tilted rectangle qualifies). Pure.
 * @param {Room} room
 * @returns {boolean}
 */
export function isRectangle(room) {
  if (!room || room.closed !== true) return false;
  const verts = room.verts;
  if (verts.length !== 4) return false;

  // Edge vectors ei = v(i) → v(i+1 mod 4); reject any edge shorter than MIN_SEG_M.
  const edges = [];
  for (let i = 0; i < 4; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % 4];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.sqrt(ex * ex + ey * ey);
    if (len < MIN_SEG_M) return false; // degenerate edge
    edges.push({ x: ex / len, y: ey / len });
  }

  // Each corner turn is the angle between the incoming and outgoing edge unit
  // vectors. The turn at vertex v(i+1) is between edge i and edge i+1; a right
  // angle means their dot product is ≈ 0.
  for (let i = 0; i < 4; i++) {
    const e0 = edges[i];
    const e1 = edges[(i + 1) % 4];
    const dot = e0.x * e1.x + e0.y * e1.y;
    if (Math.abs(dot) > RIGHT_ANGLE_COS_TOL) return false;
  }
  return true;
}

/**
 * Rectangle-preserving edge resize. Sets edge K=`edgeIndex` (vK→v(K+1)) to length
 * `targetLenM`, keeping all four angles at 90°. Mutates room.verts in place.
 *
 * Algorithm: anchor vK; u = unit(v(K+1) − vK); shift = u * (targetLenM − |eK|);
 * move v(K+1) AND v(K+2) by shift (vK and v(K+3) stay fixed). This changes the
 * edited edge's own length (its far endpoint moves), rigidly translates the far
 * perpendicular wall, and keeps the shape a rectangle. Verts are (mod 4).
 *
 * Self-guards for MCP-later safety: returns false (no-op) if !isRectangle(room),
 * targetLenM < MIN_SEG_M, or edgeIndex out of [0,3]. Returns true on success.
 * @param {Room} room
 * @param {number} edgeIndex  0..3
 * @param {number} targetLenM
 * @returns {boolean}
 */
export function rescaleRectEdge(room, edgeIndex, targetLenM) {
  if (targetLenM < MIN_SEG_M) return false;
  if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex > 3) return false;
  if (!isRectangle(room)) return false;

  const verts = room.verts;
  const K = edgeIndex;
  const vK   = verts[K];
  const vK1  = verts[(K + 1) % 4];
  const vK2  = verts[(K + 2) % 4];

  const dx = vK1.x - vK.x;
  const dy = vK1.y - vK.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < MIN_SEG_M) return false; // guarded by isRectangle, but be safe

  const ux = dx / len;
  const uy = dy / len;
  const delta = targetLenM - len;
  const shiftX = ux * delta;
  const shiftY = uy * delta;

  // Move the far endpoint of the edited edge and its neighbour by the same shift.
  // vK and v(K+3) stay fixed.
  vK1.x += shiftX;
  vK1.y += shiftY;
  vK2.x += shiftX;
  vK2.y += shiftY;
  return true;
}

// ── rectDims (LLD 82) ────────────────────────────────────────────────────────

/**
 * For a rectangle, return its two side lengths and the edge indices they map to.
 * Width = the edge pair nearer horizontal (|dx| >= |dy| for e0); height = the other.
 * Pure; does not mutate. Returns null if !isRectangle(room).
 *
 * @param {Room} room
 * @returns {{ w:number, h:number, wEdge:number, hEdge:number } | null}
 *          w/h in world metres; wEdge ∈ {0,2}, hEdge ∈ {1,3} (one member of each
 *          perpendicular pair; either works since parallel edges are equal length).
 */
export function rectDims(room) {
  if (!isRectangle(room)) return null;

  const verts = room.verts;

  // Edge 0: v0 → v1
  const e0x = verts[1].x - verts[0].x;
  const e0y = verts[1].y - verts[0].y;
  const len0 = Math.sqrt(e0x * e0x + e0y * e0y);

  // Edge 1: v1 → v2
  const e1x = verts[2].x - verts[1].x;
  const e1y = verts[2].y - verts[1].y;
  const len1 = Math.sqrt(e1x * e1x + e1y * e1y);

  // Edge 0 is "width" when its direction is more horizontal (|dx| >= |dy|)
  if (Math.abs(e0x) >= Math.abs(e0y)) {
    return { w: len0, h: len1, wEdge: 0, hEdge: 1 };
  } else {
    return { w: len1, h: len0, wEdge: 1, hEdge: 0 };
  }
}

// ── Room centroids (LLD 37) ──────────────────────────────────────────────────

/**
 * True polygon centroids of every CLOSED room (>=3 verts, non-degenerate).
 * Pure: reads only model.rooms. Skips open rooms and degenerate (|area|<eps) polygons.
 * Uses the standard signed-area centroid formula (winding-order-independent).
 * @returns {{ id:string, cx:number, cy:number }[]}   // world metres
 */
/**
 * Set or clear the color of a room (floor fill).
 * Pass a valid hex string to set; pass null or undefined to clear (delete the key).
 * Clearing makes the room fall back to the theme fill.
 * Returns true if the value changed.
 *
 * @param {Room} room
 * @param {string|null|undefined} hexOrNull
 * @returns {boolean}
 */
export function setRoomColor(room, hexOrNull) {
  if (!hexOrNull) {
    const changed = room.color !== undefined;
    delete room.color;
    return changed;
  }
  const changed = room.color !== hexOrNull;
  room.color = hexOrNull;
  return changed;
}

export function roomCentroids() {
  const out = [];
  for (const room of model.rooms) {
    if (!room.closed) continue;
    const verts = room.verts;
    const n = verts.length;
    if (n < 3) continue;

    // Signed area (shoelace): A = ½ Σ (xᵢ·yᵢ₊₁ − xᵢ₊₁·yᵢ)
    let A = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      A += verts[i].x * verts[j].y - verts[j].x * verts[i].y;
    }
    A /= 2;

    // Skip degenerate (collinear) polygons
    if (Math.abs(A) < 1e-9) continue;

    // Centroid: Cx = 1/(6A) Σ (xᵢ + xᵢ₊₁)(xᵢ·yᵢ₊₁ − xᵢ₊₁·yᵢ)
    //           Cy = 1/(6A) Σ (yᵢ + yᵢ₊₁)(xᵢ·yᵢ₊₁ − xᵢ₊₁·yᵢ)
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const cross = verts[i].x * verts[j].y - verts[j].x * verts[i].y;
      cx += (verts[i].x + verts[j].x) * cross;
      cy += (verts[i].y + verts[j].y) * cross;
    }
    const inv6A = 1 / (6 * A);
    cx *= inv6A;
    cy *= inv6A;

    out.push({ id: room.id, cx, cy });
  }
  return out;
}
