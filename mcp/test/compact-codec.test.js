/**
 * MCP integration — compact 'c' codec smoke test (LLD 77).
 *
 * Verifies that tool_get_share_url emits a 'c' codec hash and that
 * decodeHashToPlan reconstructs the same plan geometry the session held.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as session from "../src/session.js";
import * as tools from "../src/tools.js";
import { wallsModel, symbolsModel, decodeHashToPlan } from "../src/core.js";

const SHARE_BASE = "https://floorplan.danbing.app/#";

beforeEach(() => session.resetAll());

test("tool_get_share_url returns a URL whose hash starts with 'c' (compact codec)", async () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 4 } });
  const r = await tools.tool_get_share_url();
  assert.ok(r.url.startsWith(SHARE_BASE), "URL must use share base");
  const hash = r.url.slice(SHARE_BASE.length);
  assert.equal(hash[0], "c", `Expected 'c' codec prefix, got '${hash[0]}'`);
});

test("tool_get_share_url: decoded 'c' hash reconstructs the same plan geometry", async () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 3, h: 4 } });
  tools.tool_place_symbol({ type: "sofa", x: 1.5, y: 2 });

  // Snapshot before encode
  const roomsBefore = JSON.parse(JSON.stringify(wallsModel.rooms));
  const symsBefore = JSON.parse(JSON.stringify(symbolsModel.symbols));

  const r = await tools.tool_get_share_url();
  const hash = r.url.slice(SHARE_BASE.length);

  const decoded = await decodeHashToPlan(hash);
  assert.ok(decoded !== null, "decodeHashToPlan returned null for 'c' hash");

  // Room count and geometry match
  assert.equal(decoded.walls.rooms.length, roomsBefore.length, "room count mismatch");
  for (let i = 0; i < roomsBefore.length; i++) {
    const ra = roomsBefore[i].verts;
    const rb = decoded.walls.rooms[i].verts;
    assert.equal(rb.length, ra.length, `room ${i} vert count mismatch`);
    for (let j = 0; j < ra.length; j++) {
      assert.equal(rb[j].x, ra[j].x, `room ${i} vert ${j} x mismatch`);
      assert.equal(rb[j].y, ra[j].y, `room ${i} vert ${j} y mismatch`);
    }
  }

  // Symbol count and type/position match
  assert.equal(decoded.symbols.symbols.length, symsBefore.length, "symbol count mismatch");
  for (let i = 0; i < symsBefore.length; i++) {
    const sa = symsBefore[i];
    const sb = decoded.symbols.symbols[i];
    assert.equal(sb.type, sa.type, `sym ${i} type mismatch`);
    assert.equal(sb.x, sa.x, `sym ${i} x mismatch`);
    assert.equal(sb.y, sa.y, `sym ${i} y mismatch`);
  }
});
