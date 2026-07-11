/**
 * tools.js — tool handlers: mutators + evaluators (LLD 32).
 *
 * Handlers are plain functions returning plain JSON-able objects (the MCP SDK
 * wiring lives in server.js). Mutators are fully synchronous (no await) so core
 * singleton mutations can never interleave. save_plan / get_share_url are the
 * only async handlers; they snapshot via buildPlan() before awaiting.
 *
 * All lengths in args/results are metres (matching the core); human-facing
 * feedback strings additionally echo centimetres.
 */

import {
  wallsModel,
  symbolsModel,
  placeVertex,
  closeRoom,
  rescaleEdge,
  roomMetrics,
  wallSegments,
  createSymbol,
  addSymbol,
  moveSymbol,
  rotateSymbol,
  resizeSymbol,
  clampDim,
  removeSymbol,
  duplicateSymbol,
  getSymbol,
  aabb,
  CATALOG,
  corners,
  WALL_M,
  PARALLEL_TOL_DEG,
  encodePlanToHash,
  serializePlan,
} from "./core.js";
import * as session from "./session.js";
import {
  getBrief,
  setBrief,
  MCP_WALKWAY_MIN,
  MCP_WALKWAY_MAX,
  MCP_WALKWAY_DEFAULT,
  WALKWAY_RANGE_MSG,
} from "./brief.js";
import { buildClearanceReport } from "./feedback.js";
import { savePlanFile } from "./io.js";

const SHARE_BASE = "https://floorplan.danbing.app/#";

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Opening near-edge-to-wall-face adjacency slack (metres). */
const WALL_ADJ_TOL_M = 0.15;

/**
 * True if an opening's footprint is parallel-and-adjacent to some wall segment.
 * Mirrors nearestWallFlush (symbols.js) parallel+overlap+face-gap math, reduced
 * to a boolean. Pure: all inputs injected.
 *
 * @param {import("../../src/js/symbols.js").Sym} sym
 * @param {{ a:{x:number,y:number}, b:{x:number,y:number} }[]} segments
 * @param {number} tolM  adjacency tolerance in metres
 * @returns {boolean}
 */
function openingOnWall(sym, segments, tolM) {
  const tolRad = (PARALLEL_TOL_DEG * Math.PI) / 180;
  const cosThresh = Math.cos(tolRad);
  const halfWall = WALL_M / 2;
  const corners4 = corners(sym);

  for (const seg of segments) {
    const ax = seg.a.x, ay = seg.a.y;
    const bx = seg.b.x, by = seg.b.y;
    const segDx = bx - ax;
    const segDy = by - ay;
    const segLen = Math.sqrt(segDx * segDx + segDy * segDy);
    if (segLen < 1e-9) continue; // degenerate

    // Unit tangent (t) and normal (n) along the segment
    const tx = segDx / segLen;
    const ty = segDy / segLen;
    const nx = ty;
    const ny = -tx;

    // Project all four corners onto t and n
    let symTMin = Infinity, symTMax = -Infinity;
    let symNMin = Infinity, symNMax = -Infinity;
    for (const c of corners4) {
      const relX = c.x - ax;
      const relY = c.y - ay;
      const t = relX * tx + relY * ty;
      const n = relX * nx + relY * ny;
      if (t < symTMin) symTMin = t;
      if (t > symTMax) symTMax = t;
      if (n < symNMin) symNMin = n;
      if (n > symNMax) symNMax = n;
    }

    // 1. t-span overlap with [0, segLen]
    if (Math.min(symTMax, segLen) <= Math.max(symTMin, 0)) continue;

    // 2. Parallel check: local x- or y-axis of the symbol within PARALLEL_TOL_DEG
    const symXX = corners4[1].x - corners4[0].x;
    const symXY = corners4[1].y - corners4[0].y;
    const symXLen = Math.sqrt(symXX * symXX + symXY * symXY);
    const symYX = corners4[3].x - corners4[0].x;
    const symYY = corners4[3].y - corners4[0].y;
    const symYLen = Math.sqrt(symYX * symYX + symYY * symYY);
    const cosX = symXLen > 1e-9 ? Math.abs((symXX * tx + symXY * ty) / symXLen) : 0;
    const cosY = symYLen > 1e-9 ? Math.abs((symYX * tx + symYY * ty) / symYLen) : 0;
    if (cosX < cosThresh && cosY < cosThresh) continue;

    // 3. Adjacency: nearest symbol edge to either wall face ≤ tolM
    for (const faceN of [halfWall, -halfWall]) {
      const nearEdgeN = Math.abs(symNMin - faceN) <= Math.abs(symNMax - faceN)
        ? symNMin : symNMax;
      if (Math.abs(nearEdgeN - faceN) <= tolM) return true;
    }
  }
  return false;
}

