/**
 * MCP integration — measurements model round-trip tests (LLD 81 + 92).
 *
 * LLD 81: Verifies that the measurements collection survives all serialization
 * paths reachable from the MCP server.
 * LLD 92: Verifies add/remove/getById/length CRUD functions.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as session from "../src/session.js";
import {
  measurementsModel, hydrateMeasurements,
  addMeasurement, removeMeasurement, getMeasurementById, measurementLength,
  buildPlan, validatePlan, serializePlan,
} from "../src/core.js";
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

// ── LLD 92: CRUD functions ────────────────────────────────────────────────────

test("LLD 92: add() appends a {id,a,b} and returns it", () => {
  session.resetAll();
  const m = addMeasurement({ x: 0, y: 0 }, { x: 3, y: 4 });
  assert.equal(measurementsModel.measurements.length, 1, "should have 1 measurement");
  assert.ok(typeof m.id === "string" && m.id.startsWith("m"), "id must be m<n>");
  assert.equal(m.a.x, 0);
  assert.equal(m.b.x, 3);
});

test("LLD 92: add() mints monotonically increasing ids", () => {
  session.resetAll();
  const m1 = addMeasurement({ x: 0, y: 0 }, { x: 1, y: 0 });
  const m2 = addMeasurement({ x: 0, y: 0 }, { x: 2, y: 0 });
  const n1 = parseInt(m1.id.replace("m", ""), 10);
  const n2 = parseInt(m2.id.replace("m", ""), 10);
  assert.ok(n2 > n1, `id ${m2.id} should be greater than ${m1.id}`);
});

test("LLD 92: remove() removes existing measurement (returns true)", () => {
  session.resetAll();
  const m = addMeasurement({ x: 0, y: 0 }, { x: 1, y: 1 });
  const ok = removeMeasurement(m.id);
  assert.equal(ok, true);
  assert.equal(measurementsModel.measurements.length, 0);
});

test("LLD 92: remove() no-op on missing id (returns false)", () => {
  session.resetAll();
  const ok = removeMeasurement("m999");
  assert.equal(ok, false);
});

test("LLD 92: getById() returns measurement for known id", () => {
  session.resetAll();
  const m = addMeasurement({ x: 1, y: 2 }, { x: 3, y: 4 });
  const found = getMeasurementById(m.id);
  assert.notEqual(found, null);
  assert.equal(found.id, m.id);
});

test("LLD 92: getById() returns null for unknown id", () => {
  session.resetAll();
  assert.equal(getMeasurementById("m9999"), null);
});

test("LLD 92: length() computes Euclidean distance (3-4-5)", () => {
  const len = measurementLength({ a: { x: 0, y: 0 }, b: { x: 3, y: 4 } });
  assert.ok(Math.abs(len - 5) < 1e-9, `Expected 5, got ${len}`);
});

test("LLD 92: length() returns 0 for coincident endpoints", () => {
  const len = measurementLength({ a: { x: 2, y: 3 }, b: { x: 2, y: 3 } });
  assert.ok(Math.abs(len) < 1e-9, `Expected 0, got ${len}`);
});

test("LLD 92: hydrate re-syncs counter past max loaded id (regression)", () => {
  hydrateMeasurements({ measurements: [
    { id: "m99", a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
  ] });
  // Add a new one — it must not reuse m99
  const m = addMeasurement({ x: 0, y: 0 }, { x: 1, y: 0 });
  const n = parseInt(m.id.replace("m", ""), 10);
  assert.ok(n > 99, `Expected id > m99, got ${m.id}`);
  hydrateMeasurements({ measurements: [] });
});
