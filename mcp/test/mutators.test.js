/**
 * Unit — mutators & session (tools.js, session.js). LLD 32 Test reqs.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as session from "../src/session.js";
import * as tools from "../src/tools.js";
import { wallsModel, symbolsModel, CATALOG } from "../src/core.js";

beforeEach(() => session.resetAll());

test("add_room {rect} builds a closed 4-vert room with area = w*h", () => {
  session.newPlan();
  const r = tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 7 } });
  assert.equal(r.ok, true);
  assert.equal(r.metrics.area, 35);
  const room = wallsModel.rooms[0];
  assert.equal(room.closed, true);
  assert.equal(room.verts.length, 4);
});

test("add_room with < 3 verts is rejected without throwing", () => {
  session.newPlan();
  const r = tools.tool_add_room({ verts: [{ x: 0, y: 0 }, { x: 1, y: 0 }] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /at least 3 corners/);
  assert.equal(wallsModel.rooms.length, 0);
});

test("add_room with 3+ collinear verts is rejected, no sliver persisted (EC5)", () => {
  session.newPlan();
  // Three collinear points on the x-axis: area === 0 exactly (shoelace = 0).
  const r = tools.tool_add_room({ verts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /non-collinear/);
  // No sliver room must remain in the model.
  assert.equal(wallsModel.rooms.length, 0);
});

test("add_room collinear reject: 4+ collinear verts also rejected (EC5)", () => {
  session.newPlan();
  const r = tools.tool_add_room({ verts: [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 },
  ] });
  assert.equal(r.ok, false);
  assert.equal(wallsModel.rooms.length, 0);
});

test("add_room accepts a non-rectangular but nonzero-area polygon (EC5 regression)", () => {
  session.newPlan();
  // L-shape triangle: clearly nonzero area.
  const r = tools.tool_add_room({ verts: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 4 }] });
  assert.equal(r.ok, true);
  assert.ok(r.metrics.area > 0);
  assert.equal(wallsModel.rooms.length, 1);
});

test("set_edge_length hits the exact target; bad index / degenerate → {ok:false}", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 7 } });
  const roomId = wallsModel.rooms[0].id;
  const ok = tools.tool_set_edge_length({ roomId, edgeIndex: 0, lengthM: 6 });
  assert.equal(ok.ok, true);
  // edge 0 was verts[0]→verts[1] (length 5) → now 6.
  const room = wallsModel.rooms[0];
  const e = Math.hypot(room.verts[1].x - room.verts[0].x, room.verts[1].y - room.verts[0].y);
  assert.ok(Math.abs(e - 6) < 1e-9);

  const bad = tools.tool_set_edge_length({ roomId, edgeIndex: 99, lengthM: 3 });
  assert.equal(bad.ok, false);
  const noRoom = tools.tool_set_edge_length({ roomId: "nope", edgeIndex: 0, lengthM: 3 });
  assert.equal(noRoom.ok, false);
});

test("place_symbol / resize_symbol clamp out-of-range dims and report clamped:true", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  // bed max is 2.5; request 9 → clamped.
  const p = tools.tool_place_symbol({ type: "bed", x: 6, y: 6, w: 9 });
  assert.equal(p.ok, true);
  assert.equal(p.clamped, true);
  assert.equal(p.w, CATALOG.bed.max);

  const rz = tools.tool_resize_symbol({ id: p.id, dim: "w", metres: 0.01 }); // below min
  assert.equal(rz.clamped, true);
  assert.equal(rz.w, CATALOG.bed.min);
});

test("place_symbol on an opening ignores h and flags hIgnored", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  // Place door on the top wall centerline (y=0) so Gap B passes.
  const p = tools.tool_place_symbol({ type: "door", x: 3, y: 0, h: 1.5 });
  assert.equal(p.ok, true);
  assert.equal(p.hIgnored, true);
  assert.equal(p.h, CATALOG.door.h); // unchanged catalog depth
});

test("mutators reject non-finite coordinates without throwing", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const p = tools.tool_place_symbol({ type: "bed", x: NaN, y: 3 });
  assert.equal(p.ok, false);
  assert.equal(symbolsModel.symbols.length, 0);
});

test("unknown symbol type is rejected (createSymbol never throws through the tool)", () => {
  session.newPlan();
  const p = tools.tool_place_symbol({ type: "banana", x: 1, y: 1 });
  assert.equal(p.ok, false);
});

test("new_plan fully resets singletons (no stale geometry across briefs)", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 7 } });
  tools.tool_place_symbol({ type: "bed", x: 2, y: 2 });
  tools.tool_new_plan();
  assert.equal(wallsModel.rooms.length, 0);
  assert.equal(symbolsModel.symbols.length, 0);
});

test("load_plan with invalid doc → {ok:false}, singletons untouched", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 7 } });
  const before = wallsModel.rooms.length;
  const r = tools.tool_load_plan({ document: { not: "a plan" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid plan/);
  assert.equal(wallsModel.rooms.length, before); // untouched
});

test("load_plan with newer schema → distinct message, untouched", () => {
  session.newPlan();
  const r = tools.tool_load_plan({ document: {
    schema: 2, app: "floorplan", walls: { rooms: [], chain: [] },
    symbols: { symbols: [] }, view: { zoom: 1, panX: 0, panY: 0 }, unit: "m",
  } });
  assert.equal(r.ok, false);
  assert.match(r.error, /newer version/);
});

test("load_plan with a valid doc replaces contents", () => {
  session.newPlan();
  const doc = {
    schema: 1, app: "floorplan",
    walls: { rooms: [{ id: "w0", closed: true, verts: [
      { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 7 }, { x: 0, y: 7 } ] }], chain: [] },
    symbols: { symbols: [] }, view: { zoom: 1, panX: 0, panY: 0 }, unit: "m",
  };
  const r = tools.tool_load_plan({ document: doc });
  assert.equal(r.ok, true);
  assert.equal(wallsModel.rooms.length, 1);
});

test("set_brief rejects out-of-range walkway (M1, grounded range)", () => {
  const r = tools.tool_set_brief({ minWalkwayM: 2.0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /0.76–1.20/);
});

test("set_brief rejects a below-passage walkway (0.30 m is a furniture gap, not a walkway)", () => {
  const r = tools.tool_set_brief({ minWalkwayM: 0.30 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /0.76–1.20/);
});

test("set_brief defaults minWalkwayM to the grounded 0.915 m", () => {
  const r = tools.tool_set_brief({ room: { w: 3, h: 4 } });
  assert.equal(r.ok, true);
  assert.equal(r.brief.minWalkwayM, 0.915);
});

test("check_clearance rejects out-of-range walkway (M1, grounded range)", () => {
  session.newPlan();
  const r = tools.tool_check_clearance({ minWalkwayM: 0.1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /0.76–1.20/);
});

test("check_brief with no brief set is self-healing", () => {
  session.newPlan();
  const r = tools.tool_check_brief();
  assert.equal(r.satisfied, false);
  assert.match(r.unmet[0], /no brief set/);
});

// ── Gap A: single-room count guard ──────────────────────────────────────────

test("Gap A: second room under single-room brief rejected, no sliver persisted", () => {
  tools.tool_set_brief({ room: { w: 4, h: 4 } });
  session.newPlan();
  const r1 = tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  assert.equal(r1.ok, true);
  // Second room must be rejected.
  const r2 = tools.tool_add_room({ rect: { x: 5, y: 0, w: 4, h: 4 } });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /already has a room/);
  // No second room should have been persisted.
  assert.equal(wallsModel.rooms.length, 1);
});

test("Gap A: first room still accepted under single-room brief (regression)", () => {
  tools.tool_set_brief({ room: { w: 4, h: 4 } });
  session.newPlan();
  const r = tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  assert.equal(r.ok, true);
  assert.equal(wallsModel.rooms.length, 1);
});

test("Gap A: no brief → multi-room still allowed (regression)", () => {
  session.newPlan();
  const r1 = tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  const r2 = tools.tool_add_room({ rect: { x: 5, y: 0, w: 4, h: 4 } });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(wallsModel.rooms.length, 2);
});

test("Gap A: brief without room → multi-room still allowed (regression)", () => {
  tools.tool_set_brief({ minWalkwayM: 0.90 }); // brief with no room constraint
  session.newPlan();
  const r1 = tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  const r2 = tools.tool_add_room({ rect: { x: 5, y: 0, w: 4, h: 4 } });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(wallsModel.rooms.length, 2);
});

test("Gap A: rejected call is a no-op on state (rooms count unchanged)", () => {
  tools.tool_set_brief({ room: { w: 4, h: 4 } });
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  const countBefore = wallsModel.rooms.length;
  const chainBefore = wallsModel.chain.length;
  tools.tool_add_room({ rect: { x: 5, y: 0, w: 4, h: 4 } }); // rejected
  assert.equal(wallsModel.rooms.length, countBefore);
  assert.equal(wallsModel.chain.length, chainBefore);
});

// ── Gap B: opening-on-wall placement guard ───────────────────────────────────

test("Gap B: opening off-wall rejected, no symbol added", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  // Door placed at room center (2,2) — far from every wall.
  const r = tools.tool_place_symbol({ type: "door", x: 2, y: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /must sit on a wall/);
  assert.equal(symbolsModel.symbols.length, 0);
});

test("Gap B: opening on-wall accepted (centered on top wall)", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  // Top wall is at y=0 (centerline). Door default h=0.12 (WALL_M). Center at y=0 → on wall.
  const r = tools.tool_place_symbol({ type: "door", x: 2, y: 0 });
  assert.equal(r.ok, true);
  assert.equal(symbolsModel.symbols.length, 1);
});

test("Gap B: move_symbol opening off-wall → rejected + position restored", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  // Place door on top wall.
  const placed = tools.tool_place_symbol({ type: "door", x: 2, y: 0 });
  assert.equal(placed.ok, true);
  const doorId = placed.id;
  const originalX = symbolsModel.symbols[0].x;
  const originalY = symbolsModel.symbols[0].y;
  // Move to room center — should be rejected, position restored.
  const moved = tools.tool_move_symbol({ id: doorId, x: 2, y: 2 });
  assert.equal(moved.ok, false);
  assert.match(moved.reason, /must sit on a wall/);
  assert.equal(symbolsModel.symbols[0].x, originalX);
  assert.equal(symbolsModel.symbols[0].y, originalY);
});

test("Gap B: move_symbol opening to still-valid on-wall spot → accepted", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  const placed = tools.tool_place_symbol({ type: "door", x: 2, y: 0 });
  assert.equal(placed.ok, true);
  // Move along the top wall (still y=0).
  const moved = tools.tool_move_symbol({ id: placed.id, x: 1, y: 0 });
  assert.equal(moved.ok, true);
});

test("Gap B: furniture (non-opening) unaffected — place anywhere succeeds (regression)", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const p = tools.tool_place_symbol({ type: "bed", x: 6, y: 6 });
  assert.equal(p.ok, true);
  assert.equal(symbolsModel.symbols.length, 1);
});

test("Gap B: furniture move unaffected — move to any position succeeds (regression)", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const placed = tools.tool_place_symbol({ type: "sofa", x: 3, y: 3 });
  assert.equal(placed.ok, true);
  const moved = tools.tool_move_symbol({ id: placed.id, x: 6, y: 6 });
  assert.equal(moved.ok, true);
});

test("Gap B: no walls → opening rejected", () => {
  session.newPlan();
  // No room drawn at all.
  const r = tools.tool_place_symbol({ type: "window", x: 1, y: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /must sit on a wall/);
  assert.equal(symbolsModel.symbols.length, 0);
});

// ── LLD 76: outdoor / patio types ────────────────────────────────────────────

test("LLD 76: place_symbol({type:'parasol'}) returns ok:true with clamped dims", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const p = tools.tool_place_symbol({ type: "parasol", x: 5, y: 5 });
  assert.equal(p.ok, true);
  assert.equal(p.type, "parasol");
  assert.equal(p.w, CATALOG.parasol.w);
  assert.equal(p.h, CATALOG.parasol.h);
});

test("LLD 76: place_symbol({type:'parasol'}) out-of-range w clamps and reports clamped:true", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const p = tools.tool_place_symbol({ type: "parasol", x: 5, y: 5, w: 99 });
  assert.equal(p.ok, true);
  assert.equal(p.clamped, true);
  assert.equal(p.w, CATALOG.parasol.max);
});

test("LLD 76: place_symbol({type:'patio-table'}) returns ok:true at default dims", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const p = tools.tool_place_symbol({ type: "patio-table", x: 3, y: 3 });
  assert.equal(p.ok, true);
  assert.equal(p.type, "patio-table");
  assert.equal(p.w, CATALOG["patio-table"].w);
});

test("LLD 76: place_symbol({type:'patio-chair'}) returns ok:true", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const p = tools.tool_place_symbol({ type: "patio-chair", x: 4, y: 4 });
  assert.equal(p.ok, true);
  assert.equal(p.type, "patio-chair");
});

test("LLD 76: place_symbol({type:'planter'}) returns ok:true", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const p = tools.tool_place_symbol({ type: "planter", x: 2, y: 2 });
  assert.equal(p.ok, true);
  assert.equal(p.type, "planter");
});

test("LLD 76: bogus type still returns ok:false (rejection unaffected)", () => {
  session.newPlan();
  const p = tools.tool_place_symbol({ type: "patio-bench", x: 1, y: 1 });
  assert.equal(p.ok, false);
  assert.equal(p.reason, "unknown symbol type");
});
