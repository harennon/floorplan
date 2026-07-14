/**
 * clearance.js — pure geometry + state core for "does it fit?" clearance checking
 *
 * No DOM, no events. Testable. Mirrors walls.js / symbols.js structure.
 *
 * World units: metres. Gaps use the selected symbol's world-space AABB (from
 * corners()). Wall gaps are measured to the inner wall FACE: the verts[] arrays
 * are centerlines, so each gap is reduced by WALL_M/2 to account for wall
 * thickness (conservative — never over-reports walkable clearance).
 *
 * Note: for rotated symbols the AABB over-estimates the footprint (gap is
 * conservative / smaller), which is the safe direction for a "does it fit?" check.
 */

import { corners, CATALOG } from "./symbols.js";
import { WALL_M } from "./walls.js";

// ── Types (JSDoc) ─────────────────────────────────────────────────────────────

/** @typedef {"ok"|"tight"|"bad"} ClrStatus */
/** @typedef {"all"|"flagged"} ClrDensity */

/**
 * One computed gap from the selected symbol to a neighbour (wall or symbol).
 * a/b are the world-metre endpoints of the leader line; gap is metres (0 = overlap).
 * @typedef {{
 *   label: string,
 *   kind:  "wall"|"symbol",
 *   gap:   number,
 *   status: ClrStatus,
 *   a:     { x:number, y:number },
 *   b:     { x:number, y:number },
 *   neighbourId?: string
 * }} Clearance
 */

// ── Constants ─────────────────────────────────────────────────────────────────

export const THRESH_MIN     = 0.30;
export const THRESH_MAX     = 1.20;
export const THRESH_STEP    = 0.05;
export const DEFAULT_THRESHOLD = 0.60;

// ── Session-only UI state ─────────────────────────────────────────────────────
// NOT persisted to plan JSON / localStorage / URL hash — clearance is transient
// inspection state, not part of the drawn plan.

/** @type {number} */
export let threshold = DEFAULT_THRESHOLD;

/** @type {ClrDensity} */
export let density = "flagged";

/** @type {boolean} */
export let enabled = true;

// ── onChange listeners ────────────────────────────────────────────────────────

/** @type {Array<()=>void>} */
const _listeners = [];

/** Subscribe to state changes (threshold / density / enabled). */
export function onChange(cb) {
  _listeners.push(cb);
}

function _notify() {
  for (const cb of _listeners) cb();
}

// ── State setters ─────────────────────────────────────────────────────────────

/**
 * Set the minimum-clearance threshold (metres). Clamped to [THRESH_MIN, THRESH_MAX].
 * Fires onChange.
 * @param {number} m
 */
export function setThreshold(m) {
  threshold = Math.min(THRESH_MAX, Math.max(THRESH_MIN, m));
  _notify();
}

/**
 * Set annotation density. Fires onChange.
 * @param {ClrDensity} d
 */
export function setDensity(d) {
  density = d;
  _notify();
}

/**
 * Enable or disable the clearance overlay. Fires onChange.
 * @param {boolean} on
 */
export function setEnabled(on) {
  enabled = !!on;
  _notify();
}

// ── Pure geometry ─────────────────────────────────────────────────────────────

/** Flush tolerance: a wall-face gap within ±this (metres) counts as touching, not
 *  overlapping. 0.1mm — below the 0.01m display precision, far above FP noise (~1e-17). */
const WALL_FLUSH_EPS = 1e-4;

/** Symbol-to-symbol contact tolerance: an AABB axis-separation within ±this (metres) of
 *  0 counts as touching (a fit), not overlapping. 0.1mm — below the 0.01m display
 *  precision (a contact still reads 0.0m) and above any drag/round-trip float noise.
 *  Symbol AABB gaps carry no WALL_M/2 face offset, so — unlike WALL_FLUSH_EPS — this is
 *  not absorbing an FP residue; it classifies exact/near-exact contact as a fit. */
const SYM_CONTACT_EPS = 1e-4;

