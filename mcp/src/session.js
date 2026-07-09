/**
 * session.js — the load/edit/dump discipline over the core singletons (LLD 32).
 *
 * The core singletons (walls.model, symbols.model, clearance threshold) ARE the
 * session's working plan — there is exactly one live plan per server process.
 * This module owns loading (new/load), snapshotting (dump), and the
 * single-session guard.
 *
 * Concurrency contract: mutator handlers must be fully synchronous (no await),
 * so two mutations can never interleave. Only save_plan/get_share_url await, and
 * they snapshot via buildPlan() BEFORE awaiting and never mutate.
 */

import {
  buildPlan,
  validatePlan,
  applyPlan,
  hydrateWalls,
  hydrateSymbols,
  setThreshold,
  DEFAULT_THRESHOLD,
} from "./core.js";
import { clearBrief } from "./brief.js";

/** An empty, valid Plan document (plan.js shape). unit defaults to metres. */
export function emptyPlan() {
  return {
    schema: 1,
    app: "floorplan",
    walls: { rooms: [], chain: [] },
    symbols: { symbols: [] },
    view: { zoom: 1, panX: 0, panY: 0 },
    unit: "m",
  };
}

/**
 * Reset the singletons to a fresh empty plan.
 * Fully resets rooms/chain/symbols and the clearance threshold so a second brief
 * in the same process cannot inherit stale geometry.
 *
 * Single-session note: there is exactly one live plan per process by
 * construction — the core singletons ARE the plan, and no tool opens a "second"
 * plan (new_plan/load_plan REPLACE, never add). In a single-client stdio model
 * there is no concurrent-session path to guard against, so no active-session
 * flag is kept. If the server ever serves multiple plans, this must move to a
 * session store keyed by session id (see LLD State model — migration path).
 */
export function newPlan() {
  applyPlan(emptyPlan());
  setThreshold(DEFAULT_THRESHOLD);
}

/**
 * Validate + apply a supplied document, fully replacing session contents.
 * Returns { ok:true } or { ok:false, error } WITHOUT mutating on failure.
 * @param {unknown} raw
 */
export function loadPlan(raw) {
  // Distinguish a newer-schema doc for a clearer message (mirrors importJson).
  if (raw && typeof raw === "object" && !Array.isArray(raw) &&
      raw.app === "floorplan" && typeof raw.schema === "number" && raw.schema > 1) {
    return { ok: false, error: "made with a newer version of floorplan" };
  }
  const plan = validatePlan(raw);
  if (plan === null) {
    return { ok: false, error: "invalid plan document" };
  }
  applyPlan(plan);
  setThreshold(DEFAULT_THRESHOLD);
  return { ok: true };
}

/** Snapshot the live singletons into a JSON-safe Plan document. */
export function dumpPlan() {
  return buildPlan();
}

/**
 * Full process reset for tests: clears singletons, threshold, and brief.
 * Not an MCP tool — test/support only.
 */
export function resetAll() {
  hydrateWalls({ rooms: [], chain: [] });
  hydrateSymbols({ symbols: [] });
  setThreshold(DEFAULT_THRESHOLD);
  clearBrief();
}
