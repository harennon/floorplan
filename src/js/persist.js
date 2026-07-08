/**
 * persist.js — serialization + localStorage autosave (LLD 15)
 *
 * serialize()   reads live models → PlanDoc
 * deserialize() validates + loads a PlanDoc into models
 * validate()    shape/range check
 * loadFromStorage() / saveNow() / scheduleSave()
 * onStatusChange()  for save-status pill
 */

import { model as wallsModel } from "./walls.js";
import { model as symbolsModel, CATALOG } from "./symbols.js";
import { replaceRooms } from "./walls.js";
import { replaceSymbols } from "./symbols.js";

// ── Constants ────────────────────────────────────────────────────────────────

export const STORAGE_KEY      = "floorplan.plan.v1";
export const SAVE_DEBOUNCE_MS = 800;
const MAX_ROOMS   = 10000;
const MAX_SYMBOLS = 10000;

// ── Status ───────────────────────────────────────────────────────────────────

/** @typedef {"saved"|"saving"|"unsaved"|"error"} SaveStatus */

let _status = /** @type {SaveStatus} */ ("saved");
const _statusListeners = [];

/** Register a callback fired when save status changes. */
export function onStatusChange(cb) {
  _statusListeners.push(cb);
}

function _setStatus(s) {
  if (_status !== s) {
    _status = s;
    for (const cb of _statusListeners) cb(s);
  }
}

// ── Serialization ────────────────────────────────────────────────────────────

/**
 * Read live models → PlanDoc (not yet stringified).
 * @returns {{ v:1, app:"floorplan", rooms:any[], symbols:any[] }}
 */
export function serialize() {
  return {
    v: 1,
    app: "floorplan",
    rooms: wallsModel.rooms.map(r => ({
      id: r.id,
      closed: r.closed,
      verts: r.verts.map(v => ({ x: v.x, y: v.y })),
    })),
    symbols: symbolsModel.symbols.map(s => ({
      id: s.id, type: s.type, x: s.x, y: s.y, w: s.w, h: s.h, rot: s.rot,
    })),
  };
}

/**
 * Validate a parsed object as a PlanDoc.
 * Returns the doc (same reference) if valid, or null if invalid.
 * @param {any} doc
 * @returns {any|null}
 */
export function validate(doc) {
  if (!doc || typeof doc !== "object") return null;
  if (doc.v !== 1) return null;                  // unknown/future schema
  if (doc.app !== "floorplan") return null;
  if (!Array.isArray(doc.rooms)) return null;
  if (!Array.isArray(doc.symbols)) return null;
  if (doc.rooms.length > MAX_ROOMS) return null;
  if (doc.symbols.length > MAX_SYMBOLS) return null;

  for (const r of doc.rooms) {
    if (!r || typeof r !== "object") return null;
    if (typeof r.id !== "string") return null;
    if (typeof r.closed !== "boolean") return null;
    if (!Array.isArray(r.verts)) return null;
    for (const v of r.verts) {
      if (!_isFiniteNum(v.x) || !_isFiniteNum(v.y)) return null;
    }
  }

  for (const s of doc.symbols) {
    if (!s || typeof s !== "object") return null;
    if (typeof s.id !== "string") return null;
    if (!CATALOG[s.type]) return null;           // out-of-catalog type
    if (!_isFiniteNum(s.x) || !_isFiniteNum(s.y)) return null;
    if (!_isFiniteNum(s.w) || !_isFiniteNum(s.h)) return null;
    if (!_isFiniteNum(s.rot)) return null;
  }

  return doc;
}

function _isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Validate and load a PlanDoc into the live models.
 * Returns true on success, false on invalid input.
 * @param {any} doc
 * @returns {boolean}
 */
export function deserialize(doc) {
  if (!validate(doc)) return false;
  replaceRooms(doc.rooms);
  replaceSymbols(doc.symbols);
  return true;
}

// ── localStorage access ──────────────────────────────────────────────────────

/**
 * Try to load the stored PlanDoc. Returns null if absent / invalid / unavailable.
 * @returns {any|null}
 */
export function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return null;
    const parsed = JSON.parse(raw);
    return validate(parsed);
  } catch {
    return null;
  }
}

/**
 * Does STORAGE_KEY hold a parseable, valid plan?
 * @returns {boolean}
 */
export function hasStoredPlan() {
  return loadFromStorage() !== null;
}

/** Last stringified doc written to storage (for equality guard). */
let _lastWritten = null;

/**
 * Synchronous write. Returns "ok" | "error" | "empty".
 * "empty" means zero geometry — still written so Reset persists emptiness.
 * @returns {"ok"|"error"|"empty"}
 */
export function saveNow() {
  const doc = serialize();
  const isGeomEmpty = doc.rooms.length === 0 && doc.symbols.length === 0;
  const str = JSON.stringify(doc);

  if (str === _lastWritten) {
    _setStatus("saved");
    return isGeomEmpty ? "empty" : "ok";
  }

  try {
    localStorage.setItem(STORAGE_KEY, str);
    _lastWritten = str;
    _setStatus("saved");
    return isGeomEmpty ? "empty" : "ok";
  } catch {
    _setStatus("error");
    return "error";
  }
}

// ── Debounced autosave ───────────────────────────────────────────────────────

let _debounceTimer = null;

/**
 * Trailing-debounced saveNow(). Wire as an onRender hook.
 */
export function scheduleSave() {
  _setStatus("saving");
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    saveNow();
  }, SAVE_DEBOUNCE_MS);
}

// ── Page-unload flush ────────────────────────────────────────────────────────

// Flush any pending debounce on page hide (tab close, navigation)
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
      saveNow();
    }
  });
  window.addEventListener("pagehide", () => {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
    saveNow();
  });
}
