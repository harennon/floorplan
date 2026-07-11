/**
 * plan.js — pure plan object build / validate / apply
 *
 * No DOM. Testable core. The single serialization format shared by
 * localStorage, JSON export, and the URL hash.
 */

import { model as wallsModel, hydrate as hydrateWalls } from "./walls.js";
import { model as symbolsModel, hydrate as hydrateSymbols, CATALOG } from "./symbols.js";
import { view, setView } from "./view.js";
import { unit, setUnit } from "./units.js";

export const PLAN_SCHEMA = 1;
const APP_TAG = "floorplan";
const VALID_UNITS = ["ft", "m"];

// ── Compact codec (LLD 77) ────────────────────────────────────────────────────

/** Internal version byte for the compact payload format. */
export const COMPACT_VERSION = 1;

/**
 * Round a coordinate to millimetre precision (3 decimal places).
 * @param {number} v
 * @returns {number}
 */
function _mmRound(v) {
  return Math.round(v * 1000) / 1000;
}

/**
 * Validated Plan → lean CompactPlan (drops app/schema/view/ids/defaults,
 * tuple vertices, mm-rounded coords). Pure. Assumes `plan` is already a
 * well-formed Plan (as produced by buildPlan/validatePlan).
 *
 * @typedef {Object} CompactPlan
 * @property {number} v   compact-format version (COMPACT_VERSION = 1)
 * @property {"ft"|"m"} u unit
 * @property {Array<{c:0|1, p:number[][]}>} r  rooms
 * @property {number[][]} k     chain vertices (draft), tuple [x,y] each
 * @property {Array<Object>} s   symbols
 *
 * @param {import("./plan.js").Plan} plan
 * @returns {CompactPlan}
 */
export function buildCompact(plan) {
  const r = plan.walls.rooms.map((room) => ({
    c: room.closed ? 1 : 0,
    p: room.verts.map((v) => [_mmRound(v.x), _mmRound(v.y)]),
  }));

  const k = plan.walls.chain.map((v) => [_mmRound(v.x), _mmRound(v.y)]);

  const s = plan.symbols.symbols.map((sym) => {
    const cat = CATALOG[sym.type];
    const compact = {
      t: sym.type,
      x: _mmRound(sym.x),
      y: _mmRound(sym.y),
    };
    // Omit w/h only when strictly equal to catalog defaults
    if (sym.w !== cat.w) compact.w = _mmRound(sym.w);
    if (sym.h !== cat.h) compact.h = _mmRound(sym.h);
    // Omit rot only when strictly 0
    if (sym.rot !== 0) compact.d = sym.rot;
    return compact;
  });

  return { v: COMPACT_VERSION, u: plan.unit, r, k, s };
}

/**
 * Lean CompactPlan → full Plan-shaped object (re-adds app/schema/default view,
 * synthesises ids, re-expands vertices and omitted catalog defaults). Returns a
 * plain object suitable to hand to validatePlan; does NOT itself validate.
 * Returns null if `compact` is structurally unusable (wrong version, missing
 * arrays).
 *
 * @param {unknown} compact
 * @returns {object|null}
 */
