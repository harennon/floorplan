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
  const p = tools.tool_place_symbol({ type: "door", x: 3, y: 3, h: 1.5 });
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

test("set_brief rejects out-of-range walkway (M1)", () => {
  const r = tools.tool_set_brief({ minWalkwayM: 2.0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /0.30–1.20/);
});

test("check_clearance rejects out-of-range walkway (M1)", () => {
  session.newPlan();
  const r = tools.tool_check_clearance({ minWalkwayM: 0.1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /0.30–1.20/);
});

test("check_brief with no brief set is self-healing", () => {
  session.newPlan();
  const r = tools.tool_check_brief();
  assert.equal(r.satisfied, false);
  assert.match(r.unmet[0], /no brief set/);
});