function world() {
  return { rooms: wallsModel.rooms, symbols: symbolsModel.symbols };
}

// ── Session / lifecycle ─────────────────────────────────────────────────────

export function tool_set_brief(args) {
  const res = setBrief(args || {});
  if (!res.ok) return res;
  return { ok: true, brief: res.brief };
}

export function tool_new_plan() {
  session.newPlan();
  return { ok: true, plan_summary: planSummary() };
}

export function tool_load_plan(args) {
  return session.loadPlan(args && args.document);
}

export async function tool_save_plan(args) {
  // Snapshot BEFORE any await (concurrency contract).
  const json = serializePlan(session.dumpPlan());
  const res = await savePlanFile(json, args && args.filename, args && args.rootDir);
  return res;
}

export async function tool_get_share_url() {
  // Snapshot BEFORE any await.
  const plan = session.dumpPlan();
  const hash = await encodePlanToHash(plan);
  return { url: SHARE_BASE + hash };
}

export function tool_get_plan() {
  return { document: session.dumpPlan() };
}

function planSummary() {
  return {
    rooms: wallsModel.rooms.length,
    symbols: symbolsModel.symbols.length,
  };
}

// ── Mutators ────────────────────────────────────────────────────────────────

/**
 * add_room: { verts:[{x,y},…] } or { rect:{x,y,w,h} } (top-left origin).
 * Returns { ok, roomId, metrics } or { ok:false, reason }.
 */
