/**
 * brief.js — in-memory requirement store for the agent design loop (LLD 32).
 *
 * The Brief holds the parsed requirements the agent is trying to satisfy:
 * target room dims, required furniture, and the minimum walkway. It is
 * server-session state only and is NEVER serialized into the Plan JSON.
 */

import { CATALOG, THRESH_MIN, THRESH_MAX, DEFAULT_THRESHOLD } from "./core.js";

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
 * - minWalkwayM defaults to DEFAULT_THRESHOLD; MUST be in [THRESH_MIN, THRESH_MAX]
 *   (M1: reject out-of-range here so setThreshold can never silently clamp it).
 *
 * @param {{ room?:{w:number,h:number}, furniture?:{type:string,count?:number}[], minWalkwayM?:number }} spec
 */
export function setBrief(spec) {
  if (!spec || typeof spec !== "object") {
    return { ok: false, reason: "brief must be an object" };
  }

  /** @type {Brief} */
  const brief = { furniture: [], minWalkwayM: DEFAULT_THRESHOLD };

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

  // minWalkwayM (optional; M1 range guard)
  if (spec.minWalkwayM !== undefined) {
    const m = spec.minWalkwayM;
    if (!Number.isFinite(m) || m < THRESH_MIN || m > THRESH_MAX) {
      return { ok: false, reason: "walkway must be 0.30–1.20 m" };
    }
    brief.minWalkwayM = m;
  }

  _brief = brief;
  return { ok: true, brief };
}
