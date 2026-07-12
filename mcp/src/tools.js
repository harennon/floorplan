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
  moveRoom,
  rescaleRectEdge,
  isRectangle,
  pointNearRoomWall,
  createSymbol,
  addSymbol,
  moveSymbol,
  rotateSymbol,
  resizeSymbol,
  clampDim,
  snapToPreset,
  removeSymbol,
  duplicateSymbol,
  getSymbol,
  aabb,
  pointInRoom,
  CATALOG,
  corners,
  WALL_M,
  MIN_SEG_M,
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

/**
 * Exact-name lookup in CATALOG[type].presets.
 * Returns the matching SymPreset, or null if the type has no presets or no match.
 * @param {string} type
 * @param {string} name
 * @returns {import("../../src/js/symbols.js").SymPreset|null}
 */
function _findPreset(type, name) {
  return CATALOG[type]?.presets?.find(p => p.name === name) ?? null;
}

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
          `call new_plan to start over, or resize_room to resize the existing room instead of adding another`,
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
 * move_room: { roomId, dx, dy }. Rigid translate; carries contained furniture
 * (center ∈ room) and the room's own wall-mounted openings (within WALL_M of a
 * wall). Returns { ok, roomId, metrics, carried:[id…] } or { ok:false, reason }.
 */
export function tool_move_room(args) {
  const { roomId, dx, dy } = args || {};
  const room = wallsModel.rooms.find((r) => r.id === roomId);
  if (!room) return { ok: false, reason: "no such room" };
  if (!isFiniteNum(dx) || !isFiniteNum(dy)) {
    return { ok: false, reason: "dx,dy must be finite" };
  }

  // Snapshot carry membership BEFORE mutating (keeps the mutator synchronous
  // and the carry set stable — mirrors LLD 63 editor decision A1).
  const carried = [];
  for (const sym of symbolsModel.symbols) {
    const isOpening = !!CATALOG[sym.type].openings;
    if (isOpening) {
      // Openings: carried if within WALL_M of a room wall segment (opening
      // center sits ~0.06 m off the wall centerline; pointInRoom unreliable).
      if (pointNearRoomWall(room, sym.x, sym.y, WALL_M)) {
        carried.push(sym.id);
      }
    } else {
      // Furniture: carried if center strictly inside the room polygon.
      if (pointInRoom(room, sym.x, sym.y)) {
        carried.push(sym.id);
      }
    }
  }

  // Apply: translate room verts, then translate each carried symbol.
  moveRoom(room, dx, dy);
  for (const id of carried) {
    const sym = symbolsModel.symbols.find((s) => s.id === id);
    if (sym) moveSymbol(sym, sym.x + dx, sym.y + dy);
  }

  return { ok: true, roomId, metrics: roomMetrics(room), carried };
}

/**
 * resize_room: { roomId, w, h }. Non-destructive rectangle resize (LLD 32 M2 gap).
 * Sets edge 0 → w and edge 1 → h via rescaleRectEdge, anchored at the origin corner.
 * Returns { ok, roomId, newMetrics } or { ok:false, reason } (no such room /
 * not a rectangle / w or h below MIN_SEG_M).
 */
export function tool_resize_room(args) {
  const { roomId, w, h } = args || {};
  const room = wallsModel.rooms.find((r) => r.id === roomId);
  if (!room) return { ok: false, reason: "no such room" };
  if (!isFiniteNum(w) || !isFiniteNum(h) || w <= 0 || h <= 0) {
    return { ok: false, reason: "w and h must be finite positive" };
  }
  if (!isRectangle(room)) {
    return {
      ok: false,
      reason:
        "resize_room only works on rectangular rooms; this room is not a rectangle — rebuild it via new_plan + add_room",
    };
  }
  if (w < MIN_SEG_M || h < MIN_SEG_M) {
    return { ok: false, reason: `w and h must be ≥ ${MIN_SEG_M} m` };
  }
  // Both guards passed; rescaleRectEdge is guaranteed to return true here.
  rescaleRectEdge(room, 0, w);
  rescaleRectEdge(room, 1, h);
  return { ok: true, roomId, newMetrics: roomMetrics(room) };
}

/**
 * place_symbol: { type, x, y, w?, h?, rot?, preset? }. Dims routed through clampDim.
 * Optional preset:"<name>" resolves to {w,h} from CATALOG[type].presets by exact name.
 * Explicit w/h args override the preset per-axis.
 * Returns { ok, id, type, w, h, rot, clamped, hIgnored, presetApplied?, snapped?, clearance }
 * or { ok:false }.
 * For discrete types (bed, fridge, stove, washer), snapped:boolean is included —
 * true when the discrete snap (not clamp) changed the final w/h from the clamped request.
 */