/**
 * Classify a symbol's near edge against a wall inner face.
 * @param {number} faceGap  metres from AABB edge to wall inner face
 *                          (rawGap - WALL_M/2), signed; negative = edge inside wall body.
 * @returns {{ gap: number, status: ClrStatus }}
 */
function wallFaceStatus(faceGap) {
  if (faceGap < -WALL_FLUSH_EPS) return { gap: 0, status: "bad" };   // inside wall body
  if (faceGap <=  WALL_FLUSH_EPS) return { gap: 0, status: "tight" }; // flush / touching
  return { gap: faceGap, status: classify(faceGap) };
}

/**
 * Classify a gap (metres) against the current threshold.
 * gap <= 0  → "bad" (overlap or sticking through wall)
 * 0 < gap < threshold → "tight"
 * gap >= threshold    → "ok"
 * @param {number} gap  metres
 * @returns {ClrStatus}
 */
export function classify(gap) {
  if (gap <= 0) return "bad";
  if (gap < threshold) return "tight";
  return "ok";
}

/**
 * World-space axis-aligned bounding box of a symbol.
 * Uses corners() (which handles rotation) and takes min/max of x and y.
 * For unrotated symbols this is exact; for rotated symbols it is conservative
 * (slightly larger than the true footprint).
 * @param {import("./symbols.js").Sym} sym
 * @returns {{ l:number, r:number, t:number, b:number }}
 */
export function aabb(sym) {
  const cs = corners(sym);
  let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
  for (const c of cs) {
    if (c.x < l) l = c.x;
    if (c.x > r) r = c.x;
    if (c.y < t) t = c.y;
    if (c.y > b) b = c.y;
  }
  return { l, r, t, b };
}

/**
 * True if world point (x, y) is strictly inside a closed room polygon.
 * Uses even-odd (ray casting) rule; works for convex and non-convex polygons.
 * Points exactly on an edge may return true or false — not guaranteed.
 * @param {import("./walls.js").Room} room
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function pointInRoom(room, x, y) {
  const verts = room.verts;
  const n = verts.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = verts[i].x, yi = verts[i].y;
    const xj = verts[j].x, yj = verts[j].y;
    // Ray cast along +x from (x,y)
    if (((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Intersect a horizontal ray from (ox, oy) in the +x direction with a
 * polygon edge from (x1,y1) to (x2,y2). Returns the x-coordinate of the
 * intersection, or null if there is none (ray misses or is parallel).
 * Only returns intersections where x > ox (forward ray).
 * @param {number} ox  ray origin x
 * @param {number} oy  ray origin y
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {number|null}
 */
function _rayHitH(ox, oy, x1, y1, x2, y2) {
  // Edge must straddle the horizontal line y = oy
  if ((y1 <= oy && y2 <= oy) || (y1 >= oy && y2 >= oy)) return null;
  // x at intersection
  const t = (oy - y1) / (y2 - y1);
  const ix = x1 + t * (x2 - x1);
  if (ix > ox) return ix;
  return null;
}

/**
 * Intersect a vertical ray from (ox, oy) in the +y direction with a polygon
 * edge from (x1,y1) to (x2,y2). Returns the y-coordinate of the intersection,
 * or null if there is none. Only returns intersections where y > oy.
 * @param {number} ox
 * @param {number} oy
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {number|null}
 */
function _rayHitV(ox, oy, x1, y1, x2, y2) {
  if ((x1 <= ox && x2 <= ox) || (x1 >= ox && x2 >= ox)) return null;
  const t = (ox - x1) / (x2 - x1);
  const iy = y1 + t * (y2 - y1);
  if (iy > oy) return iy;
  return null;
}

