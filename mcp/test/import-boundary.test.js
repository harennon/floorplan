/**
 * Integration — headless import boundary (LLD 32 Q6 drift early-warning).
 * Each depended-on src/js module must load under Node without throwing, and
 * share.js's encodePlanToHash must run headless and round-trip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test("every depended-on src/js module imports clean under Node", async () => {
  await assert.doesNotReject(() => import("../../src/js/plan.js"));
  await assert.doesNotReject(() => import("../../src/js/walls.js"));
  await assert.doesNotReject(() => import("../../src/js/symbols.js"));
  await assert.doesNotReject(() => import("../../src/js/clearance.js"));
  await assert.doesNotReject(() => import("../../src/js/share.js"));
  await assert.doesNotReject(() => import("../../src/js/view.js"));
  await assert.doesNotReject(() => import("../../src/js/units.js"));
  // The single import boundary used by the server.
  await assert.doesNotReject(() => import("../src/core.js"));
});

test("server.js imports without starting the stdio server", async () => {
  const m = await import("../src/server.js");
  assert.equal(typeof m.buildServer, "function");
});

test("encodePlanToHash runs headless and round-trips through decodeHashToPlan", async () => {
  const { encodePlanToHash, decodeHashToPlan } = await import("../../src/js/share.js");
  const { emptyPlan } = await import("../src/session.js");
  const doc = emptyPlan();
  doc.walls.rooms.push({ id: "w0", closed: true, verts: [
    { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 7 }, { x: 0, y: 7 },
  ] });
  const hash = await encodePlanToHash(doc);
  const back = await decodeHashToPlan(hash);
  assert.deepEqual(back, doc);
});
