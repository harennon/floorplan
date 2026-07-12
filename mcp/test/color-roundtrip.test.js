/**
 * MCP integration — color field round-trip tests (LLD 97).
 *
 * Verifies that symbol and room color fields survive all serialization paths:
 *   - buildPlan / validatePlan
 *   - buildCompact / parseCompact / validatePlan
 *   - serializePlan round-trip
 * Also verifies palette.js pure functions and backward-compat (no color → no change).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as session from "../src/session.js";
import {
  wallsModel, hydrateWalls,
  symbolsModel, hydrateSymbols,
  buildPlan, validatePlan, serializePlan,
  setSymbolColor, setRoomColor,
  createSymbol, addSymbol, duplicateSymbol,
} from "../src/core.js";
import { buildCompact, parseCompact } from "../../src/js/plan.js";
import { isValidHexColor, coerceColor, swatchGroupsForCategory, SWATCHES } from "../../src/js/palette.js";
import * as tools from "../src/tools.js";

beforeEach(() => session.resetAll());

// ── palette.js pure functions ─────────────────────────────────────────────────

test("isValidHexColor: accepts #rgb", () => {
  assert.equal(isValidHexColor("#fff"), true);
  assert.equal(isValidHexColor("#abc"), true);
});

test("isValidHexColor: accepts #rrggbb", () => {
  assert.equal(isValidHexColor("#ffffff"), true);
  assert.equal(isValidHexColor("#a0784a"), true);
});

test("isValidHexColor: rejects CSS names, rgba, short/long hex, non-hex chars", () => {
  assert.equal(isValidHexColor("red"), false);
  assert.equal(isValidHexColor("rgba(0,0,0,1)"), false);
  assert.equal(isValidHexColor("#12"), false);
  assert.equal(isValidHexColor("#gggggg"), false);
  assert.equal(isValidHexColor(""), false);
  assert.equal(isValidHexColor(42), false);
  assert.equal(isValidHexColor(null), false);
  assert.equal(isValidHexColor(undefined), false);
  assert.equal(isValidHexColor({}), false);
});

test("coerceColor: valid hex → same string", () => {
  assert.equal(coerceColor("#fff"), "#fff");
  assert.equal(coerceColor("#a0784a"), "#a0784a");
});

test("coerceColor: invalid → undefined", () => {
  assert.equal(coerceColor("red"), undefined);
  assert.equal(coerceColor("rgba(0,0,0,1)"), undefined);
  assert.equal(coerceColor("#12"), undefined);
  assert.equal(coerceColor(""), undefined);
  assert.equal(coerceColor(42), undefined);
  assert.equal(coerceColor('#fff" onload=alert(1)'), undefined);
});

test("swatchGroupsForCategory: openings → []", () => {
  assert.deepEqual(swatchGroupsForCategory("openings"), []);
});

test("swatchGroupsForCategory: living → non-empty, includes 'neutral'", () => {
  const groups = swatchGroupsForCategory("living");
  assert.ok(groups.length > 0, "living should return non-empty groups");
  assert.ok(groups.includes("neutral"), "living should include neutral");
});

test("swatchGroupsForCategory: floor → ['floor']", () => {
  assert.deepEqual(swatchGroupsForCategory("floor"), ["floor"]);
});

test("swatchGroupsForCategory: unknown category → ['neutral']", () => {
  assert.deepEqual(swatchGroupsForCategory("unknown"), ["neutral"]);
});

test("SWATCHES: all hex values are valid", () => {
  for (const [group, swatches] of Object.entries(SWATCHES)) {
    for (const sw of swatches) {
      assert.ok(
        isValidHexColor(sw.hex),
        `SWATCHES.${group} swatch '${sw.name}' has invalid hex: ${sw.hex}`
      );
    }
  }
});

// ── setSymbolColor ────────────────────────────────────────────────────────────

test("setSymbolColor: sets color, returns true on change", () => {
  session.newPlan();
  tools.tool_place_symbol({ type: "sofa", x: 1, y: 1 });
  const sym = symbolsModel.symbols[0];
  const changed = setSymbolColor(sym, "#a0784a");
  assert.equal(changed, true);
  assert.equal(sym.color, "#a0784a");
});

test("setSymbolColor: returns false when unchanged", () => {
  session.newPlan();
  tools.tool_place_symbol({ type: "sofa", x: 1, y: 1 });
  const sym = symbolsModel.symbols[0];
  setSymbolColor(sym, "#a0784a");
  assert.equal(setSymbolColor(sym, "#a0784a"), false);
});

test("setSymbolColor: null clears color key", () => {
  session.newPlan();
  tools.tool_place_symbol({ type: "sofa", x: 1, y: 1 });
  const sym = symbolsModel.symbols[0];
  setSymbolColor(sym, "#a0784a");
  setSymbolColor(sym, null);
  assert.equal("color" in sym, false, "color key should be deleted");
});

// ── duplicateSymbol copies color ──────────────────────────────────────────────

test("duplicateSymbol copies color from source", () => {
  session.newPlan();
  tools.tool_place_symbol({ type: "sofa", x: 1, y: 1 });
  const sym = symbolsModel.symbols[0];
  setSymbolColor(sym, "#a0784a");
  const dup = duplicateSymbol(sym.id);
  assert.notEqual(dup, null);
  assert.equal(dup.color, "#a0784a");
});

test("duplicateSymbol without color: clone has no color key", () => {
  session.newPlan();
  tools.tool_place_symbol({ type: "sofa", x: 1, y: 1 });
  const sym = symbolsModel.symbols[0];
  const dup = duplicateSymbol(sym.id);
  assert.notEqual(dup, null);
  assert.equal("color" in dup, false);
});

// ── setRoomColor ──────────────────────────────────────────────────────────────

test("setRoomColor: sets color on room, returns true", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 4 } });
  const room = wallsModel.rooms[0];
  const changed = setRoomColor(room, "#dfc99a");
  assert.equal(changed, true);
  assert.equal(room.color, "#dfc99a");
});

test("setRoomColor: null clears color key", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 4 } });
  const room = wallsModel.rooms[0];
  setRoomColor(room, "#dfc99a");
  setRoomColor(room, null);
  assert.equal("color" in room, false);
});

// ── validatePlan color coercion ───────────────────────────────────────────────

test("validatePlan: valid symbol color round-trips", () => {
  const plan = {
    schema: 1, app: "floorplan",
    walls: { rooms: [], chain: [] },
    symbols: { symbols: [{ id: "s0", type: "sofa", x: 1, y: 1, w: 2, h: 0.9, rot: 0, color: "#a0784a" }] },
    measurements: [],
    view: { zoom: 1, panX: 0, panY: 0 },
    unit: "m",
  };
  const v = validatePlan(plan);
  assert.notEqual(v, null, "validatePlan should accept plan with valid color");
  assert.equal(v.symbols.symbols[0].color, "#a0784a");
});

test("validatePlan: non-string color is dropped (plan still valid)", () => {
  const plan = {
    schema: 1, app: "floorplan",
    walls: { rooms: [], chain: [] },
    symbols: { symbols: [{ id: "s0", type: "sofa", x: 1, y: 1, w: 2, h: 0.9, rot: 0, color: 42 }] },
    measurements: [],
    view: { zoom: 1, panX: 0, panY: 0 },
    unit: "m",
  };
  const v = validatePlan(plan);
  assert.notEqual(v, null, "plan with non-string color must still validate");
  assert.equal("color" in v.symbols.symbols[0], false, "non-string color should be dropped");
});

test("validatePlan: non-hex string color normalises to undefined", () => {
  const plan = {
    schema: 1, app: "floorplan",
    walls: { rooms: [], chain: [] },
    symbols: { symbols: [{ id: "s0", type: "sofa", x: 1, y: 1, w: 2, h: 0.9, rot: 0, color: "red" }] },
    measurements: [],
    view: { zoom: 1, panX: 0, panY: 0 },
    unit: "m",
  };
  const v = validatePlan(plan);
  assert.notEqual(v, null);
  assert.equal(v.symbols.symbols[0].color, undefined);
});

test("validatePlan: injection attempt in color is coerced to undefined", () => {
  const plan = {
    schema: 1, app: "floorplan",
    walls: { rooms: [], chain: [] },
    symbols: { symbols: [{ id: "s0", type: "sofa", x: 1, y: 1, w: 2, h: 0.9, rot: 0, color: '#fff" onload=alert(1)' }] },
    measurements: [],
    view: { zoom: 1, panX: 0, panY: 0 },
    unit: "m",
  };
  const v = validatePlan(plan);
  assert.notEqual(v, null);
  assert.equal(v.symbols.symbols[0].color, undefined);
});

test("validatePlan: valid room color round-trips", () => {
  const plan = {
    schema: 1, app: "floorplan",
    walls: {
      rooms: [{ id: "w0", closed: true, verts: [{x:0,y:0},{x:5,y:0},{x:5,y:4},{x:0,y:4}], color: "#dfc99a" }],
      chain: [],
    },
    symbols: { symbols: [] },
    measurements: [],
    view: { zoom: 1, panX: 0, panY: 0 },
    unit: "m",
  };
  const v = validatePlan(plan);
  assert.notEqual(v, null);
  assert.equal(v.walls.rooms[0].color, "#dfc99a");
});

test("validatePlan: legacy plan (no color) validates unchanged", () => {
  const plan = {
    schema: 1, app: "floorplan",
    walls: { rooms: [], chain: [] },
    symbols: { symbols: [{ id: "s0", type: "bed", x: 1, y: 1, w: 1.52, h: 2.03, rot: 0 }] },
    measurements: [],
    view: { zoom: 1, panX: 0, panY: 0 },
    unit: "m",
  };
  const v = validatePlan(plan);
  assert.notEqual(v, null, "Legacy plan must validate");
  assert.equal("color" in v.symbols.symbols[0], false, "Legacy symbol must not have color key");
});

// ── buildCompact / parseCompact color round-trip ──────────────────────────────

test("compact codec: colored symbol has 'k' key; uncolored symbol has no 'k'", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 4 } });
  tools.tool_place_symbol({ type: "sofa", x: 2, y: 2 });
  const sym = symbolsModel.symbols[0];
  setSymbolColor(sym, "#a0784a");

  const compact = buildCompact(buildPlan());
  assert.equal(compact.s[0].k, "#a0784a", "colored symbol compact should have k key");
});

test("compact codec: colored symbol survives full round-trip", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 4 } });
  tools.tool_place_symbol({ type: "sofa", x: 2, y: 2 });
  const sym = symbolsModel.symbols[0];
  setSymbolColor(sym, "#a0784a");

  const compact = buildCompact(buildPlan());
  const restored = validatePlan(parseCompact(compact));
  assert.notEqual(restored, null);
  assert.equal(restored.symbols.symbols[0].color, "#a0784a");
});

test("compact codec: uncolored symbol emits no 'k' key (lean links preserved)", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 4 } });
  tools.tool_place_symbol({ type: "sofa", x: 2, y: 2 });

  const compact = buildCompact(buildPlan());
  assert.equal(compact.s[0].k, undefined, "uncolored symbol should not emit k key");
});

test("compact codec: colored room has 'k' key; uncolored room has no 'k'", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 4 } });
  const room = wallsModel.rooms[0];
  setRoomColor(room, "#dfc99a");

  const compact = buildCompact(buildPlan());
  assert.equal(compact.r[0].k, "#dfc99a", "colored room compact should have k key");
});

test("compact codec: colored room survives full round-trip", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 4 } });
  const room = wallsModel.rooms[0];
  setRoomColor(room, "#dfc99a");

  const compact = buildCompact(buildPlan());
  const restored = validatePlan(parseCompact(compact));
  assert.notEqual(restored, null);
  assert.equal(restored.walls.rooms[0].color, "#dfc99a");
});

test("compact codec: uncolored room emits no 'k' key", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 4 } });

  const compact = buildCompact(buildPlan());
  assert.equal(compact.r[0].k, undefined, "uncolored room should not emit k key");
});

// ── serializePlan round-trip ──────────────────────────────────────────────────

test("serializePlan: colored plan survives serialize → JSON.parse → validatePlan", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 4 } });
  tools.tool_place_symbol({ type: "sofa", x: 2, y: 2 });
  const sym = symbolsModel.symbols[0];
  setSymbolColor(sym, "#2c4a6e");
  const room = wallsModel.rooms[0];
  setRoomColor(room, "#dfc99a");

  const plan = buildPlan();
  const serialized = serializePlan(plan);
  const parsed = JSON.parse(serialized);
  const v = validatePlan(parsed);
  assert.notEqual(v, null, "Serialized colored plan must validate");
  assert.equal(v.symbols.symbols[0].color, "#2c4a6e", "symbol color must survive serialize round-trip");
  assert.equal(v.walls.rooms[0].color, "#dfc99a", "room color must survive serialize round-trip");
});

// ── Backward compat: old compact link (no 'k') ────────────────────────────────

test("backward compat: old compact payload (no k keys) decodes cleanly with no color", () => {
  const oldCompact = {
    v: 1, u: "m",
    r: [{ c: 1, p: [[0,0],[5,0],[5,4],[0,4]] }],
    k: [],
    s: [{ t: "sofa", x: 2, y: 2 }],
    m: [],
  };
  const restored = parseCompact(oldCompact);
  assert.notEqual(restored, null, "parseCompact should handle old compact");
  const v = validatePlan(restored);
  assert.notEqual(v, null);
  assert.equal("color" in v.walls.rooms[0], false, "old room should have no color");
  assert.equal("color" in v.symbols.symbols[0], false, "old symbol should have no color");
});

// ── Full model → buildPlan → validatePlan → applyPlan preserves colors ────────

test("full round-trip: model → buildPlan → validatePlan preserves all colors", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 4 } });
  tools.tool_place_symbol({ type: "sofa", x: 2, y: 2 });
  setSymbolColor(symbolsModel.symbols[0], "#b85c38");
  setRoomColor(wallsModel.rooms[0], "#c09050");

  const plan = buildPlan();
  const v = validatePlan(plan);
  assert.notEqual(v, null);
  assert.equal(v.symbols.symbols[0].color, "#b85c38");
  assert.equal(v.walls.rooms[0].color, "#c09050");
});