/**
 * Compute all clearances FROM the selected symbol.
 *
 * Wall clearances: for each closed room whose interior contains the selected
 * symbol's centre, shoot an axis-aligned ray from each AABB side's midpoint
 * outward and find the nearest room edge intersection. The gap is reduced by
 * WALL_M/2 to convert from centerline-to-centerline to inner-face distance
 * (see LLD §Wall thickness). Clamped >= 0.
 *
 * Symbol clearances: AABB axis-separated gap to every other symbol (openings
 * skipped in both subject and neighbour roles per LLD).
 *
 * Returns [] when sym is null, sym is an opening, or enabled === false.
 *
 * @param {import("./symbols.js").Sym|null} sym
 * @param {{ rooms: import("./walls.js").Room[], symbols: import("./symbols.js").Sym[] }} world
 * @returns {Clearance[]}
 */
export function computeClearances(sym, world) {
  if (!sym || !enabled) return [];
  if (CATALOG[sym.type]?.openings) return [];
  if (CATALOG[sym.type]?.floorLayer) return [];

  const box = aabb(sym);
  const cx = (box.l + box.r) / 2;
  const cy = (box.t + box.b) / 2;

  /** @type {Clearance[]} */
  const results = [];

  // ── Wall clearances ──────────────────────────────────────────────────────

  for (const room of world.rooms) {
    if (!room.closed) continue;
    if (!pointInRoom(room, cx, cy)) continue;

    const verts = room.verts;
    const n = verts.length;

    // Helper: shoot ray from (ox, oy) along a given axis/direction and find
    // the nearest room-edge intersection, returning the distance.
    // direction: "right" | "left" | "down" | "up"
    /** @param {number} ox @param {number} oy @param {"right"|"left"|"down"|"up"} dir */
    function _wallDist(ox, oy, dir) {
      let bestDist = Infinity;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const v0 = verts[i], v1 = verts[j];
        let hit = null;
        if (dir === "right") {
          hit = _rayHitH(ox, oy, v0.x, v0.y, v1.x, v1.y);
          if (hit !== null) bestDist = Math.min(bestDist, hit - ox);
        } else if (dir === "left") {
          // Negate x to shoot in -x direction: reflect the edge
          hit = _rayHitH(-ox, oy, -v0.x, v0.y, -v1.x, v1.y);
          if (hit !== null) bestDist = Math.min(bestDist, hit - (-ox));
        } else if (dir === "down") {
          hit = _rayHitV(ox, oy, v0.x, v0.y, v1.x, v1.y);
          if (hit !== null) bestDist = Math.min(bestDist, hit - oy);
        } else { // up
          hit = _rayHitV(ox, -oy, v0.x, -v0.y, v1.x, -v1.y);
          if (hit !== null) bestDist = Math.min(bestDist, hit - (-oy));
        }
      }
      return bestDist === Infinity ? null : bestDist;
    }

    // Mid-height of left/right sides; mid-width of top/bottom sides
    const midY = (box.t + box.b) / 2;
    const midX = (box.l + box.r) / 2;

    const wallHalf = WALL_M / 2;

    // Left side: shoot left from box.l at midY
    {
      const dLeft  = _wallDist(box.l, midY, "left");
      const dRight0 = dLeft === null ? _wallDist(box.l, midY, "right") : null;
      if (dLeft !== null) {
        const rawGap = dLeft;
        const { gap, status } = wallFaceStatus(rawGap - wallHalf);
        const bx = box.l - rawGap; // wall centerline x
        results.push({
          label: "left wall",
          kind: "wall",
          gap,
          status,
          a: { x: box.l, y: midY },
          b: { x: bx + wallHalf, y: midY },
        });
      } else if (dRight0 !== null) {
        // AABB left edge has crossed the wall — straddle (Edge Case 8)
        results.push({
          label: "left wall",
          kind: "wall",
          gap: 0,
          status: "bad",
          a: { x: box.l, y: midY },
          b: { x: box.l + dRight0 - wallHalf, y: midY },
        });
      }
    }

    // Right side: shoot right from box.r at midY
    {
      const dRight = _wallDist(box.r, midY, "right");
      const dLeft0  = dRight === null ? _wallDist(box.r, midY, "left") : null;
      if (dRight !== null) {
        const rawGap = dRight;
        const { gap, status } = wallFaceStatus(rawGap - wallHalf);
        const bx = box.r + rawGap;
        results.push({
          label: "right wall",
          kind: "wall",
          gap,
          status,
          a: { x: box.r, y: midY },
          b: { x: bx - wallHalf, y: midY },
        });
      } else if (dLeft0 !== null) {
        // AABB right edge has crossed the wall — straddle (Edge Case 8)
        results.push({
          label: "right wall",
          kind: "wall",
          gap: 0,
          status: "bad",
          a: { x: box.r, y: midY },
          b: { x: box.r - dLeft0 + wallHalf, y: midY },
        });
      }
    }

    // Top side: shoot up from midX at box.t (y-down coords: "up" = -y direction)
    {
      const dTop  = _wallDist(midX, box.t, "up");
      const dDown0 = dTop === null ? _wallDist(midX, box.t, "down") : null;
      if (dTop !== null) {
        const rawGap = dTop;
        const { gap, status } = wallFaceStatus(rawGap - wallHalf);
        const by = box.t - rawGap;
        results.push({
          label: "top wall",
          kind: "wall",
          gap,
          status,
          a: { x: midX, y: box.t },
          b: { x: midX, y: by + wallHalf },
        });
      } else if (dDown0 !== null) {
        // AABB top edge has crossed the wall — straddle (Edge Case 8)
        results.push({
          label: "top wall",
          kind: "wall",
          gap: 0,
          status: "bad",
          a: { x: midX, y: box.t },
          b: { x: midX, y: box.t + dDown0 - wallHalf },
        });
      }
    }

    // Bottom side: shoot down from midX at box.b
    {
      const dBottom = _wallDist(midX, box.b, "down");
      const dUp0    = dBottom === null ? _wallDist(midX, box.b, "up") : null;
      if (dBottom !== null) {
        const rawGap = dBottom;
        const { gap, status } = wallFaceStatus(rawGap - wallHalf);
        const by = box.b + rawGap;
        results.push({
          label: "bottom wall",
          kind: "wall",
          gap,
          status,
          a: { x: midX, y: box.b },
          b: { x: midX, y: by - wallHalf },
        });
      } else if (dUp0 !== null) {
        // AABB bottom edge has crossed the wall — straddle (Edge Case 8)
        results.push({
          label: "bottom wall",
          kind: "wall",
          gap: 0,
          status: "bad",
          a: { x: midX, y: box.b },
          b: { x: midX, y: box.b - dUp0 + wallHalf },
        });
      }
    }

    // Only use the first containing room to avoid duplicate wall annotations
    break;
  }

  // ── Symbol clearances ────────────────────────────────────────────────────

  for (const other of world.symbols) {
    if (other.id === sym.id) continue;
    if (CATALOG[other.type]?.openings) continue;
    if (CATALOG[other.type]?.floorLayer) continue;

    const ob = aabb(other);
    const cat = CATALOG[other.type];
    const label = cat ? cat.label : other.type;

    // Axis-separated gap: positive means a gap exists on that axis.
    // dx > 0: the two boxes are separated horizontally (a walkway between their x-facing edges).
    // dy > 0: the two boxes are separated vertically (a walkway between their y-facing edges).
    // Real adjacent furniture shares overlap on exactly ONE axis, so the gap lives on the other.
    const dx = Math.max(ob.l - box.r, box.l - ob.r); // >0 if separated on x
    const dy = Math.max(ob.t - box.b, box.t - ob.b); // >0 if separated on y

    if (dx > 0 && dy <= 0) {
      // Separated only on x → horizontal gap
      const gap = dx;
      // Leader runs along the shared y mid-span of the facing edges
      const sharedT = Math.max(box.t, ob.t);
      const sharedB = Math.min(box.b, ob.b);
      const midY = sharedT < sharedB
        ? (sharedT + sharedB) / 2
        : (box.t + box.b) / 2;  // no y overlap: fall back to selected sym midline

      let aX, bX;
      if (ob.l >= box.r) { aX = box.r; bX = ob.l; }
      else                { aX = box.l; bX = ob.r; }

      results.push({
        label, kind: "symbol", gap,
        status: classify(gap),
        a: { x: aX, y: midY },
        b: { x: bX, y: midY },
        neighbourId: other.id,
      });
    } else if (dx <= 0 && dy > 0) {
      // Separated only on y → vertical gap
      const gap = dy;
      const sharedL = Math.max(box.l, ob.l);
      const sharedR = Math.min(box.r, ob.r);
      const midX = sharedL < sharedR
        ? (sharedL + sharedR) / 2
        : (box.l + box.r) / 2;  // no x overlap: fall back to selected sym midline

      let aY, bY;
      if (ob.t >= box.b) { aY = box.b; bY = ob.t; }
      else                { aY = box.t; bY = ob.b; }

      results.push({
        label, kind: "symbol", gap,
        status: classify(gap),
        a: { x: midX, y: aY },
        b: { x: midX, y: bY },
        neighbourId: other.id,
      });
    } else if (dx > 0 && dy > 0) {
      // Separated on both axes (diagonal arrangement).
      // Report min(dx, dy) as a conservative lower-bound approximation of the
      // nearest-corner distance; the true Euclidean corner gap would be
      // sqrt(dx²+dy²) but we keep this simple for v1.
      // NOTE: this intentionally under-reports the actual gap for diagonal
      // arrangements. It is conservative: a tight flag here may not mean the
      // walkway is truly tight, but it is never a false "ok" for a real gap.
      if (dx <= dy) {
        // Horizontal face pair is nearer — report horizontal gap
        const gap = dx;
        const sharedT = Math.max(box.t, ob.t);
        const sharedB = Math.min(box.b, ob.b);
        const midY = sharedT < sharedB
          ? (sharedT + sharedB) / 2
          : (box.t + box.b) / 2;

        let aX, bX;
        if (ob.l >= box.r) { aX = box.r; bX = ob.l; }
        else                { aX = box.l; bX = ob.r; }

        results.push({
          label, kind: "symbol", gap,
          status: classify(gap),
          a: { x: aX, y: midY },
          b: { x: bX, y: midY },
          neighbourId: other.id,
        });
      } else {
        // Vertical face pair is nearer — report vertical gap
        const gap = dy;
        const sharedL = Math.max(box.l, ob.l);
        const sharedR = Math.min(box.r, ob.r);
        const midX = sharedL < sharedR
          ? (sharedL + sharedR) / 2
          : (box.l + box.r) / 2;

        let aY, bY;
        if (ob.t >= box.b) { aY = box.b; bY = ob.t; }
        else                { aY = box.t; bY = ob.b; }

        results.push({
          label, kind: "symbol", gap,
          status: classify(gap),
          a: { x: midX, y: aY },
          b: { x: midX, y: bY },
          neighbourId: other.id,
        });
      }
    } else {
      // dx <= 0 AND dy <= 0. Split 1-D contact (touch on one axis, overlap on
      // the other) from genuine 2-D interpenetration (LLD 60 Defect 3). The
      // nearest-axis separation sep = max(dx, dy) is the least-negative axis.
      const sep = Math.max(dx, dy); // ≤ 0 here
      if (sep >= -SYM_CONTACT_EPS) {
        // 1-D contact → a fit. Leader along the touching faces (zero-length at
        // the shared face midpoint), reusing the face-pair leader math from the
        // positive-gap branches: dx >= dy → X-axis contact reuses the dx>0
        // horizontal-face block; else Y-axis contact reuses the dy>0
        // vertical-face block.
        let a, b;
        if (dx >= dy) {
          // Horizontal face pair (x-facing edges touch), overlap on y.
          const sharedT = Math.max(box.t, ob.t);
          const sharedB = Math.min(box.b, ob.b);
          const midY = sharedT < sharedB ? (sharedT + sharedB) / 2 : (box.t + box.b) / 2;
          const faceX = ob.l >= box.r ? box.r : box.l;
          a = { x: faceX, y: midY };
          b = { x: faceX, y: midY };
        } else {
          // Vertical face pair (y-facing edges touch), overlap on x.
          const sharedL = Math.max(box.l, ob.l);
          const sharedR = Math.min(box.r, ob.r);
          const midX = sharedL < sharedR ? (sharedL + sharedR) / 2 : (box.l + box.r) / 2;
          const faceY = ob.t >= box.b ? box.b : box.t;
          a = { x: midX, y: faceY };
          b = { x: midX, y: faceY };
        }
        results.push({
          label, kind: "symbol", gap: 0,
          status: "tight",
          a, b,
          neighbourId: other.id,
        });
      } else {
        // genuine 2-D interpenetration → overlap (unchanged), leader center-to-center
        const gap = 0;
        results.push({
          label, kind: "symbol", gap,
          status: "bad",
          a: { x: cx, y: cy },
          b: { x: (ob.l + ob.r) / 2, y: (ob.t + ob.b) / 2 },
          neighbourId: other.id,
        });
      }
    }
  }

  return results;
}