export function parseCompact(compact) {
  try {
    if (!compact || typeof compact !== "object" || Array.isArray(compact)) return null;
    if (compact.v !== COMPACT_VERSION) return null;
    if (!Array.isArray(compact.r)) return null;
    if (!Array.isArray(compact.k)) return null;
    if (!Array.isArray(compact.s)) return null;

    const rooms = compact.r.map((room, i) => {
      if (!room || typeof room !== "object") return null;
      if (!Array.isArray(room.p)) return null;
      const verts = room.p.map((tuple) => {
        if (!Array.isArray(tuple) || tuple.length < 2) return null;
        const x = tuple[0], y = tuple[1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return { x, y };
      });
      if (verts.some((v) => v === null)) return null;
      return {
        id: `w${i}`,
        closed: room.c === 1,
        verts,
      };
    });
    if (rooms.some((r) => r === null)) return null;

    const chain = compact.k.map((tuple) => {
      if (!Array.isArray(tuple) || tuple.length < 2) return null;
      const x = tuple[0], y = tuple[1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    });
    if (chain.some((v) => v === null)) return null;

    const symbols = compact.s.map((sym, i) => {
      if (!sym || typeof sym !== "object") return null;
      const t = sym.t;
      if (typeof t !== "string") return null;
      const cat = CATALOG[t];
      // Unknown type: pass through so validatePlan rejects it cleanly
      const x = sym.x, y = sym.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const w = sym.w !== undefined ? sym.w : (cat ? cat.w : 0);
      const h = sym.h !== undefined ? sym.h : (cat ? cat.h : 0);
      const rot = sym.d !== undefined ? sym.d : 0;
      if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(rot)) return null;
      return {
        id: `s${i}`,
        type: t,
        x,
        y,
        w,
        h,
        rot,
      };
    });
    if (symbols.some((s) => s === null)) return null;

    return {
      schema: PLAN_SCHEMA,
      app: APP_TAG,
      walls: { rooms, chain },
      symbols: { symbols },
      view: { zoom: 1, panX: 0, panY: 0 },
      unit: compact.u,
    };
  } catch {
    return null;
  }
}

/**
 * Snapshot current live state into a fresh, JSON-safe Plan object.
 * @returns {Plan}
 */
export function buildPlan() {
  return {
    schema: PLAN_SCHEMA,
    app: APP_TAG,
    walls: {
      rooms: JSON.parse(JSON.stringify(wallsModel.rooms)),
      chain: JSON.parse(JSON.stringify(wallsModel.chain)),
    },
    symbols: {
      symbols: JSON.parse(JSON.stringify(symbolsModel.symbols)),
    },
    view: {
      zoom: view.zoom,
      panX: view.panX,
      panY: view.panY,
    },
    unit: unit,
  };
}

/**
 * Deep structural + type validation.
 * Returns the normalised Plan or null. Never throws.
 * @param {unknown} raw
 * @returns {Plan|null}
 */
export function validatePlan(raw) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

    // Guard tag
    if (raw.app !== APP_TAG) return null;

    // Schema version
    if (raw.schema !== PLAN_SCHEMA) return null;

    // walls
    if (!raw.walls || typeof raw.walls !== "object") return null;
    if (!Array.isArray(raw.walls.rooms)) return null;
    if (!Array.isArray(raw.walls.chain)) return null;

    // Validate rooms
    for (const room of raw.walls.rooms) {
      if (!room || typeof room !== "object") return null;
      if (typeof room.id !== "string") return null;
      if (typeof room.closed !== "boolean") return null;
      if (!Array.isArray(room.verts)) return null;
      for (const v of room.verts) {
        if (!_isValidVertex(v)) return null;
      }
    }

    // Validate chain
    for (const v of raw.walls.chain) {
      if (!_isValidVertex(v)) return null;
    }

    // symbols
    if (!raw.symbols || typeof raw.symbols !== "object") return null;
    if (!Array.isArray(raw.symbols.symbols)) return null;

    for (const sym of raw.symbols.symbols) {
      if (!sym || typeof sym !== "object") return null;
      if (typeof sym.id !== "string") return null;
      if (!(sym.type in CATALOG)) return null;
      if (!Number.isFinite(sym.x)) return null;
      if (!Number.isFinite(sym.y)) return null;
      if (!Number.isFinite(sym.w)) return null;
      if (!Number.isFinite(sym.h)) return null;
      if (!Number.isFinite(sym.rot)) return null;
    }

    // view
    if (!raw.view || typeof raw.view !== "object") return null;
    if (!Number.isFinite(raw.view.zoom)) return null;
    if (!Number.isFinite(raw.view.panX)) return null;
    if (!Number.isFinite(raw.view.panY)) return null;

    // unit
    if (!VALID_UNITS.includes(raw.unit)) return null;

    // Return a clean copy (normalised)
    return {
      schema: raw.schema,
      app: raw.app,
      walls: {
        rooms: JSON.parse(JSON.stringify(raw.walls.rooms)),
        chain: JSON.parse(JSON.stringify(raw.walls.chain)),
      },
      symbols: {
        symbols: JSON.parse(JSON.stringify(raw.symbols.symbols)),
      },
      view: {
        zoom: raw.view.zoom,
        panX: raw.view.panX,
        panY: raw.view.panY,
      },
      unit: raw.unit,
    };
  } catch {
    return null;
  }
}

/**
 * Apply a validated Plan to the live modules in place.
 * Caller must trigger render afterward.
 * Assumes plan already validated.
 * @param {Plan} plan
 */
export function applyPlan(plan) {
  hydrateWalls(plan.walls);
  hydrateSymbols(plan.symbols);
  setView(plan.view);
  setUnit(plan.unit);
}

/**
 * True when the live plan has no rooms, no chain, and no symbols.
 * @returns {boolean}
 */
export function isEmptyPlan() {
  return wallsModel.rooms.length === 0
    && wallsModel.chain.length === 0
    && symbolsModel.symbols.length === 0;
}

/**
 * Stable JSON string of a Plan with fixed key order for dirty-checking.
 * @param {Plan} plan
 * @returns {string}
 */
export function serializePlan(plan) {
  // Fixed key order for stability
  return JSON.stringify({
    schema: plan.schema,
    app: plan.app,
    walls: plan.walls,
    symbols: plan.symbols,
    view: plan.view,
    unit: plan.unit,
  });
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _isValidVertex(v) {
  if (!v || typeof v !== "object") return false;
  if (!Number.isFinite(v.x)) return false;
  if (!Number.isFinite(v.y)) return false;
  return true;
}
