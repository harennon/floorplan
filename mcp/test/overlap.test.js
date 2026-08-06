/**
 * Unit — overlap geometry (overlap.js) + check_brief wiring (tools.js). LLD 161.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  segmentsProperlyIntersect,
  interiorPoint,
  pointStrictlyInside,
  roomsOverlap,
} from "../src/overlap.js";
import * as session from "../src/session.js";
import * as tools from "../src/tools.js";
import { wallsModel } from "../src/core.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a fake closed room object for roomsOverlap (no need for full plan). */
function makeRoom(vertsArray) {
  return { id: "test", verts: vertsArray, closed: true };
}

/** Rectangle verts: top-left (x,y), width w, height h. */
function rect(x, y, w, h) {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

beforeEach(() => session.resetAll());

// ── segmentsProperlyIntersect ────────────────────────────────────────────────

test("segmentsProperlyIntersect: crossing X → true", () => {
  // Diagonal cross: (0,0)-(2,2) and (0,2)-(2,0)
  assert.equal(
    segmentsProperlyIntersect({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 }),
    true
  );
});

test("segmentsProperlyIntersect: axis-aligned cross → true", () => {
  // Horizontal (0,1)-(2,1) and vertical (1,0)-(1,2)
  assert.equal(
    segmentsProperlyIntersect({ x: 0, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 0 }, { x: 1, y: 2 }),
    true
  );
});

test("segmentsProperlyIntersect: disjoint segments → false", () => {
  // Both horizontal, separate.
  assert.equal(
    segmentsProperlyIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }),
    false
  );
  // Non-intersecting diagonal segments.
  assert.equal(
    segmentsProperlyIntersect({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }, { x: 3, y: 1 }),
    false
  );
});

test("segmentsProperlyIntersect: collinear overlapping segments → false", () => {
  // Both on y=0, overlapping range [0,2] ∩ [1,3] = [1,2].
  assert.equal(
    segmentsProperlyIntersect({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 0 }),
    false
  );
});

test("segmentsProperlyIntersect: endpoint-only touch (shared endpoint) → false", () => {
  // Segments share endpoint (1,1).
  assert.equal(
    segmentsProperlyIntersect({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 0 }),
    false
  );
});

test("segmentsProperlyIntersect: T-junction (endpoint on other's interior) → false", () => {
  // (1,0) is the midpoint of segment (0,0)-(2,0); second segment starts there.
  assert.equal(
    segmentsProperlyIntersect({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 2 }),
    false
  );
});

// ── interiorPoint ────────────────────────────────────────────────────────────

test("interiorPoint: rectangle → strictly interior point", () => {
  const verts = rect(0, 0, 4, 3);
  const p = interiorPoint(verts);
  // Must be strictly inside the rectangle.
  assert.equal(pointStrictlyInside(verts, p), true);
  // Must not be equal to any vertex.
  for (const v of verts) {
    assert.ok(
      Math.abs(p.x - v.x) > 1e-12 || Math.abs(p.y - v.y) > 1e-12,
      `interiorPoint returned vertex (${v.x},${v.y})`
    );
  }
});

test("interiorPoint: concave L-shaped polygon → strictly interior point", () => {
  // L-shape: a 4×4 square with a 2×2 notch cut from top-right.
  //   (0,4) - (2,4) - (2,2) - (4,2) - (4,0) - (0,0)
  const verts = [
    { x: 0, y: 4 },
    { x: 2, y: 4 },
    { x: 2, y: 2 },
    { x: 4, y: 2 },
    { x: 4, y: 0 },
    { x: 0, y: 0 },
  ];
  const p = interiorPoint(verts);
  assert.equal(pointStrictlyInside(verts, p), true);
  // Not a vertex.
  for (const v of verts) {
    assert.ok(
      Math.abs(p.x - v.x) > 1e-12 || Math.abs(p.y - v.y) > 1e-12,
      `interiorPoint returned vertex (${v.x},${v.y})`
    );
  }
});

test("interiorPoint: triangle → strictly interior point", () => {
  const verts = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 4 }];
  const p = interiorPoint(verts);
  assert.equal(pointStrictlyInside(verts, p), true);
});

// ── pointStrictlyInside ──────────────────────────────────────────────────────

test("pointStrictlyInside: clearly interior point → true", () => {
  const verts = rect(0, 0, 4, 3);
  assert.equal(pointStrictlyInside(verts, { x: 2, y: 1.5 }), true);
});

test("pointStrictlyInside: clearly exterior point → false", () => {
  const verts = rect(0, 0, 4, 3);
  assert.equal(pointStrictlyInside(verts, { x: 10, y: 10 }), false);
  assert.equal(pointStrictlyInside(verts, { x: -1, y: 1 }), false);
});