export function tool_add_room(args) {
  // Gap A: single-room brief — reject a second room before any mutation.
  const brief = getBrief();
  if (brief && brief.room) {
    const existingClosed = wallsModel.rooms.find((r) => r.closed);
    if (existingClosed) {
      return {
        ok: false,
        reason:
          `single-room brief already has a room (${existingClosed.id}); ` +
          `call new_plan to start over, or set_edge_length to resize the existing room instead of adding another`,
      };
    }
  }

  let verts;
  if (args && args.rect) {
    const { x, y, w, h } = args.rect;
    if (![x, y, w, h].every(isFiniteNum) || w <= 0 || h <= 0) {
      return { ok: false, reason: "rect needs finite x,y and positive w,h" };
    }
    verts = [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
  } else if (args && Array.isArray(args.verts)) {
    verts = args.verts;
    if (verts.length < 3) {
      return { ok: false, reason: "a room needs at least 3 corners" };
    }
    for (const v of verts) {
      if (!v || !isFiniteNum(v.x) || !isFiniteNum(v.y)) {
        return { ok: false, reason: "each vert needs finite x,y" };
      }
    }
  } else {
    return { ok: false, reason: "provide rect:{x,y,w,h} or verts:[{x,y},…]" };
  }

  const before = wallsModel.rooms.length;
  for (const v of verts) placeVertex({ x: v.x, y: v.y });
  const closed = closeRoom();
  if (!closed || wallsModel.rooms.length === before) {
    // closeRoom no-ops below 3 effective verts (e.g. collapsed by MIN_SEG_M).
    wallsModel.chain.length = 0;
    return { ok: false, reason: "a room needs at least 3 corners" };
  }
  const room = wallsModel.rooms[wallsModel.rooms.length - 1];
  // EC5: a closed polygon with area === 0 is collinear; no epsilon — shoelace of
  // collinear integer-ish coords is exactly zero, and any nonzero area is a real room.
  const metrics = roomMetrics(room);
  if (metrics.area === 0) {
    wallsModel.rooms.pop();
    wallsModel.chain.length = 0;
    return { ok: false, reason: "a room needs 3+ non-collinear corners" };
  }
  return { ok: true, roomId: room.id, metrics };
}

/**
 * set_edge_length: { roomId, edgeIndex, lengthM }. rescaleEdge (deforms a rect —
 * NOT a resizer; see LLD M2). Returns { ok, newMetrics } or { ok:false, reason }.
 */
export function tool_set_edge_length(args) {
  const { roomId, edgeIndex, lengthM } = args || {};
  const room = wallsModel.rooms.find((r) => r.id === roomId);
  if (!room) return { ok: false, reason: "no such room" };
  if (!Number.isInteger(edgeIndex) || edgeIndex < 0) {
    return { ok: false, reason: "edge index out of range" };
  }
  if (!isFiniteNum(lengthM) || lengthM <= 0) {
    return { ok: false, reason: "lengthM must be finite positive" };
  }
  const ok = rescaleEdge(room, edgeIndex, lengthM);
  if (!ok) {
    return { ok: false, reason: "edge index out of range or degenerate edge" };
  }
  return { ok: true, newMetrics: roomMetrics(room) };
}

/**
 * place_symbol: { type, x, y, w?, h?, rot? }. Dims routed through clampDim.
 * Returns { ok, id, type, w, h, rot, clamped, hIgnored, clearance } or { ok:false }.
 */
export function tool_place_symbol(args) {
  const { type, x, y, w, h, rot } = args || {};
  if (typeof type !== "string" || !(type in CATALOG)) {
    return { ok: false, reason: "unknown symbol type" };
  }
  if (!isFiniteNum(x) || !isFiniteNum(y)) {
    return { ok: false, reason: "x,y must be finite" };
  }
  const isOpening = !!CATALOG[type].openings;

  const sym = createSymbol(type, x, y);
  let clamped = false;
  let hIgnored = false;

  if (w !== undefined) {
    if (!isFiniteNum(w)) return { ok: false, reason: "w must be finite" };
    if (clampDim(type, "w", w) !== w) clamped = true;
    resizeSymbol(sym, "w", w);
  }
  if (h !== undefined) {
    if (!isFiniteNum(h)) return { ok: false, reason: "h must be finite" };
    if (isOpening) {
      hIgnored = true; // openings ignore depth (resizeSymbol returns false)
    } else {
      if (clampDim(type, "h", h) !== h) clamped = true;
      resizeSymbol(sym, "h", h);
    }
  }
  if (rot !== undefined) {
    if (!isFiniteNum(rot)) return { ok: false, reason: "rot must be finite" };
    rotateSymbol(sym, rot);
  }

  // Gap B: openings must sit on a wall — check before addSymbol (never mutates on reject).
  if (isOpening && !openingOnWall(sym, wallSegments(), WALL_ADJ_TOL_M)) {
    return {
      ok: false,
      reason:
        `a ${CATALOG[type].label.toLowerCase()} must sit on a wall; ` +
        `place it within 0.15 m of a wall segment (center on the wall line)`,
    };
  }

  addSymbol(sym);
  return {
    ok: true,
    id: sym.id,
    type: sym.type,
    w: sym.w,
    h: sym.h,
    rot: sym.rot,
    clamped,
    hIgnored,
    clearance: singleClearance(sym.id),
  };
}

/** move_symbol: { id, x, y }. Returns fresh clearance for the moved symbol. */
export function tool_move_symbol(args) {
  const { id, x, y } = args || {};
  const sym = getSymbol(id);
  if (!sym) return { ok: false, reason: "no such symbol" };
  if (!isFiniteNum(x) || !isFiniteNum(y)) {
    return { ok: false, reason: "x,y must be finite" };
  }

  const isOpening = !!CATALOG[sym.type].openings;
  if (isOpening) {
    // Gap B: capture prior position, move, check, restore on failure.
    const prevX = sym.x;
    const prevY = sym.y;
    moveSymbol(sym, x, y);
    if (!openingOnWall(sym, wallSegments(), WALL_ADJ_TOL_M)) {
      moveSymbol(sym, prevX, prevY); // restore
      return {
        ok: false,
        reason:
          `a ${CATALOG[sym.type].label.toLowerCase()} must sit on a wall; ` +
          `place it within 0.15 m of a wall segment (center on the wall line)`,
      };
    }
    return { ok: true, id, clearance: singleClearance(id) };
  }

  moveSymbol(sym, x, y);
  return { ok: true, id, clearance: singleClearance(id) };
}

/**
 * resize_symbol: { id, dim:"w"|"h", metres, lockAspect? }. Clamped; reports change.
 */
export function tool_resize_symbol(args) {
  const { id, dim, metres, lockAspect } = args || {};
  const sym = getSymbol(id);
  if (!sym) return { ok: false, reason: "no such symbol" };
  if (dim !== "w" && dim !== "h") return { ok: false, reason: "dim must be 'w' or 'h'" };
  if (!isFiniteNum(metres)) return { ok: false, reason: "metres must be finite" };

  const isOpening = !!CATALOG[sym.type].openings;
  if (isOpening && dim === "h") {
    return { ok: true, changed: false, hIgnored: true, w: sym.w, h: sym.h, clearance: singleClearance(id) };
  }
  const clamped = clampDim(sym.type, dim, metres) !== metres;
  const changed = resizeSymbol(sym, dim, metres, !!lockAspect);
  return { ok: true, changed, clamped, w: sym.w, h: sym.h, clearance: singleClearance(id) };
}

/** rotate_symbol: { id, deg }. Normalised to [0,360). */
export function tool_rotate_symbol(args) {
  const { id, deg } = args || {};
  const sym = getSymbol(id);
  if (!sym) return { ok: false, reason: "no such symbol" };
  if (!isFiniteNum(deg)) return { ok: false, reason: "deg must be finite" };
  rotateSymbol(sym, deg);
  return { ok: true, id, rot: sym.rot, clearance: singleClearance(id) };
}

/** remove_symbol: { id }. */
export function tool_remove_symbol(args) {
  const { id } = args || {};
  const removed = removeSymbol(id);
  if (!removed) return { ok: false, reason: "no such symbol" };
  return { ok: true, id };
}

/** duplicate_symbol: { id }. */
export function tool_duplicate_symbol(args) {
  const { id } = args || {};
  const dup = duplicateSymbol(id);
  if (!dup) return { ok: false, reason: "no such symbol" };
  return { ok: true, id: dup.id };
}

// ── Evaluators ──────────────────────────────────────────────────────────────

/** get_metrics: per-room { id, areaM2, perimeterM, closed } + totals. */
export function tool_get_metrics() {
  const rooms = wallsModel.rooms.map((r) => {
    const m = roomMetrics(r);
    return { id: r.id, areaM2: m.area, perimeterM: m.perimeter, closed: r.closed };
  });
  const totals = rooms.reduce(
    (acc, r) => ({ areaM2: acc.areaM2 + r.areaM2, perimeterM: acc.perimeterM + r.perimeterM }),
    { areaM2: 0, perimeterM: 0 }
  );
  return { rooms, totals };
}

/**
 * Effective threshold for an evaluator call: explicit override, else brief's
 * minWalkwayM, else MCP_WALKWAY_DEFAULT. Range-checked (M1) against the grounded
 * MCP walkway range — out of range returns a reason instead of a threshold.
 * @returns {{thresholdM:number}|{error:string}}
 */
function resolveThreshold(minWalkwayM) {
  let thr;
  if (minWalkwayM !== undefined) {
    thr = minWalkwayM;
  } else {
    const brief = getBrief();
    thr = brief ? brief.minWalkwayM : MCP_WALKWAY_DEFAULT;
  }
  if (!isFiniteNum(thr) || thr < MCP_WALKWAY_MIN || thr > MCP_WALKWAY_MAX) {
    return { error: WALKWAY_RANGE_MSG };
  }
  return { thresholdM: thr };
}

/**
 * check_clearance: { id?, minWalkwayM? }. Full ClearanceReport (all furniture)
 * or a single subject. Returns { ok:false, reason } for out-of-range walkway.
 */
export function tool_check_clearance(args) {
  const { id, minWalkwayM } = args || {};
  const t = resolveThreshold(minWalkwayM);
  if (t.error) return { ok: false, reason: t.error };
  return buildClearanceReport(world(), t.thresholdM, id, aabb, getSymbol);
}

/** Compact single-symbol clearance readout used by mutators. */
function singleClearance(id) {
  const brief = getBrief();
  // brief.js already guarantees minWalkwayM ∈ [MCP_WALKWAY_MIN, MCP_WALKWAY_MAX] (M1).
  const thr = brief ? brief.minWalkwayM : MCP_WALKWAY_DEFAULT;
  const report = buildClearanceReport(world(), thr, id, aabb, getSymbol);
  const item = report.items[0] || null;
  return {
    thresholdM: report.thresholdM,
    satisfied: report.satisfied,
    worstStatus: report.worstStatus,
    item,
  };
}

/**
 * check_brief: the goal oracle. Combines metrics + clearance against the stored
 * brief. Returns { satisfied, unmet:[…] }.
 */
export function tool_check_brief() {
  const brief = getBrief();
  if (!brief) {
    return { satisfied: false, unmet: ["no brief set — call set_brief first"] };
  }

  const unmet = [];

  // Room-size requirement (M3: bbox + ±0.025 m tolerance, orientation-free).
  if (brief.room) {
    const closed = wallsModel.rooms.filter((r) => r.closed);
    if (closed.length === 0) {
      unmet.push(
        `brief needs a ${brief.room.w}×${brief.room.h} m room; none drawn — ` +
        `rebuild the room to ${brief.room.w}×${brief.room.h} m via new_plan + add_room BEFORE placing furniture`
      );
    } else {
      const room = closed[0];
      const xs = room.verts.map((v) => v.x);
      const ys = room.verts.map((v) => v.y);
      const w = Math.max(...xs) - Math.min(...xs);
      const h = Math.max(...ys) - Math.min(...ys);
      const got = [w, h].sort((a, b) => a - b);
      const want = [brief.room.w, brief.room.h].sort((a, b) => a - b);
      const TOL = 0.025;
      if (Math.abs(got[0] - want[0]) > TOL || Math.abs(got[1] - want[1]) > TOL) {
        unmet.push(
          `room is ${w.toFixed(2)}×${h.toFixed(2)} m; brief asked ` +
          `${brief.room.w}×${brief.room.h} m (±0.025 m) — ` +
          `rebuild the room via new_plan + add_room BEFORE placing furniture`
        );
      }
    }
  }

  // Furniture requirements (by type count).
  const counts = {};
  for (const s of symbolsModel.symbols) {
    counts[s.type] = (counts[s.type] || 0) + 1;
  }
  for (const req of brief.furniture) {
    const have = counts[req.type] || 0;
    if (have < req.count) {
      const need = req.count - have;
      const label = CATALOG[req.type]?.label || req.type;
      unmet.push(
        req.count === 1
          ? `brief needs a ${label.toLowerCase()}; none placed`
          : `brief needs ${req.count} ${label.toLowerCase()}(s); ${need} more to place`
      );
    }
  }

  // Clearance violations (at the brief's walkway).
  const report = buildClearanceReport(world(), brief.minWalkwayM, undefined, aabb, getSymbol);
  for (const v of report.violations) unmet.push(v);

  return { satisfied: unmet.length === 0, unmet };
}
