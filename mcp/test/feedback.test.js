/**
 * Unit — feedback shaping (feedback.js, the loop's core). LLD 32 Test reqs.
 *
 * Scenarios are built against the REAL core (walls/symbols/clearance) so the
 * assertions exercise classify()/computeClearances() verbatim, not a mock.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as session from "../src/session.js";
import * as tools from "../src/tools.js";
import { buildClearanceReport } from "../src/feedback.js";
import { aabb, getSymbol, wallsModel, symbolsModel, pointInRoom } from "../src/core.js";

function world() {
  return { rooms: wallsModel.rooms, symbols: symbolsModel.symbols };
}
function report(thr, id) {
  return buildClearanceReport(world(), thr, id, aabb, getSymbol);
}

beforeEach(() => session.resetAll());

test("positive sub-threshold gap: tight (not bad), gapCm/deficitCm, NL move", () => {
  session.newPlan();
  // Big room so walls don't interfere; two sofas 18 cm apart on x.
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  // sofa 2.0x0.9 at x=3 → right edge 4.0; second sofa left edge at 4.18 → center 5.18
  tools.tool_place_symbol({ type: "sofa", x: 3.0, y: 6.0 });
  tools.tool_place_symbol({ type: "sofa", x: 5.18, y: 6.0 });
  const r = report(0.60);
  assert.equal(r.satisfied, false);
  assert.equal(r.worstStatus, "tight"); // NOT bad — classify returns tight for 0<gap<thr

  const subj = r.items[0];
  const g = subj.gaps.find((x) => x.kind === "symbol");
  assert.ok(g, "has a symbol gap");
  assert.equal(g.gapCm, 18);
  assert.equal(g.deficitCm, 42);
  assert.equal(g.status, "tight");
  // Neighbour is to the right → move subject -x to open the gap.
  assert.equal(g.axis, "x");
  assert.equal(g.openDir, "-x");

  assert.ok(r.violations.length >= 1);
  assert.match(r.violations[0], /Sofa/);
  assert.match(r.violations[0], /Move Sofa to ~\(/);
});

test("bad only for overlap", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  tools.tool_place_symbol({ type: "sofa", x: 4, y: 6 });
  tools.tool_place_symbol({ type: "desk", x: 4.3, y: 6 }); // overlapping
  const r = report(0.60);
  const subj = r.items.find((i) => i.label === "Sofa");
  const g = subj.gaps.find((x) => x.kind === "symbol");
  assert.equal(g.status, "bad");
  assert.equal(r.worstStatus, "bad");
  assert.ok(r.violations.some((v) => /overlaps/.test(v)));
});

test("boundary: gap exactly at threshold → ok, deficit 0, satisfied", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  // Use threshold 0.5 (float-exact) so an exactly-at-threshold gap is
  // representable: first sofa right edge 4.0, second left edge 4.5 → gap 0.5.
  tools.tool_place_symbol({ type: "sofa", x: 3.0, y: 6.0 }); // box 2.0..4.0
  tools.tool_place_symbol({ type: "sofa", x: 5.5, y: 6.0 }); // box 4.5..6.5 → gap 0.5
  const r = report(0.5);
  const subj = r.items[0];
  const g = subj.gaps.find((x) => x.kind === "symbol");
  assert.equal(g.gapM, 0.5);
  assert.equal(g.status, "ok"); // gap >= threshold
  assert.equal(g.deficitCm, 0);
  assert.equal(r.satisfied, true);
});

test("near-boundary rounding: gapCm reads the threshold yet status is tight / not satisfied", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  // Gap ~0.598 → rounds to gapCm 60, but the raw value < 0.60 so status is tight.
  // This is the LLD caveat: the agent must key its stopping decision off `status`
  // (raw-value truth), NOT off the rounded gapCm reading equal to the threshold.
  // (deficitCm can round to 0 exactly at the boundary — which is precisely why
  // `status` is the reliable signal there.)
  tools.tool_place_symbol({ type: "sofa", x: 3.0, y: 6.0 }); // box 2.0..4.0
  const b = tools.tool_place_symbol({ type: "sofa", x: 5.598, y: 6.0 }).id;
  tools.tool_move_symbol({ id: b, x: 4.0 + 0.598 + 1.0, y: 6.0 });
  const r = report(0.60);
  const subj = r.items[0];
  const g = subj.gaps.find((x) => x.kind === "symbol");
  assert.equal(g.gapCm, 60); // rounds to 60
  assert.equal(g.status, "tight"); // raw value < 0.60 — the truth signal
  assert.equal(r.satisfied, false);
});

test("reconciliation: subject tight on two same-sign axes → single clearing move", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  // Subject chair 0.5x0.5 at (2,2). Neighbour chairs to its right (x) and below (y),
  // each ~0.2m away → both violated, opening dirs -x and -y (same sign per axis).
  const subj = tools.tool_place_symbol({ type: "chair", x: 2.0, y: 2.0 }).id; // box 1.75..2.25
  tools.tool_place_symbol({ type: "chair", x: 2.95, y: 2.0 }); // left edge 2.70 → x gap 0.45
  tools.tool_place_symbol({ type: "chair", x: 2.0, y: 2.95 }); // top edge 2.70 → y gap 0.45
  const r = report(0.60, subj);
  const item = r.items[0];
  assert.equal(item.boxedInAxes.length, 0);
  assert.ok(item.suggestedMove, "has a suggestedMove");
  // Re-evaluate at the suggested center: move the subject and re-check.
  tools.tool_move_symbol({ id: subj, x: item.suggestedMove.toX, y: item.suggestedMove.toY });
  const r2 = report(0.60, subj);
  assert.equal(r2.items[0].worstStatus, "ok");
});

test("boxed-in: pinned between left wall and a right-side desk → boxedInAxes x, no move", () => {
  session.newPlan();
  // Narrow room on x: width 4.0. sofa 2.0 wide needs 2.0 + 2*0.6 = 3.2 m of clear
  // span, but the sofa+desk+walls leave less → infeasible by translation on x.
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 4.0, h: 12 } });
  // Sofa pinned flush left (box 0.1..2.1, tight to the left wall).
  const sofa = tools.tool_place_symbol({ type: "sofa", x: 1.1, y: 6.0 }).id;
  // Desk to the right, boxing the sofa in on +x.
  tools.tool_place_symbol({ type: "desk", x: 3.2, y: 6.0 });
  const r = report(0.60, sofa);
  const item = r.items[0];
  assert.ok(item.boxedInAxes.includes("x"), "x axis is boxed-in");
  assert.equal(item.suggestedMove, null);
  // Violation is a structural instruction, not a nudge.
  const v = r.violations.find((s) => /Sofa/.test(s));
  assert.match(v, /pinned on the x-axis|widen the room|smaller pieces/);
  assert.doesNotMatch(v, /Move Sofa to ~\(/);
});

test("gapCm/deficitCm rounding matches the spec formulas", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  tools.tool_place_symbol({ type: "sofa", x: 3.0, y: 6.0 });
  tools.tool_place_symbol({ type: "sofa", x: 5.37, y: 6.0 }); // gap 0.37
  const r = report(0.60);
  const g = r.items[0].gaps.find((x) => x.kind === "symbol");
  assert.equal(g.gapCm, Math.round(g.gapM * 100));
  assert.equal(g.deficitCm, Math.max(0, Math.round((r.thresholdM - g.gapM) * 100)));
});

test("rotated subject: report notes gaps are bounding-box based (EC9)", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  // Rotated bed with a neighbour close enough to produce a violation, so a
  // violation string (which carries the note) is emitted.
  const bed = tools.tool_place_symbol({ type: "bed", x: 3, y: 6, rot: 45 }).id;
  // Rotated 1.5×2.0 bed has an AABB bottom at ~y=7.24; place the desk so the
  // gap is under 60 cm (desk top ~30 cm below the bed's bbox bottom).
  tools.tool_place_symbol({ type: "desk", x: 3, y: 7.9 });
  const r = report(0.60, bed);
  assert.ok(r.items[0]);
  assert.ok(Number.isFinite(r.items[0].center.x));
  // EC9: the violation must tell the agent the gap is bbox-based / conservative.
  assert.ok(r.violations.length >= 1, "rotated subject has a violation");
  assert.match(r.violations[0], /rotated|bounding box|conservative/i);
});

test("movable-neighbour flank is NOT false-boxed; names the neighbour to move (M6)", () => {
  // Bed flush to the top wall with a desk just below it, in a tall mostly-empty
  // 5×7 room. The old rule falsely declared the bed y-boxed and said "widen the
  // room"; M6 must instead leave it un-boxed and name the desk (which has room
  // behind it) as the piece to move.
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 7 } });
  const bed = tools.tool_place_symbol({ type: "bed", x: 2.5, y: 1.3 }).id; // box y 0.3..2.3
  tools.tool_place_symbol({ type: "desk", x: 2.5, y: 2.6 });               // just below, movable
  const r = report(0.60, bed);
  const item = r.items[0];
  assert.deepEqual(item.boxedInAxes, [], "bed must NOT be boxed — the desk can move");
  const v = r.violations.find((s) => /Bed/.test(s));
  assert.match(v, /move Desk away/i, "names the movable neighbour to reposition");
  assert.doesNotMatch(v, /widen the room|smaller pieces/i, "not a structural room-rebuild instruction");
});

test("feasible near-boundary two-sided axis converges (no oscillation)", () => {
  // Subject flanked on BOTH x sides by symbols with only ~0.5 mm total feasibility
  // slack (gapNeg+gapPos just over 2×threshold). A deficit-push with an outward
  // epsilon would overshoot and oscillate here forever; the window-clamped
  // reconciliation must converge. This is the regression for the PUSH_EPS_M bug.
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const subj = tools.tool_place_symbol({ type: "chair", x: 5.0065, y: 6 }).id;
  tools.tool_place_symbol({ type: "chair", x: 3.9005, y: 6 }); // -x flank
  tools.tool_place_symbol({ type: "chair", x: 6.101, y: 6 });  // +x flank
  let converged = -1;
  for (let i = 0; i < 12; i++) {
    const it = report(0.60, subj).items[0];
    if (it.worstStatus === "ok") { converged = i; break; }
    assert.ok(it.suggestedMove, "feasible axis must yield a move, not boxed-in");
    tools.tool_move_symbol({ id: subj, x: it.suggestedMove.toX, y: it.suggestedMove.toY });
  }
  assert.ok(converged >= 0, "converged without oscillating");
});

test("containment: subject centre outside the room reads bad, not ok", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 3, h: 4 } });
  // Bed placed far outside the room — no wall gaps are computed for it.
  const bed = tools.tool_place_symbol({ type: "bed", x: 20, y: 20 }).id;
  const r = report(0.60, bed);
  const item = r.items[0];
  assert.equal(item.worstStatus, "bad");
  assert.equal(item.outsideRoom, true);
  assert.equal(r.satisfied, false);
  // suggestedMove pulls it back toward the room interior (centroid ~1.5,2.0).
  assert.ok(item.suggestedMove, "has an inward suggestedMove");
  assert.ok(item.suggestedMove.toX > 0 && item.suggestedMove.toX < 3);
  assert.ok(item.suggestedMove.toY > 0 && item.suggestedMove.toY < 4);
  assert.match(r.violations[0], /outside the room/);
});

test("containment: wall-overlap suggestedMove pushes INTO the room, not out", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 3, h: 4 } });
  // Bed (h=2) at y=0.8 → top edge at y=-0.2, poking through the TOP wall.
  const bed = tools.tool_place_symbol({ type: "bed", x: 1.5, y: 0.8 }).id;
  const r = report(0.60, bed);
  const item = r.items[0];
  assert.equal(item.worstStatus, "bad");
  // The escape must be DOWNWARD (+y, into the room), NOT up through the wall.
  assert.ok(item.suggestedMove, "overlapping-wall subject still gets a move");
  assert.ok(item.suggestedMove.toY > 0.8, "moves down into the room, not up out of it");
});

test("containment: applying suggestedMove converges to inside + satisfied", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 3, h: 4 } });
  const bed = tools.tool_place_symbol({ type: "bed", x: 1.5, y: 0.8 }).id;
  let converged = false;
  for (let i = 0; i < 8; i++) {
    const item = report(0.60, bed).items[0];
    if (item.worstStatus === "ok") { converged = true; break; }
    assert.ok(item.suggestedMove, "always offers a move until satisfied");
    tools.tool_move_symbol({ id: bed, x: item.suggestedMove.toX, y: item.suggestedMove.toY });
  }
  assert.ok(converged, "bed converges to a satisfied placement inside the room");
});

test("containment: concave (L-shaped) room — inward target is inside, converges", () => {
  session.newPlan();
  // L-shape whose vertex-average centroid (3,3) falls OUTSIDE the polygon, so
  // the naive centroid target would itself be outside. The interior-point
  // fallback must still hand back a point inside the room.
  tools.tool_add_room({ verts: [
    { x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 3 },
    { x: 3, y: 3 }, { x: 3, y: 6 }, { x: 0, y: 6 },
  ] });
  const room = wallsModel.rooms[0];
  assert.equal(pointInRoom(room, 3, 3), false, "premise: centroid is outside the L");
  // Chair placed in the cut-out notch → genuinely outside the room.
  const ch = tools.tool_place_symbol({ type: "chair", x: 4.5, y: 4.5 }).id;
  const it = report(0.60, ch).items[0];
  assert.equal(it.outsideRoom, true);
  assert.ok(it.suggestedMove, "offers an inward move");
  assert.equal(
    pointInRoom(room, it.suggestedMove.toX, it.suggestedMove.toY), true,
    "the suggested target is itself inside the room"
  );
  // Applying it must resolve the outside-room flag.
  let converged = false;
  for (let i = 0; i < 12; i++) {
    const item = report(0.60, ch).items[0];
    if (item.worstStatus === "ok") { converged = true; break; }
    if (!item.suggestedMove) break;
    tools.tool_move_symbol({ id: ch, x: item.suggestedMove.toX, y: item.suggestedMove.toY });
  }
  assert.ok(converged, "chair converges to a placement inside the concave room");
});

test("diagonal pair flagged diagonal:true", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  // Two chairs separated on BOTH axes.
  const a = tools.tool_place_symbol({ type: "chair", x: 3.0, y: 3.0 }).id; // box 2.75..3.25
  tools.tool_place_symbol({ type: "chair", x: 4.0, y: 4.2 }); // box 3.75..4.25 / 3.95..4.45
  const r = report(0.60, a);
  const g = r.items[0].gaps.find((x) => x.kind === "symbol");
  assert.equal(g.diagonal, true);
});
