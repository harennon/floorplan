/**
 * Unit — mutators & session (tools.js, session.js). LLD 32 + LLD 78 Test reqs.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as session from "../src/session.js";
import * as tools from "../src/tools.js";
import { wallsModel, symbolsModel, CATALOG, isRectangle, MIN_SEG_M } from "../src/core.js";

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
  // bed width max is max_w; request 9 → clamped to the width axis.
  const p = tools.tool_place_symbol({ type: "bed", x: 6, y: 6, w: 9 });
  assert.equal(p.ok, true);
  assert.equal(p.clamped, true);
  assert.equal(p.w, CATALOG.bed.max_w);

  const rz = tools.tool_resize_symbol({ id: p.id, dim: "w", metres: 0.01 }); // below min_w
  assert.equal(rz.clamped, true);
  assert.equal(rz.w, CATALOG.bed.min_w);
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
  assert.equal(p.w, CATALOG.parasol.max_w);
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

// ── resize_room (LLD 78) ─────────────────────────────────────────────────────

test("resize_room: resizes a rectangle to exact w×h non-destructively", () => {
  session.newPlan();
  const { roomId } = tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  const r = tools.tool_resize_room({ roomId, w: 5, h: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.roomId, roomId);
  assert.ok(Math.abs(r.newMetrics.area - 35) < 1e-6, "area should be 35 m²");
  const room = wallsModel.rooms[0];
  assert.equal(room.verts.length, 4);
  assert.equal(room.closed, true);
  assert.ok(isRectangle(room), "room should still be a rectangle after resize");
  // The origin corner v0 = (0,0) should be unchanged (anchor corner).
  assert.ok(Math.abs(room.verts[0].x - 0) < 1e-9);
  assert.ok(Math.abs(room.verts[0].y - 0) < 1e-9);
});

test("resize_room: furniture placed after resize is unaffected (no rebuild needed)", () => {
  session.newPlan();
  const { roomId } = tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  // Place a symbol inside the room.
  const sym = tools.tool_place_symbol({ type: "bed", x: 2, y: 2 });
  assert.equal(sym.ok, true);
  const bedId = sym.id;
  const bedX = symbolsModel.symbols[0].x;
  const bedY = symbolsModel.symbols[0].y;
  // Resize the room — the symbol should be unaffected (resize does not touch symbols).
  const r = tools.tool_resize_room({ roomId, w: 5, h: 7 });
  assert.equal(r.ok, true);
  // Symbol still exists at its original coordinates (no rebuild).
  const bed = symbolsModel.symbols.find((s) => s.id === bedId);
  assert.ok(bed, "bed symbol must still exist after resize");
  assert.equal(bed.x, bedX);
  assert.equal(bed.y, bedY);
});

test("resize_room: non-rectangle rejected with clear reason, no mutation", () => {
  session.newPlan();
  // Triangle — not a rectangle.
  const { roomId } = tools.tool_add_room({ verts: [
    { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 },
  ] });
  const vertsBefore = wallsModel.rooms[0].verts.map((v) => ({ x: v.x, y: v.y }));
  const r = tools.tool_resize_room({ roomId, w: 5, h: 7 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /rectangular/);
  // Verts unchanged.
  const vertsAfter = wallsModel.rooms[0].verts.map((v) => ({ x: v.x, y: v.y }));
  assert.deepEqual(vertsAfter, vertsBefore);
});

test("resize_room: w or h below MIN_SEG_M rejected, no partial resize", () => {
  session.newPlan();
  const { roomId } = tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  const v0Before = { x: wallsModel.rooms[0].verts[0].x, y: wallsModel.rooms[0].verts[0].y };
  const v1Before = { x: wallsModel.rooms[0].verts[1].x, y: wallsModel.rooms[0].verts[1].y };
  // h is way below MIN_SEG_M — should be rejected without even applying w.
  const r = tools.tool_resize_room({ roomId, w: 5, h: MIN_SEG_M / 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /≥/);
  // Edge 0 must NOT have been applied (room is unchanged).
  assert.ok(Math.abs(wallsModel.rooms[0].verts[0].x - v0Before.x) < 1e-9);
  assert.ok(Math.abs(wallsModel.rooms[0].verts[1].x - v1Before.x) < 1e-9);
});

test("resize_room: NaN / zero / negative w or h rejected without throwing", () => {
  session.newPlan();
  const { roomId } = tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  assert.equal(tools.tool_resize_room({ roomId, w: NaN, h: 5 }).ok, false);
  assert.equal(tools.tool_resize_room({ roomId, w: 5, h: NaN }).ok, false);
  assert.equal(tools.tool_resize_room({ roomId, w: 0, h: 5 }).ok, false);
  assert.equal(tools.tool_resize_room({ roomId, w: -1, h: 5 }).ok, false);
  // Room still intact.
  assert.equal(wallsModel.rooms.length, 1);
});

test("resize_room: unknown roomId → {ok:false}", () => {
  session.newPlan();
  const r = tools.tool_resize_room({ roomId: "nope", w: 5, h: 7 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no such room/);
});

// ── move_room (LLD 78) ───────────────────────────────────────────────────────

test("move_room: rigid translate — every vert shifted by delta, area invariant", () => {
  session.newPlan();
  const { roomId } = tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 3 } });
  const areaBefore = tools.tool_get_metrics().rooms[0].areaM2;
  const r = tools.tool_move_room({ roomId, dx: 2, dy: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.roomId, roomId);
  const room = wallsModel.rooms[0];
  for (const v of room.verts) {
    // Each vert must have been shifted; the original room was axis-aligned at 0.
    // v0 was (0,0) → should be (2,3), etc.
    assert.ok(v.x >= 2 - 1e-9 && v.x <= 7 + 1e-9, `v.x=${v.x} out of expected range`);
    assert.ok(v.y >= 3 - 1e-9 && v.y <= 6 + 1e-9, `v.y=${v.y} out of expected range`);
  }
  // Verify exact v0 shift (0,0) → (2,3).
  assert.ok(Math.abs(room.verts[0].x - 2) < 1e-9);
  assert.ok(Math.abs(room.verts[0].y - 3) < 1e-9);
  // Area must be invariant.
  const areaAfter = r.metrics.area;
  assert.ok(Math.abs(areaAfter - areaBefore) < 1e-6);
});

test("move_room: carries contained furniture", () => {
  session.newPlan();
  const { roomId } = tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 5 } });
  // Place a bed at room center.
  const bed = tools.tool_place_symbol({ type: "bed", x: 2.5, y: 2.5 });
  assert.equal(bed.ok, true);
  const bedId = bed.id;
  const r = tools.tool_move_room({ roomId, dx: 1, dy: 2 });
  assert.equal(r.ok, true);
  assert.ok(r.carried.includes(bedId), "bed should be in carried list");
  const bedSym = symbolsModel.symbols.find((s) => s.id === bedId);
  assert.ok(Math.abs(bedSym.x - 3.5) < 1e-9, `bed.x expected 3.5, got ${bedSym.x}`);
  assert.ok(Math.abs(bedSym.y - 4.5) < 1e-9, `bed.y expected 4.5, got ${bedSym.y}`);
});

test("move_room: does NOT carry furniture outside the room", () => {
  session.newPlan();
  const { roomId } = tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 5 } });
  // Place a second room so we have somewhere to put the outside furniture.
  tools.tool_add_room({ rect: { x: 10, y: 0, w: 5, h: 5 } });
  // Place furniture well outside the first room.
  const bed = tools.tool_place_symbol({ type: "bed", x: 12, y: 2 });
  assert.equal(bed.ok, true);
  const bedId = bed.id;
  const r = tools.tool_move_room({ roomId, dx: 1, dy: 1 });
  assert.equal(r.ok, true);
  assert.ok(!r.carried.includes(bedId), "outside furniture must not be carried");
  // Verify position unchanged.
  const bedSym = symbolsModel.symbols.find((s) => s.id === bedId);
  assert.equal(bedSym.x, 12);
  assert.equal(bedSym.y, 2);
});

test("move_room: carries the room's own door/window (opening on room wall)", () => {
  session.newPlan();
  const { roomId } = tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  // Place door on the top wall centerline (y=0).
  const door = tools.tool_place_symbol({ type: "door", x: 2, y: 0 });
  assert.equal(door.ok, true);
  const doorId = door.id;
  const doorSym = symbolsModel.symbols.find((s) => s.id === doorId);
  const origX = doorSym.x, origY = doorSym.y;
  const r = tools.tool_move_room({ roomId, dx: 3, dy: 2 });
  assert.equal(r.ok, true);
  assert.ok(r.carried.includes(doorId), "door should be in carried list");
  // Door must have moved with the room.
  assert.ok(Math.abs(doorSym.x - (origX + 3)) < 1e-9);
  assert.ok(Math.abs(doorSym.y - (origY + 2)) < 1e-9);
});

test("move_room: dx===0, dy===0 is no-op safe, carried still returned", () => {
  session.newPlan();
  const { roomId } = tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 5 } });
  const bed = tools.tool_place_symbol({ type: "bed", x: 2.5, y: 2.5 });
  const vertsBefore = wallsModel.rooms[0].verts.map((v) => ({ x: v.x, y: v.y }));
  const r = tools.tool_move_room({ roomId, dx: 0, dy: 0 });
  assert.equal(r.ok, true);
  // Verts unchanged.
  const vertsAfter = wallsModel.rooms[0].verts.map((v) => ({ x: v.x, y: v.y }));
  assert.deepEqual(vertsAfter, vertsBefore);
  // Bed position unchanged.
  const bedSym = symbolsModel.symbols.find((s) => s.id === bed.id);
  assert.equal(bedSym.x, 2.5);
  assert.equal(bedSym.y, 2.5);
  // Carry set still populated.
  assert.ok(Array.isArray(r.carried));
});

test("move_room: unknown roomId → {ok:false}, no mutation", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  const vertsBefore = wallsModel.rooms[0].verts.map((v) => ({ x: v.x, y: v.y }));
  const r = tools.tool_move_room({ roomId: "nope", dx: 1, dy: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no such room/);
  const vertsAfter = wallsModel.rooms[0].verts.map((v) => ({ x: v.x, y: v.y }));
  assert.deepEqual(vertsAfter, vertsBefore);
});

test("move_room: non-finite dx/dy → {ok:false}, no mutation", () => {
  session.newPlan();
  const { roomId } = tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  const r1 = tools.tool_move_room({ roomId, dx: NaN, dy: 1 });
  assert.equal(r1.ok, false);
  const r2 = tools.tool_move_room({ roomId, dx: 1, dy: Infinity });
  assert.equal(r2.ok, false);
  // Room verts unchanged.
  assert.ok(Math.abs(wallsModel.rooms[0].verts[0].x) < 1e-9);
});

// ── check_brief guidance (LLD 78) ────────────────────────────────────────────

test("check_brief: wrong-size room unmet message now references resize_room", () => {
  tools.tool_set_brief({ room: { w: 5, h: 7 } });
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } }); // wrong size
  const r = tools.tool_check_brief();
  assert.equal(r.satisfied, false);
  const msg = r.unmet.find((u) => /resize_room/.test(u));
  assert.ok(msg, `unmet message must mention resize_room; got: ${JSON.stringify(r.unmet)}`);
});

test("check_brief: no-room-drawn message references add_room (not resize_room)", () => {
  tools.tool_set_brief({ room: { w: 5, h: 7 } });
  session.newPlan();
  // No room drawn.
  const r = tools.tool_check_brief();
  assert.equal(r.satisfied, false);
  const msg = r.unmet[0];
  assert.match(msg, /add_room/);
  // Must not suggest resize_room when there is nothing to resize.
  assert.doesNotMatch(msg, /resize_room/);
});

// ── LLD 88: dining-table-round circularity enforcement (MCP integration) ─────

test("LLD 88: resize_symbol dim:'h' on dining-table-round returns w===h and changed:true", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const placed = tools.tool_place_symbol({ type: "dining-table-round", x: 6, y: 6 });
  assert.equal(placed.ok, true);
  // Default is w=h=1.20; resize h to a different value — both axes must mirror.
  const rz = tools.tool_resize_symbol({ id: placed.id, dim: "h", metres: 1.50 });
  assert.equal(rz.ok, true);
  assert.equal(rz.changed, true);
  assert.ok(Math.abs(rz.w - 1.50) < 1e-9, `w expected 1.50, got ${rz.w}`);
  assert.ok(Math.abs(rz.h - 1.50) < 1e-9, `h expected 1.50, got ${rz.h}`);
  assert.equal(rz.w, rz.h);
});

test("LLD 88: place_symbol dining-table-round with differing w/h ends with w===h (last axis wins, Edge Case 5)", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  // Provide both w and h — the last-applied axis (h) wins due to sequential resizeSymbol calls.
  const placed = tools.tool_place_symbol({ type: "dining-table-round", x: 6, y: 6, w: 1.00, h: 1.50 });
  assert.equal(placed.ok, true);
  assert.equal(placed.w, placed.h, `w (${placed.w}) and h (${placed.h}) must be equal`);
});

// ── LLD 95: place_symbol preset param ────────────────────────────────────────

test("LLD 95: place_symbol with preset:'Queen' places bed at 1.52×2.03 m", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const placed = tools.tool_place_symbol({ type: "bed", x: 6, y: 6, preset: "Queen" });
  assert.equal(placed.ok, true);
  assert.ok(Math.abs(placed.w - 1.52) < 1e-9, `w expected 1.52, got ${placed.w}`);
  assert.ok(Math.abs(placed.h - 2.03) < 1e-9, `h expected 2.03, got ${placed.h}`);
  assert.equal(placed.presetApplied, "Queen");
});

test("LLD 95: place_symbol unknown preset name → ok:false with valid names listed, nothing placed", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const countBefore = symbolsModel.symbols.length;
  const r = tools.tool_place_symbol({ type: "bed", x: 6, y: 6, preset: "Emperor" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown preset/);
  assert.match(r.reason, /Queen/); // valid names listed
  assert.equal(symbolsModel.symbols.length, countBefore);
});

test("LLD 95: place_symbol preset on type with no presets → ok:false, nothing placed", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const countBefore = symbolsModel.symbols.length;
  const r = tools.tool_place_symbol({ type: "chair", x: 5, y: 5, preset: "Armchair" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown preset/);
  assert.equal(symbolsModel.symbols.length, countBefore);
});

test("LLD 95: explicit w overrides preset per-axis (sofa preset:'3-seat', w:2.4 → w===2.4, h===0.95)", () => {
  // Use a non-discrete (free-resize) type: for discrete types (bed/fridge/stove/washer)
  // LLD 99 hard-snaps both axes to a standard preset pair, so per-axis override cannot
  // hold there. sofa resizes freely, so the explicit w survives while the preset's h stays.
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const placed = tools.tool_place_symbol({ type: "sofa", x: 6, y: 6, preset: "3-seat", w: 2.4 });
  assert.equal(placed.ok, true);
  assert.ok(Math.abs(placed.w - 2.4) < 1e-9, `w expected 2.4, got ${placed.w}`);
  assert.ok(Math.abs(placed.h - 0.95) < 1e-9, `h expected 0.95, got ${placed.h}`);
});

test("LLD 95: preset on opening resolves width, then on-wall guard still fires for off-wall position", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  // Place door at room center — off-wall, should be rejected even with a valid preset
  const r = tools.tool_place_symbol({ type: "door", x: 2, y: 2, preset: "Standard 32\"" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /must sit on a wall/);
  assert.equal(symbolsModel.symbols.length, 0);
});

test("LLD 95: preset on opening with on-wall position → accepted, width resolved", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 4 } });
  // Place door on top wall centerline
  const r = tools.tool_place_symbol({ type: "door", x: 2, y: 0, preset: "Standard 32\"" });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.w - 0.81) < 1e-9, `w expected 0.81 (Standard 32"), got ${r.w}`);
  assert.equal(r.presetApplied, "Standard 32\"");
});

test("LLD 95: place_symbol without preset behaves exactly as before (regression)", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const placed = tools.tool_place_symbol({ type: "bed", x: 6, y: 6 });
  assert.equal(placed.ok, true);
  assert.equal(placed.w, CATALOG.bed.w);
  assert.equal(placed.h, CATALOG.bed.h);
  assert.equal(placed.presetApplied, undefined);
});

test("LLD 95: preset with circular type (dining-table-round) sets w===h", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const placed = tools.tool_place_symbol({ type: "dining-table-round", x: 6, y: 6, preset: "Seats 4" });
  assert.equal(placed.ok, true);
  assert.ok(Math.abs(placed.w - 1.00) < 1e-9, `w expected 1.00, got ${placed.w}`);
  assert.ok(Math.abs(placed.h - 1.00) < 1e-9, `h expected 1.00, got ${placed.h}`);
  assert.equal(placed.presetApplied, "Seats 4");
});

test("LLD 95: preset is non-string → ok:false with clear reason, nothing placed", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const countBefore = symbolsModel.symbols.length;
  const r = tools.tool_place_symbol({ type: "bed", x: 6, y: 6, preset: 42 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /preset must be a string/);
  assert.equal(symbolsModel.symbols.length, countBefore);
});

// ── LLD 99: discrete furniture snap ──────────────────────────────────────────

test("LLD 99: tool_resize_symbol on a bed with between-size width snaps to a mattress preset and returns snapped:true clamped:false", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  // Place a default Queen bed (1.52 × 2.03).
  const placed = tools.tool_place_symbol({ type: "bed", x: 6, y: 6 });
  assert.equal(placed.ok, true);
  assert.ok(Math.abs(placed.w - 1.52) < 1e-9, `default Queen w expected 1.52, got ${placed.w}`);
  assert.ok(Math.abs(placed.h - 2.03) < 1e-9, `default Queen h expected 2.03, got ${placed.h}`);

  // Resize width to 1.20 m (between Full 1.37 and Twin 0.97).
  // Candidate (1.20, 2.03) snaps to Full (1.37, 1.91) under the raw metric (LLD step 2).
  const rz = tools.tool_resize_symbol({ id: placed.id, dim: "w", metres: 1.20 });
  assert.equal(rz.ok, true);
  assert.ok(Math.abs(rz.w - 1.37) < 1e-9, `w expected 1.37 (Full), got ${rz.w}`);
  assert.ok(Math.abs(rz.h - 1.91) < 1e-9, `h expected 1.91 (Full), got ${rz.h}`);
  assert.equal(rz.clamped, false, "1.20 is within bed's [min_w,max_w], so clamped must be false");
  assert.equal(rz.snapped, true, "snap changed the dims, so snapped must be true");

  // Result must equal a bed preset exactly.
  const preset = CATALOG.bed.presets.find((p) => Math.abs(p.w - rz.w) < 1e-9 && Math.abs(p.h - rz.h) < 1e-9);
  assert.ok(preset, `result (${rz.w}, ${rz.h}) must equal a bed catalog preset`);
});

test("LLD 99: tool_place_symbol on a discrete appliance with between-rung width snaps to a standard size", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  // Fridge width 0.70 is between 30\" (0.76) and 24\" compact (0.61).
  const placed = tools.tool_place_symbol({ type: "fridge", x: 3, y: 3, w: 0.70 });
  assert.equal(placed.ok, true);
  // 0.70 is in [min_w,max_w] = [0.55, 0.91] so not clamped; candidate (0.70, 0.81).
  // Distance to 24\" (0.61,0.81): (0.09)²=0.0081, distance to 30\" (0.76,0.81): (0.06)²=0.0036. Snaps to 30\".
  assert.ok(Math.abs(placed.w - 0.76) < 1e-9, `expected 30\" fridge (0.76), got ${placed.w}`);
  const preset = CATALOG.fridge.presets.find((p) => Math.abs(p.w - placed.w) < 1e-9 && Math.abs(p.h - placed.h) < 1e-9);
  assert.ok(preset, `fridge result (${placed.w}, ${placed.h}) must match a catalog preset`);
  assert.equal(placed.snapped, true);
});

test("LLD 99: tool_resize_symbol on a non-discrete type (sofa) still returns the clamped, un-snapped value", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const placed = tools.tool_place_symbol({ type: "sofa", x: 6, y: 6 });
  assert.equal(placed.ok, true);
  // Resize to 2.30 m (in-range for sofa, between loveseat 1.65 and 3-seat 2.10 presets).
  const rz = tools.tool_resize_symbol({ id: placed.id, dim: "w", metres: 2.30 });
  assert.equal(rz.ok, true);
  // Must stay at exactly 2.30 (no snap).
  assert.ok(Math.abs(rz.w - 2.30) < 1e-9, `sofa w expected 2.30 (un-snapped), got ${rz.w}`);
  // snapped field must not be present (or falsy) for non-discrete types.
  assert.ok(!rz.snapped, "non-discrete type must not have snapped:true");
});

test("LLD 99: tool_resize_symbol on an already-preset-aligned bed returns snapped:false (no change from snap)", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 12, h: 12 } });
  const placed = tools.tool_place_symbol({ type: "bed", x: 6, y: 6 });
  // Resize width to exactly Queen 1.52 (already a preset).
  const rz = tools.tool_resize_symbol({ id: placed.id, dim: "w", metres: 1.52 });
  assert.equal(rz.ok, true);
  assert.ok(Math.abs(rz.w - 1.52) < 1e-9);
  assert.ok(Math.abs(rz.h - 2.03) < 1e-9);
  // Snap did not change anything beyond clamp, so snapped must be false.
  assert.equal(rz.snapped, false);
});