export function tool_place_symbol(args) {
  const { type, x, y, w, h, rot, preset } = args || {};
  if (typeof type !== "string" || !(type in CATALOG)) {
    return { ok: false, reason: "unknown symbol type" };
  }
  if (!isFiniteNum(x) || !isFiniteNum(y)) {
    return { ok: false, reason: "x,y must be finite" };
  }

  // Validate preset arg type before any mutation (Edge Case 15 in LLD)
  if (preset !== undefined && typeof preset !== "string") {
    return { ok: false, reason: "preset must be a string" };
  }

  // Resolve preset → {w,h} if supplied. Fail fast on unknown name.
  let presetApplied = undefined;
  let presetW = undefined;
  let presetH = undefined;
  if (preset !== undefined) {
    const found = _findPreset(type, preset);
    if (!found) {
      const validNames = (CATALOG[type]?.presets ?? []).map(p => p.name);
      const listStr = validNames.length > 0 ? validNames.join(", ") : "(none — this type has no presets)";
      return {
        ok: false,
        reason: `unknown preset '${preset}' for ${type}; valid: ${listStr}`,
      };
    }
    presetW = found.w;
    presetH = found.h;
    presetApplied = found.name;
  }

  const isOpening = !!CATALOG[type].openings;
  const isDiscrete = !!(CATALOG[type].discrete && CATALOG[type].presets);

  const sym = createSymbol(type, x, y);
  // Capture catalog defaults before any resize (used for the snapped baseline below).
  const defaultW = sym.w;
  const defaultH = sym.h;
  let clamped = false;
  let hIgnored = false;

  // Apply preset dims first (if resolved); explicit w/h args below will override per-axis.
  if (presetW !== undefined) resizeSymbol(sym, "w", presetW);
  if (presetH !== undefined && !isOpening) resizeSymbol(sym, "h", presetH);

  // Explicit w overrides the preset's w
  if (w !== undefined) {
    if (!isFiniteNum(w)) return { ok: false, reason: "w must be finite" };
    if (clampDim(type, "w", w) !== w) clamped = true;
    resizeSymbol(sym, "w", w);
  }
  // Explicit h overrides the preset's h
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

  // For discrete types, compute snapped: true when snap (not clamp) changed the dims.
  // The requested dims after clamp are what resizeSymbol would have produced without snap;
  // compare that against the actual snapped result.
  const result = {
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
  if (presetApplied !== undefined) result.presetApplied = presetApplied;
  if (isDiscrete) {
    // Compute what the dims would have been after clamp only (no snap).
    // Per axis the requested dim is: explicit arg → preset dim → catalog default.
    // For specified axes use clampDim(requested); unspecified axes fall back to the
    // preset dim (if a preset was applied) else the catalog default captured before
    // any resize (mirrors the resize_symbol path).
    const reqW = w !== undefined ? w : (presetW !== undefined ? presetW : undefined);
    const reqH = h !== undefined ? h : (presetH !== undefined ? presetH : undefined);
    const clampedW = reqW !== undefined ? clampDim(type, "w", reqW) : defaultW;
    const clampedH = (reqH !== undefined && !isOpening) ? clampDim(type, "h", reqH) : defaultH;
    result.snapped = sym.w !== clampedW || sym.h !== clampedH;
  }
  return result;
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
 * For discrete types (bed, fridge, stove, washer), also reports snapped:boolean —
 * true when the discrete snap (not clamp) changed the final w/h from the clamped request.
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
  const isDiscrete = !!(CATALOG[sym.type].discrete && CATALOG[sym.type].presets);
  const clampedValue = clampDim(sym.type, dim, metres);
  const clamped = clampedValue !== metres;

  // For discrete types, capture the clamped-only dims (what resizeSymbol would have
  // produced without snap) to compute the snapped flag after the call.
  const preW = sym.w;
  const preH = sym.h;
  const changed = resizeSymbol(sym, dim, metres, !!lockAspect);

  const result = { ok: true, changed, clamped, w: sym.w, h: sym.h, clearance: singleClearance(id) };
  if (isDiscrete) {
    // snapped: true when the discrete snap changed dims beyond what clamp alone would give.
    // The clamped-only result for this axis would be clampedValue; the other axis is unchanged.
    const clampOnlyW = dim === "w" ? clampedValue : preW;
    const clampOnlyH = dim === "h" ? clampedValue : preH;
    result.snapped = sym.w !== clampOnlyW || sym.h !== clampOnlyH;
  }
  return result;
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
        `add_room {rect:{x:0,y:0,w:${brief.room.w},h:${brief.room.h}}} BEFORE placing furniture`
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
        const rectOk = isRectangle(room);
        const fix = rectOk
          ? `call resize_room {roomId:"${room.id}", w:${brief.room.w}, h:${brief.room.h}} to fix it non-destructively (no rebuild needed)`
          : `call resize_room {roomId:"${room.id}", w:${brief.room.w}, h:${brief.room.h}} to fix it non-destructively — or if that fails (non-rectangular room), rebuild via new_plan + add_room`;
        unmet.push(
          `room is ${w.toFixed(2)}×${h.toFixed(2)} m; brief asked ` +
          `${brief.room.w}×${brief.room.h} m (±0.025 m) — ` +
          fix
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
