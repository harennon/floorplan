/**
 * overlap.js — polygon–polygon overlap test for room geometry (LLD 161).
 *
 * Pure module: verts in, boolean out. No DOM, no I/O, no external imports.
 *
 * Overlap definition: two closed rooms A, B OVERLAP iff their INTERIORS share
 * positive area. Boundary-only contact (shared full/partial edge or shared vertex)
 * is NOT an overlap — wall-adjacent rooms are reported as satisfied.
 *
 * Algorithm:
 *   1. Proper edge crossing: some edge of A and some edge of B cross at a point
 *      strictly interior to BOTH segments (orientation-sign test). Collinear
 *      overlaps, endpoint touches, and T-junctions all return false.
 *   2. Interior containment: a constructed strictly-interior point of A lies
 *      strictly inside B, OR vice versa. Catches full containment and identical rooms.
 */

/** Boundary / collinearity tolerance (metres). Below display + contact precision,
 *  above FP round-off. |cross| ≤ this ⇒ collinear/touch. */
const OVERLAP_EPS = 1e-9;

// ── Segment–segment crossing ─────────────────────────────────────────────────

/**
 * True iff segments p1→p2 and p3→p4 cross at a point interior to BOTH segments.
 * Orientation-sign test with strict sign opposition; collinear overlaps,
 * endpoint-only touches, and T-junctions all return false (so shared room walls
 * are NOT treated as crossings). Uses OVERLAP_EPS as the collinearity threshold.
 * @param {{x:number,y:number}} p1
 * @param {{x:number,y:number}} p2
 * @param {{x:number,y:number}} p3
 * @param {{x:number,y:number}} p4
 * @returns {boolean}
 */
export function segmentsProperlyIntersect(p1, p2, p3, p4) {
  // Cross-product sign of (p3,p4) relative to each end of (p1,p2), and vice versa.
  // d1 = cross(p3→p4, p3→p1), d2 = cross(p3→p4, p3→p2)
  // d3 = cross(p1→p2, p1→p3), d4 = cross(p1→p2, p1→p4)
  const d1x = p4.x - p3.x, d1y = p4.y - p3.y;
  const d2x = p2.x - p1.x, d2y = p2.y - p1.y;

  const cross1 = d1x * (p1.y - p3.y) - d1y * (p1.x - p3.x);
  const cross2 = d1x * (p2.y - p3.y) - d1y * (p2.x - p3.x);
  const cross3 = d2x * (p3.y - p1.y) - d2y * (p3.x - p1.x);
  const cross4 = d2x * (p4.y - p1.y) - d2y * (p4.x - p1.x);

  // Strictly-opposite signs on each side: no collinear, no endpoint touch.
  // |cross| ≤ OVERLAP_EPS counts as collinear/touch → not a proper crossing.
  if (Math.abs(cross1) <= OVERLAP_EPS || Math.abs(cross2) <= OVERLAP_EPS ||
      Math.abs(cross3) <= OVERLAP_EPS || Math.abs(cross4) <= OVERLAP_EPS) {
    return false;
  }

  return (cross1 > 0 ? cross2 < 0 : cross2 > 0) &&
         (cross3 > 0 ? cross4 < 0 : cross4 > 0);
}

// ── Interior point construction ──────────────────────────────────────────────

/**
 * True iff point q is strictly inside triangle (a, b, c) using the same
 * orientation test. Used by interiorPoint to find the deepest interior vertex.
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @param {{x:number,y:number}} c
 * @param {{x:number,y:number}} q
 * @returns {boolean}
 */
function _pointStrictlyInTriangle(a, b, c, q) {
  function cross2d(ox, oy, ax, ay, bx, by) {
    return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
  }
  const d1 = cross2d(a.x, a.y, b.x, b.y, q.x, q.y);
  const d2 = cross2d(b.x, b.y, c.x, c.y, q.x, q.y);
  const d3 = cross2d(c.x, c.y, a.x, a.y, q.x, q.y);

  const hasNeg = d1 < -OVERLAP_EPS || d2 < -OVERLAP_EPS || d3 < -OVERLAP_EPS;
  const hasPos = d1 > OVERLAP_EPS || d2 > OVERLAP_EPS || d3 > OVERLAP_EPS;
  return !(hasNeg && hasPos) && Math.abs(d1) > OVERLAP_EPS && Math.abs(d2) > OVERLAP_EPS && Math.abs(d3) > OVERLAP_EPS;
}

