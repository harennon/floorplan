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
