/**
 * Integration — the convergence loop (the headline test) + the boxed-in
 * adversarial case + regression handoff. LLD 32 Test reqs.
 *
 * A scripted (deterministic, non-LLM) "agent" drives the real tools and applies
 * each report's suggestedMove DIRECTLY, proving the feedback shape closes the loop.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as session from "../src/session.js";
import * as tools from "../src/tools.js";
import { validatePlan, encodePlanToHash, decodeHashToPlan } from "../src/core.js";

beforeEach(() => session.resetAll());

test("headline convergence: 5×7 studio, bed+desk+sofa, 60 cm → satisfied", () => {
  // 1. Brief.
  const brief = tools.tool_set_brief({
    room: { w: 5, h: 7 },
    furniture: [{ type: "bed" }, { type: "desk" }, { type: "sofa" }],
    minWalkwayM: 0.6,
  });
  assert.equal(brief.ok, true);

  // 2. Room FIRST at exact brief dims (M2 sequencing).
  const room = tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 7 } });
  assert.equal(room.ok, true);

  // 3. Place the three pieces stacked toward the left in y-order, deliberately
  // too close (sub-threshold positive gaps between them) but resolvable by
  // translation — the intended "nudge me apart" start, not a hopeless pile-up.
  const bed = tools.tool_place_symbol({ type: "bed", x: 1.5, y: 2.2 }).id;
  const sofa = tools.tool_place_symbol({ type: "sofa", x: 1.6, y: 3.9 }).id;
  const desk = tools.tool_place_symbol({ type: "desk", x: 1.4, y: 4.85 }).id;
  assert.ok(bed && desk && sofa);
  // Sanity: the start is genuinely unsatisfied (something to converge from).
  assert.equal(tools.tool_check_brief().satisfied, false);

  // 4-6. Loop: poll check_brief; on each clearance violation apply the first
  // violating item's suggestedMove directly. Bounded iteration count.
  const MAX_ITERS = 40;
  let iters = 0;
  let done = false;
  for (; iters < MAX_ITERS; iters++) {
    const brief = tools.tool_check_brief();
    if (brief.satisfied) { done = true; break; }
    // Get the full clearance report and act on the first item with a move.
    const rep = tools.tool_check_clearance({});
    const target = rep.items.find((it) => it.suggestedMove && it.worstStatus !== "ok");
    if (!target) {
      // No actionable move but brief unsatisfied → would be a design failure.
      assert.fail(`no suggestedMove but unsatisfied: ${JSON.stringify(brief.unmet)}`);
    }
    const mv = tools.tool_move_symbol({ id: target.id, x: target.suggestedMove.toX, y: target.suggestedMove.toY });
    assert.equal(mv.ok, true);
  }

  assert.ok(done, `loop did not converge in ${MAX_ITERS} iters`);

  // Final asserts: brief satisfied, plan valid, all furniture clearance ok.
  assert.equal(tools.tool_check_brief().satisfied, true);
  const doc = tools.tool_get_plan().document;
  assert.notEqual(validatePlan(doc), null);
  const finalRep = tools.tool_check_clearance({});
  assert.equal(finalRep.worstStatus, "ok");
});

test("boxed-in adversarial (pinned flush left): first report is infeasible, no oscillation", () => {
  tools.tool_set_brief({
    room: { w: 4, h: 12 },
    furniture: [{ type: "sofa" }, { type: "desk" }],
    minWalkwayM: 0.6,
  });
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 4, h: 12 } });
  // Sofa pinned FLUSH against the left wall (NOT centered) — box 0.1..2.1.
  const sofa = tools.tool_place_symbol({ type: "sofa", x: 1.1, y: 6.0 }).id;
  // Desk to the right → sofa boxed in on x (span too narrow for both at 60 cm).
  tools.tool_place_symbol({ type: "desk", x: 3.2, y: 6.0 });

  // The FIRST report must already declare x boxed-in with no move — a
  // violated-only resolver would oscillate here; this one must not.
  const rep = tools.tool_check_clearance({ id: sofa });
  const item = rep.items[0];
  assert.deepEqual(item.boxedInAxes, ["x"]);
  assert.equal(item.suggestedMove, null);
  const v = rep.violations.find((s) => /Sofa/.test(s));
  assert.match(v, /pinned on the x-axis|widen the room|smaller pieces/);
  assert.doesNotMatch(v, /Move Sofa to ~\(/); // structural, not a nudge

  // A scripted agent that only applies suggestedMove would therefore emit ZERO
  // moves and terminate as infeasible — assert that behaviour explicitly.
  let moves = 0;
  for (let i = 0; i < 10; i++) {
    const r = tools.tool_check_clearance({ id: sofa });
    const t = r.items[0];
    if (t.suggestedMove) { tools.tool_move_symbol({ id: sofa, x: t.suggestedMove.toX, y: t.suggestedMove.toY }); moves++; }
    else break; // infeasible → stop
  }
  assert.equal(moves, 0, "no oscillation — zero moves emitted");
  // The brief never reaches satisfied for this layout.
  assert.equal(tools.tool_check_brief().satisfied, false);
});

test("regression: dumped plan has exactly the plan.js key set (no brief/threshold leakage)", () => {
  tools.tool_set_brief({ room: { w: 5, h: 7 }, furniture: [{ type: "bed" }], minWalkwayM: 0.7 });
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 7 } });
  tools.tool_place_symbol({ type: "bed", x: 2.5, y: 3.5 });
  const doc = tools.tool_get_plan().document;
  assert.deepEqual(
    Object.keys(doc).sort(),
    ["app", "schema", "symbols", "unit", "view", "walls"]
  );
  // No brief/threshold field anywhere in the serialized JSON.
  const json = JSON.stringify(doc);
  assert.doesNotMatch(json, /minWalkway|threshold|brief/i);
});

test("regression: round-trip through encode/decode + validatePlan accepts the output", async () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 7 } });
  tools.tool_place_symbol({ type: "sofa", x: 2.5, y: 3.5 });
  const doc = tools.tool_get_plan().document;
  const back = await decodeHashToPlan(await encodePlanToHash(doc));
  assert.deepEqual(back, doc);
  assert.notEqual(validatePlan(doc), null);
});