/**
 * A point guaranteed STRICTLY inside a simple polygon (convex or concave),
 * constructed via the extreme-vertex ear method. Never returns a vertex, so it
 * never coincides with another room's edge in the degenerate (identical /
 * adjacent / contained) cases. Assumes ≥3 verts, non-self-intersecting.
 * @param {{x:number,y:number}[]} verts  polygon vertices in order
 * @returns {{x:number,y:number}}
 */
export function interiorPoint(verts) {
  const n = verts.length;

  // 1. Find extreme vertex v: smallest y, ties broken by smallest x.
  let vi = 0;
  for (let i = 1; i < n; i++) {
    if (verts[i].y < verts[vi].y ||
        (verts[i].y === verts[vi].y && verts[i].x < verts[vi].x)) {
      vi = i;
    }
  }

  const v = verts[vi];
  const u = verts[(vi - 1 + n) % n];
  const w = verts[(vi + 1) % n];

  // 2. Find any other vertex strictly inside triangle (u,v,w).
  let best = null;
  let bestDist = -1;

  // Distance of a point from line u-w (numerator of perpendicular distance).
  const uwDx = w.x - u.x;
  const uwDy = w.y - u.y;

  for (let i = 0; i < n; i++) {
    if (i === vi) continue;
    const q = verts[i];
    if (_pointStrictlyInTriangle(u, v, w, q)) {
      // Maximise perpendicular distance from u–w (deepest reflex intruder).
      const dist = Math.abs(uwDy * q.x - uwDx * q.y + w.x * u.y - w.y * u.x);
      if (dist > bestDist) {
        bestDist = dist;
        best = q;
      }
    }
  }

  if (best !== null) {
    // Midpoint of v–best: strictly interior because both are strictly inside the polygon.
    return { x: (v.x + best.x) / 2, y: (v.y + best.y) / 2 };
  }

  // No vertex inside the ear → (u,v,w) is an ear; return its centroid.
  return { x: (u.x + v.x + w.x) / 3, y: (u.y + v.y + w.y) / 3 };
}

// ── Point-in-polygon (strict, boundary-exclusive) ───────────────────────────

/**
 * True iff point p is strictly inside poly (even-odd ray cast) AND farther than
 * OVERLAP_EPS from every edge of poly. On-boundary points return false.
 * @param {{x:number,y:number}[]} verts
 * @param {{x:number,y:number}} p
 * @returns {boolean}
 */
export function pointStrictlyInside(verts, p) {
  const n = verts.length;

  // Boundary guard: if p is within OVERLAP_EPS of any edge, return false.
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < OVERLAP_EPS * OVERLAP_EPS) continue; // degenerate edge

    // Project p onto the segment; clamp t to [0,1].
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    const closestX = a.x + t * dx;
    const closestY = a.y + t * dy;
    const distSq = (p.x - closestX) * (p.x - closestX) + (p.y - closestY) * (p.y - closestY);
    if (distSq <= OVERLAP_EPS * OVERLAP_EPS) return false;
  }

  // Even-odd ray cast (ray in +x direction).
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = verts[i].x, yi = verts[i].y;
    const xj = verts[j].x, yj = verts[j].y;
    if ((yi > p.y) !== (yj > p.y) &&
        p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Room–room overlap ────────────────────────────────────────────────────────

/**
 * True iff the INTERIORS of two CLOSED room polygons share positive area
 * (partial overlap, X-crossing, full containment, or identical rooms). Boundary-
 * only contact — shared full/partial edge or shared vertex — returns false, so
 * wall-adjacent rooms are NOT flagged. Deterministic for all configurations.
 * @param {import("../../src/js/walls.js").Room} a  closed room
 * @param {import("../../src/js/walls.js").Room} b  closed room
 * @returns {boolean}
 */
export function roomsOverlap(a, b) {
  const av = a.verts;
  const bv = b.verts;
  const an = av.length;
  const bn = bv.length;

  // Leg 1: proper edge crossing.
  for (let i = 0; i < an; i++) {
    const a1 = av[i];
    const a2 = av[(i + 1) % an];
    for (let j = 0; j < bn; j++) {
      const b1 = bv[j];
      const b2 = bv[(j + 1) % bn];
      if (segmentsProperlyIntersect(a1, a2, b1, b2)) return true;
    }
  }

  // Leg 2: interior containment — constructed strictly-interior point of one
  // polygon inside the other.
  const pa = interiorPoint(av);
  if (pointStrictlyInside(bv, pa)) return true;

  const pb = interiorPoint(bv);
  if (pointStrictlyInside(av, pb)) return true;

  return false;
}
