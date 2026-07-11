/**
 * MCP integration — measurements model round-trip tests (LLD 81).
 *
 * Verifies that the measurements collection survives all serialization paths
 * reachable from the MCP server: applyPlan/buildPlan, share hash, and JSON
 * import/export. Also verifies the measurements re-export from core.js.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as session from "../src/session.js";
import { measurementsModel, hydrateMeasurements, buildPlan, validatePlan, serializePlan } from "../src/core.js";
import { buildCompact, parseCompact } from "../../src/js/plan.js";
import * as tools from "../src/tools.js";

beforeEach(() => session.resetAll());

// ── core.js re-export smoke ───────────────────────────────────────────────────

test("core.js re-exports measurementsModel and hydrateMeasurements", () => {
  assert.ok(measurementsModel, "measurementsModel must be exported");
  assert.ok(Array.isArray(measurementsModel.measurements), "measurementsModel.measurements must be an array");
  assert.equal(typeof hydrateMeasurements, "function", "hydrateMeasurements must be a function");
});

// ── resetAll clears measurements ──────────────────────────────────────────────

test("session.resetAll clears measurements model", () => {
  // Inject a measurement directly
  hydrateMeasurements({ measurements: [
    { id: "m0", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } },
  ] });
  assert.equal(measurementsModel.measurements.length, 1, "should have injected measurement");

  session.resetAll();
  assert.equal(measurementsModel.measurements.length, 0, "measurements must be cleared after resetAll");
});

// ── emptyPlan includes measurements: [] ──────────────────────────────────────

test("session.emptyPlan() includes measurements:[]", () => {
  const doc = session.emptyPlan();
  assert.ok("measurements" in doc, "emptyPlan must include measurements key");
  assert.deepEqual(doc.measurements, []);
});

// ── validatePlan backward-compat: plan without measurements key normalises to [] ─

test("validatePlan: plan without measurements key normalises to [] (backward compat)", () => {
  const legacyPlan = {
    schema: 1,
    app: "floorplan",
    walls: { rooms: [], chain: [] },
    symbols: { symbols: [] },
    view: { zoom: 1, panX: 0, panY: 0 },
    unit: "m",
  };
  const v = validatePlan(legacyPlan);
  assert.notEqual(v, null, "validatePlan must NOT return null for missing measurements");
  assert.deepEqual(v.measurements, [], "measurements must normalise to []");
});

// ── buildPlan/applyPlan round-trip preserves measurements ─────────────────────

test("buildPlan/applyPlan round-trip preserves measurements", () => {
  session.newPlan();
  // Inject measurements directly into the model
  hydrateMeasurements({ measurements: [
    { id: "m0", a: { x: 0, y: 0 }, b: { x: 3, y: 4 } },
  ] });

  const snapshot = buildPlan();
  assert.equal(snapshot.measurements.length, 1, "snapshot must include injected measurement");
  assert.equal(snapshot.measurements[0].id, "m0");

  // Clear and re-apply
  session.resetAll();
  assert.equal(measurementsModel.measurements.length, 0, "must be empty after reset");

  const validated = validatePlan(snapshot);
  assert.notEqual(validated, null, "validated plan must not be null");

  session.loadPlan(validated);
  assert.equal(measurementsModel.measurements.length, 1, "measurement must survive applyPlan");
  assert.equal(measurementsModel.measurements[0].a.x, 0);
  assert.equal(measurementsModel.measurements[0].b.x, 3);
});

// ── serializePlan includes measurements in output ─────────────────────────────

test("serializePlan includes measurements key", () => {
  session.newPlan();
  const p = buildPlan();
  const serialized = serializePlan(p);
  const parsed = JSON.parse(serialized);
  assert.ok("measurements" in parsed, "serialized plan must have measurements key");
  assert.deepEqual(parsed.measurements, []);
});

// ── compact codec: absence tolerance (old 'c' links) ─────────────────────────

test("parseCompact tolerates missing 'm' key (old compact links decode to measurements:[])", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 3, h: 4 } });
  const p = buildPlan();
  const compact = buildCompact(p);
  // Simulate a pre-LLD-81 compact payload with no 'm' key
  delete compact.m;
  const restored = parseCompact(compact);
  assert.notEqual(restored, null, "parseCompact must not return null when 'm' is missing");
  assert.deepEqual(restored.measurements, [], "measurements must be [] when 'm' absent");
});

// ── compact codec: measurements survive encode/decode ─────────────────────────

test("compact codec: measurements round-trip through buildCompact/parseCompact/validatePlan", () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 3, h: 4 } });
  // Inject a measurement
  hydrateMeasurements({ measurements: [
    { id: "m0", a: { x: 0, y: 0 }, b: { x: 3, y: 0 } },
  ] });
  const p = buildPlan();
  const compact = buildCompact(p);
  assert.ok(Array.isArray(compact.m), "compact.m must be an array");
  assert.equal(compact.m.length, 1, "compact.m must have 1 entry");

  const restored = validatePlan(parseCompact(compact));
  assert.notEqual(restored, null, "validatePlan must accept round-tripped compact plan");
  assert.equal(restored.measurements.length, 1, "measurement count mismatch");
  assert.equal(restored.measurements[0].a.x, 0);
  assert.equal(restored.measurements[0].b.x, 3);
});