test("pointStrictlyInside: point exactly on an edge → false", () => {
  const verts = rect(0, 0, 4, 3);
  // On top edge (y=0), x=2.
  assert.equal(pointStrictlyInside(verts, { x: 2, y: 0 }), false);
  // On left edge (x=0), y=1.5.
  assert.equal(pointStrictlyInside(verts, { x: 0, y: 1.5 }), false);
});

test("pointStrictlyInside: point exactly on a vertex → false", () => {
  const verts = rect(0, 0, 4, 3);
  assert.equal(pointStrictlyInside(verts, { x: 0, y: 0 }), false);
  assert.equal(pointStrictlyInside(verts, { x: 4, y: 3 }), false);
});

test("pointStrictlyInside: point within OVERLAP_EPS of an edge → false (boundary guard)", () => {
  const verts = rect(0, 0, 4, 3);
  // Point at (2, 5e-10) — just barely inside the OVERLAP_EPS=1e-9 boundary band.
  assert.equal(pointStrictlyInside(verts, { x: 2, y: 5e-10 }), false);
});

// ── roomsOverlap — firm deterministic assertions ─────────────────────────────

test("roomsOverlap: two partially overlapping rectangles → true", () => {
  const a = makeRoom(rect(0, 0, 4, 3));
  const b = makeRoom(rect(2, 1, 4, 3)); // overlaps from (2,1) to (4,3)
  assert.equal(roomsOverlap(a, b), true);
});

test("roomsOverlap: two disjoint rectangles → false", () => {
  const a = makeRoom(rect(0, 0, 4, 3));
  const b = makeRoom(rect(10, 0, 4, 3)); // far away
  assert.equal(roomsOverlap(a, b), false);
});

test("roomsOverlap: shared-wall-adjacent rectangles (full shared edge) → false", () => {
  // A = (0,0)-(4,0)-(4,3)-(0,3), B = (4,0)-(8,0)-(8,3)-(4,3)
  const a = makeRoom([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }]);
  const b = makeRoom([{ x: 4, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 3 }, { x: 4, y: 3 }]);
  assert.equal(roomsOverlap(a, b), false);
});

test("roomsOverlap: two identical rectangles → true", () => {
  const a = makeRoom([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }]);
  const b = makeRoom([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }]);
  assert.equal(roomsOverlap(a, b), true);
});

test("roomsOverlap: rooms touching only at a single shared vertex → false", () => {
  const a = makeRoom(rect(0, 0, 2, 2));
  const b = makeRoom(rect(2, 2, 2, 2)); // touches only at corner (2,2)
  assert.equal(roomsOverlap(a, b), false);
});

test("roomsOverlap: rooms sharing only a partial edge (collinear, no interior overlap) → false", () => {
  // A = (0,0)-(4,0)-(4,2)-(0,2), B = (1,2)-(3,2)-(3,4)-(1,4)
  // B's bottom edge from (1,2) to (3,2) is collinear with A's top edge but shorter.
  // No interior intersection.
  const a = makeRoom([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }]);
  const b = makeRoom([{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }, { x: 1, y: 4 }]);
  assert.equal(roomsOverlap(a, b), false);
});

test("roomsOverlap: one rectangle fully inside another → true", () => {
  const a = makeRoom(rect(0, 0, 10, 10));
  const b = makeRoom(rect(2, 2, 3, 3)); // fully inside a
  assert.equal(roomsOverlap(a, b), true);
});

test("roomsOverlap: concave (L-shaped) room overlapping a rectangle → true", () => {
  // L-shape: covers x=[0,6],y=[0,3] plus x=[0,3],y=[3,6].
  //   (0,0)-(6,0)-(6,3)-(3,3)-(3,6)-(0,6)
  const lShape = [
    { x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 3 },
    { x: 3, y: 3 }, { x: 3, y: 6 }, { x: 0, y: 6 },
  ];
  // Rectangle at (4,1)-(8,1)-(8,4)-(4,4): overlaps with the bottom-right arm.
  // Edge (6,0)-(6,3) of L properly crosses rectangle bottom edge (4,1)-(8,1) at x=6,y=1.
  const r = [{ x: 4, y: 1 }, { x: 8, y: 1 }, { x: 8, y: 4 }, { x: 4, y: 4 }];
  const a = makeRoom(lShape);
  const b = makeRoom(r);
  assert.equal(roomsOverlap(a, b), true);
});

test("roomsOverlap: symmetry holds for all cases", () => {
  const pairs = [
    // overlapping
    [rect(0, 0, 4, 3), rect(2, 1, 4, 3), true],
    // disjoint
    [rect(0, 0, 4, 3), rect(10, 0, 4, 3), false],
    // adjacent (full edge)
    [
      [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }],
      [{ x: 4, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 3 }, { x: 4, y: 3 }],
      false,
    ],
    // identical
    [
      [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }],
      [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }],
      true,
    ],
    // vertex touch
    [rect(0, 0, 2, 2), rect(2, 2, 2, 2), false],
    // containment
    [rect(0, 0, 10, 10), rect(2, 2, 3, 3), true],
  ];

  for (const [av, bv, expected] of pairs) {
    const a = makeRoom(av);
    const b = makeRoom(bv);
    assert.equal(roomsOverlap(a, b), expected, `roomsOverlap(a,b): expected ${expected}`);
    assert.equal(roomsOverlap(b, a), expected, `roomsOverlap(b,a): expected ${expected}`);
  }
});

