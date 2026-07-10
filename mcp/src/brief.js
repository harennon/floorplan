/**
 * brief.js — in-memory requirement store for the agent design loop (LLD 32).
 *
 * The Brief holds the parsed requirements the agent is trying to satisfy:
 * target room dims, required furniture, and the minimum walkway. It is
 * server-session state only and is NEVER serialized into the Plan JSON.
 */

import { CATALOG, THRESH_MAX } from "./core.js";

// ── MCP walkway policy (grounded in accessibility/building standards) ──────────
// The shared editor slider (clearance.js) clamps to [0.30, 1.20] m — those are UI
// bounds, NOT a walkway standard. For the agent's design brief we hold "min
// walkway" to a real passage width:
//   • 0.915 m (36 in) default — ADA §403.5.1 accessible route + IRC §R311.6 hallway.
//   • 0.76  m (30 in) floor    — tightest defensible residential walkway; below this
//                                 is a between-furniture gap, not a passage.
//   • 1.20  m ceiling          — the shared clamp's max (a wider "min walkway" would
//                                 be silently clamped by setThreshold, desyncing the
//                                 objective from the reported thresholdM — see M1).
//                                 A wheelchair-turning brief (1.525 m, ADA §304) would
//                                 need the shared clamp widened first — out of scope.
export const MCP_WALKWAY_MIN = 0.76;
export const MCP_WALKWAY_MAX = THRESH_MAX; // 1.20 — shared clamp ceiling
export const MCP_WALKWAY_DEFAULT = 0.915;

/** Shared out-of-range message so brief.js and tools.js stay in lockstep. */
export const WALKWAY_RANGE_MSG =
  "walkway must be 0.76–1.20 m (ADA §403.5.1 / IRC R311.6 recommend ≥0.915 m for a passage)";

/**
 * @typedef {{ w:number, h:number }} RoomReq
 * @typedef {{ type:string, count:number }} FurnitureReq
 * @typedef {{ room?:RoomReq, furniture:FurnitureReq[], minWalkwayM:number }} Brief
 */

/** @type {Brief|null} */
let _brief = null;

/** Return the active brief, or null if none set. */
export function getBrief() {
  return _brief;
}

/** Clear the brief (used by full resets). */
export function clearBrief() {
  _brief = null;
}

/**
 * Parse + validate a brief spec. Returns { ok:true, brief } or { ok:false, reason }.
 * - room dims must be finite positive metres when supplied.
 * - furniture types must be in CATALOG; count defaults to 1, must be a positive integer.
 * - minWalkwayM defaults to MCP_WALKWAY_DEFAULT; MUST be in
 *   [MCP_WALKWAY_MIN, MCP_WALKWAY_MAX] (M1: reject out-of-range here so
 *   setThreshold can never silently clamp it, and so "min walkway" means a real
 *   passage width, not the editor slider's floor).
 *
 * @param {{ room?:{w:number,h:number}, furniture?:{type:string,count?:number}[], minWalkwayM?:number }} spec
 */
export function setBrief(spec) {
  if (!spec || typeof spec !== "object") {
    return { ok: false, reason: "brief must be an object" };
  }

  /** @type {Brief} */
  const brief = { furniture: [], minWalkwayM: MCP_WALKWAY_DEFAULT };

  // room (optional)
  if (spec.room !== undefined) {
    const r = spec.room;
    if (!r || !Number.isFinite(r.w) || !Number.isFinite(r.h) || r.w <= 0 || r.h <= 0) {
      return { ok: false, reason: "room dims must be finite positive metres" };
    }
    brief.room = { w: r.w, h: r.h };
  }

  // furniture (optional)
  if (spec.furniture !== undefined) {
    if (!Array.isArray(spec.furniture)) {
      return { ok: false, reason: "furniture must be an array" };
    }
    for (const f of spec.furniture) {
      if (!f || typeof f.type !== "string" || !(f.type in CATALOG)) {
        return { ok: false, reason: `unknown furniture type: ${f && f.type}` };
      }
      let count = f.count === undefined ? 1 : f.count;
      if (!Number.isInteger(count) || count < 1) {
        return { ok: false, reason: "furniture count must be a positive integer" };
      }
      brief.furniture.push({ type: f.type, count });
    }
  }

  // minWalkwayM (optional; M1 range guard against the grounded MCP range)
  if (spec.minWalkwayM !== undefined) {
    const m = spec.minWalkwayM;
    if (!Number.isFinite(m) || m < MCP_WALKWAY_MIN || m > MCP_WALKWAY_MAX) {
      return { ok: false, reason: WALKWAY_RANGE_MSG };
    }
    brief.minWalkwayM = m;
  }

  _brief = brief;
  return { ok: true, brief };
}