// ── Per-room preview scoping (LLD 142) ───────────────────────────────────────

/**
 * Tolerance for the on-wall test: an opening is considered hosted on an edge
 * if its center's perpendicular distance to the edge centerline is within
 * WALL_M/2 + this value. 0.05 m = 5 cm, well above FP noise but below
 * furniture-placement distances.
 */
const ON_WALL_EPS = 0.05;

/**
 * True if a symbol belongs to a room for preview scoping purposes.
 *
 * - Non-opening symbols: center strictly inside the room polygon (pointInRoom).
 * - Openings (CATALOG[sym.type].openings === true): center inside OR hosted on
 *   one of the room's wall edges within WALL_M/2 + ON_WALL_EPS (openings sit
 *   ON the boundary, so a strict interior test would miss them).
 *
 * Pure; no global reads. Salvaged from PR #134.
 *
 * @param {import("./walls.js").Room} room
 * @param {import("./symbols.js").Sym} sym
 * @returns {boolean}
 */
export function symbolBelongsToRoom(room, sym) {
  if (!room.closed || room.verts.length < 2) return false;

  const cx = sym.x;
  const cy = sym.y;

  if (pointInRoom(room, cx, cy)) return true;

  const cat = CATALOG[sym.type];
  if (!cat || !cat.openings) return false;

  // Opening: check if the center lies on one of the room's wall edges
  const halfWall = WALL_M / 2 + ON_WALL_EPS;
  const verts = room.verts;
  const n = verts.length;

  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    const edgeDx = b.x - a.x;
    const edgeDy = b.y - a.y;
    const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
    if (edgeLen < 1e-9) continue;

    // Unit along-edge direction and unit normal
    const tx = edgeDx / edgeLen;
    const ty = edgeDy / edgeLen;
    // Normal perpendicular to edge (one of the two perpendiculars — magnitude is
    // what matters for the distance test, so use either sign)
    const nx = -ty;
    const ny = tx;

    // Project center relative to edge start
    const relX = cx - a.x;
    const relY = cy - a.y;
    const along = relX * tx + relY * ty;
    const perp  = Math.abs(relX * nx + relY * ny);

    // Within the edge's t-span and within halfWall distance of the centerline
    if (along >= -halfWall && along <= edgeLen + halfWall && perp <= halfWall) {
      return true;
    }
  }

  return false;
}

/**
 * Return the worst ClrStatus across a list of Clearance objects.
 * "bad" > "tight" > "ok"; returns "ok" for an empty list.
 * @param {Clearance[]} list
 * @returns {ClrStatus}
 */
export function worstStatus(list) {
  let worst = "ok";
  for (const c of list) {
    if (c.status === "bad") return "bad";
    if (c.status === "tight") worst = "tight";
  }
  return worst;
}