// ── check_brief wiring (tools.js) ────────────────────────────────────────────

test("check_brief: two overlapping rooms → satisfied:false with unmet naming both room ids", () => {
  tools.tool_set_brief({ minWalkwayM: 0.90 }); // no room field → multi-room allowed
  session.newPlan();
  const r1 = tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 3 } });
  const r2 = tools.tool_add_room({ rect: { x: 2, y: 1, w: 4, h: 3 } }); // overlaps r1
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);

  const briefResult = tools.tool_check_brief();
  assert.equal(briefResult.satisfied, false);
  const overlapMsg = briefResult.unmet.find((u) => /overlap/.test(u));
  assert.ok(overlapMsg, `expected an overlap unmet entry; got: ${JSON.stringify(briefResult.unmet)}`);
  // Both room ids must be named.
  assert.ok(overlapMsg.includes(r1.roomId), `unmet must name room ${r1.roomId}; got: ${overlapMsg}`);
  assert.ok(overlapMsg.includes(r2.roomId), `unmet must name room ${r2.roomId}; got: ${overlapMsg}`);
});

test("check_brief: two disjoint rooms with all other reqs met → no overlap entry, satisfied:true", () => {
  tools.tool_set_brief({ minWalkwayM: 0.90 });
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 3 } });
  tools.tool_add_room({ rect: { x: 10, y: 0, w: 4, h: 3 } }); // disjoint
  const briefResult = tools.tool_check_brief();
  // No overlap entry.
  const overlapMsg = briefResult.unmet.find((u) => /overlap/.test(u));
  assert.equal(overlapMsg, undefined, `unexpected overlap entry: ${overlapMsg}`);
  assert.equal(briefResult.satisfied, true);
});

test("check_brief: two shared-wall-adjacent rooms → no overlap entry, satisfied:true", () => {
  tools.tool_set_brief({ minWalkwayM: 0.90 });
  session.newPlan();
  // Rooms share the full x=4 edge.
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 3 } });
  tools.tool_add_room({ rect: { x: 4, y: 0, w: 4, h: 3 } });
  const briefResult = tools.tool_check_brief();
  const overlapMsg = briefResult.unmet.find((u) => /overlap/.test(u));
  assert.equal(overlapMsg, undefined, `unexpected overlap entry: ${overlapMsg}`);
  assert.equal(briefResult.satisfied, true);
});

test("check_brief: single closed room (MVP path) → overlap pass adds nothing (regression)", () => {
  tools.tool_set_brief({ room: { w: 4, h: 3 }, minWalkwayM: 0.90 });
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 3 } });
  const briefResult = tools.tool_check_brief();
  const overlapMsg = briefResult.unmet.find((u) => /overlap/.test(u));
  assert.equal(overlapMsg, undefined, `single-room MVP must have no overlap entry; got: ${overlapMsg}`);
  assert.equal(briefResult.satisfied, true);
});

// ── Single-room guard regressions (Gap A) ────────────────────────────────────

test("Gap A regression: second add_room under single-room brief → rejected, no sliver (LLD 161 guard check)", () => {
  tools.tool_set_brief({ room: { w: 4, h: 4 } });
  session.newPlan();
  const r1 = tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  assert.equal(r1.ok, true);
  const r2 = tools.tool_add_room({ rect: { x: 5, y: 0, w: 4, h: 4 } });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /already has a room/);
  assert.equal(wallsModel.rooms.length, 1);
});

test("Gap A regression: no room in brief → second add_room allowed (guard's intentional limitation)", () => {
  tools.tool_set_brief({ minWalkwayM: 0.90 }); // no room field
  session.newPlan();
  const r1 = tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  const r2 = tools.tool_add_room({ rect: { x: 5, y: 0, w: 4, h: 4 } });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(wallsModel.rooms.length, 2);
});

test("Gap A regression: overlapping rooms with no-room brief → check_brief catches them", () => {
  tools.tool_set_brief({ minWalkwayM: 0.90 });
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  tools.tool_add_room({ rect: { x: 2, y: 2, w: 4, h: 4 } }); // overlaps first room
  const briefResult = tools.tool_check_brief();
  assert.equal(briefResult.satisfied, false);
  const overlapMsg = briefResult.unmet.find((u) => /overlap/.test(u));
  assert.ok(overlapMsg, "overlap evaluator must catch it when guard did not fire");
});
