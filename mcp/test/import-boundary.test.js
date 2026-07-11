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

test("asResult flags genuine failures (ok:false) as isError, but NOT negative verdicts", async () => {
  const { asResult } = await import("../src/server.js");
  const session = await import("../src/session.js");
  const tools = await import("../src/tools.js");
  session.resetAll();

  // Genuine execution/input failures → isError:true (all return { ok:false }).
  assert.equal(asResult(tools.tool_move_symbol({ id: "nope", x: 1, y: 1 })).isError, true);
  assert.equal(asResult(tools.tool_place_symbol({ type: "spaceship", x: 1, y: 1 })).isError, true);
  assert.equal(asResult(tools.tool_check_clearance({ minWalkwayM: 0.1 })).isError, true);

  // Negative VERDICTS ({ satisfied:false }, no ok field) are NOT errors — the SDK
  // must still validate them against outputSchema, so isError must be unset.
  const briefRes = asResult(tools.tool_check_brief());
  assert.equal(briefRes.structuredContent.satisfied, false);
  assert.equal(briefRes.isError, undefined);

  // A success payload is never an error and always carries structuredContent.
  session.newPlan();
  const ok = asResult(tools.tool_add_room({ rect: { x: 0, y: 0, w: 3, h: 4 } }));
  assert.equal(ok.isError, undefined);
  assert.equal(ok.structuredContent.ok, true);
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
