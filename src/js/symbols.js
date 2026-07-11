/**
 * symbols.js — symbol geometry data model and pure geometry functions
 *
 * World coordinates in metres. Rotation in degrees clockwise (screen convention,
 * y-down). Pure, DOM-free, testable — mirrors walls.js structure.
 *
 * Coordinate contract:
 *   x, y = symbol CENTER in world metres
 *   w, h = width (across) and depth, world metres (to scale)
 *   rot  = degrees CW about center; normalised to [0,360)
 */

/** @typedef {"door"|"window"|"bed"|"sofa"|"table"|"chair"|"desk"|"fridge"
 *   |"toilet"|"bathtub"|"sink"|"stove"|"wardrobe"|"bookshelf"|"tv"|"washer"
 *   |"armchair"|"coffee-table"|"dining-table-round"
 *   |"nightstand"|"dresser"|"cabinet"
 *   |"patio-table"|"patio-chair"|"parasol"|"planter"} SymbolType */
/** @typedef {{ id:string, type:SymbolType, x:number, y:number, w:number, h:number, rot:number }} Sym */
/** @typedef {"openings"|"living"|"kitchen"|"bedroom"|"bath"|"outdoor"} SymCategory */

// ── In-memory model ───────────────────────────────────────────────────────────

let _counter = 0;

/**
 * Serializable model — MVP-6 can JSON.stringify(model) directly.
 * Mirrors walls.model.
 */
export const model = { symbols: /** @type {Sym[]} */ ([]) };

// ── Catalog ────────────────────────────────────────────────────────────────────

/**
 * Per-type catalog. openings:true → single editable dimension (width);
 * depth is a fixed thin marker and its chip is hidden. Furniture edits both w and h.
 * @type {Record<SymbolType, {label:string, category:SymCategory,
 *   openings?:boolean, w:number, h:number, min:number, max:number}>}
 */
export const CATALOG = {
  door:      { label: "Door",      category: "openings", openings: true, w: 0.90, h: 0.12, min: 0.60, max: 2.00 },
  window:    { label: "Window",    category: "openings", openings: true, w: 1.00, h: 0.12, min: 0.30, max: 3.00 },
  sofa:      { label: "Sofa",      category: "living",   w: 2.00, h: 0.90, min: 0.30, max: 3.50 },
  table:     { label: "Table",     category: "living",   w: 1.20, h: 0.80, min: 0.30, max: 3.00 },
  chair:     { label: "Chair",     category: "living",   w: 0.50, h: 0.50, min: 0.30, max: 1.00 },
  desk:      { label: "Desk",      category: "living",   w: 1.40, h: 0.70, min: 0.30, max: 2.50 },
  tv:        { label: "TV",        category: "living",   w: 1.20, h: 0.40, min: 0.30, max: 2.50 },
  bookshelf: { label: "Bookshelf", category: "living",   w: 0.80, h: 0.30, min: 0.30, max: 3.00 },
  armchair:            { label: "Armchair",           category: "living", w: 0.80, h: 0.80, min: 0.40, max: 1.20 },
  "coffee-table":      { label: "Coffee Table",       category: "living", w: 1.10, h: 0.55, min: 0.30, max: 2.00 },
  "dining-table-round":{ label: "Round Dining Table", category: "living", w: 1.20, h: 1.20, min: 0.60, max: 2.50 },
  fridge:    { label: "Fridge",    category: "kitchen",  w: 0.70, h: 0.70, min: 0.30, max: 1.20 },
  stove:     { label: "Stove",     category: "kitchen",  w: 0.60, h: 0.60, min: 0.30, max: 1.20 },
  sink:      { label: "Sink",      category: "kitchen",  w: 0.60, h: 0.45, min: 0.30, max: 1.50 },
  washer:    { label: "Washer",    category: "kitchen",  w: 0.60, h: 0.60, min: 0.30, max: 1.00 },
  bed:       { label: "Bed",       category: "bedroom",  w: 1.50, h: 2.00, min: 0.30, max: 2.50 },
  wardrobe:  { label: "Wardrobe",  category: "bedroom",  w: 1.00, h: 0.60, min: 0.30, max: 3.00 },
  nightstand: { label: "Nightstand", category: "bedroom", w: 0.45, h: 0.40, min: 0.30, max: 1.00 },
  dresser:    { label: "Dresser",    category: "bedroom", w: 1.00, h: 0.50, min: 0.30, max: 2.50 },
  cabinet:    { label: "Cabinet",    category: "bedroom", w: 0.90, h: 0.40, min: 0.30, max: 2.50 },
  toilet:    { label: "Toilet",    category: "bath",     w: 0.40, h: 0.70, min: 0.30, max: 1.00 },
  bathtub:   { label: "Bathtub",   category: "bath",     w: 1.70, h: 0.75, min: 0.30, max: 2.20 },
  "patio-table": { label: "Patio Table", category: "outdoor", w: 0.90, h: 0.90, min: 0.40, max: 2.00 },
  "patio-chair": { label: "Patio Chair", category: "outdoor", w: 0.65, h: 0.70, min: 0.40, max: 1.10 },
  parasol:       { label: "Parasol",     category: "outdoor", w: 2.00, h: 2.00, min: 0.90, max: 3.50 },
  planter:       { label: "Planter",     category: "outdoor", w: 0.50, h: 0.50, min: 0.20, max: 1.50 },
};

// ── CRUD ───────────────────────────────────────────────────────────────────────

/**
 * Create a symbol from catalog defaults at world center (x,y).
 * Assigns id `s<n>`. Does NOT add to model.
 * @param {SymbolType} type
 * @param {number} x  world metres
 * @param {number} y  world metres
 * @returns {Sym}
 */
export function createSymbol(type, x, y) {
  const cat = CATALOG[type];
  if (!cat) throw new Error(`Unknown symbol type: ${type}`);
  return {
    id: `s${_counter++}`,
    type,
    x,
    y,
    w: cat.w,
    h: cat.h,
    rot: 0,
  };
}

/**
 * Add a fully-formed Sym to the model. Returns it.
 * @param {Sym} sym
 * @returns {Sym}
 */
export function addSymbol(sym) {
  model.symbols.push(sym);
  return sym;
}

/**
 * Remove by id. No-op if absent. Returns boolean.
 * @param {string} id
 * @returns {boolean}
 */
export function removeSymbol(id) {
  const idx = model.symbols.findIndex(s => s.id === id);
  if (idx === -1) return false;
  model.symbols.splice(idx, 1);
  return true;
}

/**
 * Duplicate by id, offset by +0.3m x/y, new id. Returns new Sym or null.
 * @param {string} id
 * @returns {Sym|null}
 */
export function duplicateSymbol(id) {
  const sym = getSymbol(id);
  if (!sym) return null;
  const dup = {
    id: `s${_counter++}`,
    type: sym.type,
    x: sym.x + 0.3,
    y: sym.y + 0.3,
    w: sym.w,
    h: sym.h,
    rot: sym.rot,
  };
  model.symbols.push(dup);
  return dup;
}

/**
 * Find by id. Returns the Sym or null.
 * @param {string} id
 * @returns {Sym|null}
 */
export function getSymbol(id) {
  return model.symbols.find(s => s.id === id) || null;
}

// ── Geometry ───────────────────────────────────────────────────────────────────

/**
 * Point-in-symbol hit test in world metres, honouring rotation.
 *
 * Transforms the world point into the symbol's local (un-rotated) frame and
 * tests the w×h box inflated by tolWorld metres on every side.
 * tolWorld defaults to 0 (exact box).
 *
 * @param {Sym} sym
 * @param {number} wx  world x
 * @param {number} wy  world y
 * @param {number} [tolWorld=0]  box inflation, metres
 * @returns {boolean}
 */
export function hitTest(sym, wx, wy, tolWorld = 0) {
  // Translate to symbol-center-relative coords
  const lx = wx - sym.x;
  const ly = wy - sym.y;

  // Inverse CW rotation (rotate CCW by sym.rot) to get local frame coords.
  // CW rotation: x' = x*cos - y*sin, y' = x*sin + y*cos
  // Inverse:     rx = lx*cos + ly*sin, ry = -lx*sin + ly*cos
  const rad = (sym.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rx = lx * cos + ly * sin;
  const ry = -lx * sin + ly * cos;

  return Math.abs(rx) <= sym.w / 2 + tolWorld
      && Math.abs(ry) <= sym.h / 2 + tolWorld;
}

/**
 * Topmost symbol at world point (last in array wins = drawn last = on top),
 * or null. tolWorld (metres) is forwarded to hitTest.
 * @param {number} wx
 * @param {number} wy
 * @param {number} [tolWorld=0]
 * @returns {Sym|null}
 */
export function pickSymbol(wx, wy, tolWorld = 0) {
  for (let i = model.symbols.length - 1; i >= 0; i--) {
    if (hitTest(model.symbols[i], wx, wy, tolWorld)) {
      return model.symbols[i];
    }
  }
  return null;
}

/**
 * Clamp a dimension value to the type's [min, max].
 * @param {SymbolType} type
 * @param {number} metres
 * @returns {number}
 */
export function clampDim(type, metres) {
  const cat = CATALOG[type];
  if (!cat) return metres;
  return Math.min(cat.max, Math.max(cat.min, metres));
}

/**
 * Set width or depth (metres), clamped to type range.
 * lockAspect scales the other dimension to preserve w:h ratio; each result is
 * independently clamped — if a clamp would break the ratio, the edited dim wins.
 * Openings ignore dim="h". Mutates sym. Returns boolean (changed).
 * @param {Sym} sym
 * @param {"w"|"h"} dim
 * @param {number} metres
 * @param {boolean} [lockAspect=false]
 * @returns {boolean}
 */
export function resizeSymbol(sym, dim, metres, lockAspect = false) {
  // Openings ignore "h"
  if (CATALOG[sym.type]?.openings && dim === "h") return false;

  const clamped = clampDim(sym.type, metres);

  if (lockAspect) {
    if (dim === "w") {
      const ratio = sym.w > 0 ? sym.h / sym.w : 1;
      sym.w = clamped;
      sym.h = clampDim(sym.type, clamped * ratio);
    } else {
      const ratio = sym.h > 0 ? sym.w / sym.h : 1;
      sym.h = clamped;
      sym.w = clampDim(sym.type, clamped * ratio);
    }
    return true;
  }

  if (dim === "w") {
    const changed = sym.w !== clamped;
    sym.w = clamped;
    return changed;
  } else {
    const changed = sym.h !== clamped;
    sym.h = clamped;
    return changed;
  }
}

/**
 * Move center to world (x, y). Mutates.
 * @param {Sym} sym
 * @param {number} x
 * @param {number} y
 */
export function moveSymbol(sym, x, y) {
  sym.x = x;
  sym.y = y;
}

/**
 * Set rotation degrees (normalised to [0, 360)). Mutates.
 * @param {Sym} sym
 * @param {number} deg
 */
export function rotateSymbol(sym, deg) {
  sym.rot = ((deg % 360) + 360) % 360;
}

// ── Wall-flush snapping (LLD 26) ─────────────────────────────────────────────

/** Screen-px flush threshold, converted to metres by the caller before use. */
export const WALL_FLUSH_PX = 12;

/** Angle tolerance (degrees) for treating symbol axes as parallel to a wall. */
export const PARALLEL_TOL_DEG = 12;

/**
 * @typedef {{
 *   dx:number, dy:number,
 *   gap:number,
 *   guide:{ a:{x:number,y:number}, b:{x:number,y:number} }
 * }} FlushCandidate
 */

/**
 * Find the nearest wall face the symbol's near edge can seat flush against.
 *
 * Pure: does not read global state; all inputs injected.
 *
 * Algorithm:
 *   For each segment [{a,b}] and each wall face (±WALL_M/2 perpendicular
 *   offsets), we:
 *     1. Check angle between the symbol's local x-axis and the segment
 *        direction is within PARALLEL_TOL_DEG.
 *     2. Check the symbol's projection onto the segment direction overlaps the
 *        segment's own span.
 *     3. Compute the signed gap between the symbol's nearest edge and the face.
 *     4. If |gap| <= thresholdM, record it as a candidate.
 *   Return the candidate with the smallest |gap|, or null.
 *
 * @param {{ x:number,y:number }[]} corners4  four world-space corners [TL,TR,BR,BL]
 * @param {{ a:{x:number,y:number}, b:{x:number,y:number} }[]} segments
 * @param {number} wallM     wall thickness in metres (for face offset)
 * @param {number} thresholdM  flush distance threshold in world metres
 * @param {number} parallelTolDeg  angle tolerance in degrees
 * @returns {FlushCandidate|null}
 */
export function nearestWallFlush(corners4, segments, wallM, thresholdM, parallelTolDeg) {
  const tolRad = (parallelTolDeg * Math.PI) / 180;
  const halfWall = wallM / 2;

  let bestGapAbs = Infinity;
  let best = null;

  for (const seg of segments) {
    const ax = seg.a.x, ay = seg.a.y;
    const bx = seg.b.x, by = seg.b.y;
    const segDx = bx - ax;
    const segDy = by - ay;
    const segLen = Math.sqrt(segDx * segDx + segDy * segDy);
    if (segLen < 1e-9) continue; // degenerate

    // Unit direction along the segment (t) and unit normal (n) — n points 90° CW
    const tx = segDx / segLen;
    const ty = segDy / segLen;
    const nx = ty;   // 90° CW in y-down screen coords: rotate (tx,ty) CW → (ty,-tx)
    const ny = -tx;

    // For each corner, project onto t to get the symbol's span along the segment
    // and onto n to find the near-face offset.
    // Project each corner onto t (relative to seg.a) to find symbol's t-span
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

    // Segment's t-span is [0, segLen] (by construction)
    const segTMin = 0;
    const segTMax = segLen;

    // t-span overlap check: the symbol's footprint along the wall must overlap
    const overlapMin = Math.max(symTMin, segTMin);
    const overlapMax = Math.min(symTMax, segTMax);
    if (overlapMax <= overlapMin) continue;

    // Parallel check: either the symbol's local x-axis (TL→TR) or its local y-axis
    // (TL→BL) must be within parallelTolDeg of the wall direction.
    // We check both axes so that both horizontal and vertical symbols match both
    // horizontal and vertical walls.
    const symXX = corners4[1].x - corners4[0].x;
    const symXY = corners4[1].y - corners4[0].y;
    const symXLen = Math.sqrt(symXX * symXX + symXY * symXY);
    if (symXLen < 1e-9) continue;
    const symYX = corners4[3].x - corners4[0].x;  // TL→BL
    const symYY = corners4[3].y - corners4[0].y;
    const symYLen = Math.sqrt(symYX * symYX + symYY * symYY);

    const cosAngleX = Math.abs((symXX * tx + symXY * ty) / symXLen);
    const cosAngleY = symYLen > 1e-9 ? Math.abs((symYX * tx + symYY * ty) / symYLen) : 0;
    // Parallel if either axis is within tolerance of the wall direction
    const cosThresh = Math.cos(tolRad);
    if (cosAngleX < cosThresh && cosAngleY < cosThresh) continue;

    // Two wall faces: at n = +halfWall (face in +n direction) and n = -halfWall
    for (const faceN of [halfWall, -halfWall]) {
      // gap = distance from the nearest symbol edge in the n direction to the face
      // If gap > 0: symbol is on the positive side of the face (needs to move -n)
      // If gap < 0: symbol is on the negative side (needs to move +n)
      // Pick the symbol's edge (symNMin or symNMax) that is CLOSEST to this face.
      // For a symbol entirely on the positive-n side, symNMin is closer to faceN=+halfWall.
      // For a symbol entirely on the negative-n side, symNMax is closer to faceN=-halfWall.
      const nearEdgeN = Math.abs(symNMin - faceN) <= Math.abs(symNMax - faceN)
        ? symNMin : symNMax;
      const gap = nearEdgeN - faceN;
      const gapAbs = Math.abs(gap);
      if (gapAbs <= thresholdM && gapAbs < bestGapAbs) {
        bestGapAbs = gapAbs;
        // Translation to seat flush: move by -gap along n
        const dx = -gap * nx;
        const dy = -gap * ny;

        // Guide segment: along the wall face at faceN offset, from symTMin..symTMax
        // (clamped to segment t-span)
        const guideT0 = Math.max(symTMin, segTMin);
        const guideT1 = Math.min(symTMax, segTMax);
        const guideA = {
          x: ax + guideT0 * tx + faceN * nx,
          y: ay + guideT0 * ty + faceN * ny,
        };
        const guideB = {
          x: ax + guideT1 * tx + faceN * nx,
          y: ay + guideT1 * ty + faceN * ny,
        };
        best = { dx, dy, gap, guide: { a: guideA, b: guideB } };
      }
    }
  }

  return best;
}

// ── Object alignment snapping (LLD 34) ───────────────────────────────────────

/** Screen-px alignment threshold for same-side edge + center matches; converted
 *  to metres by the caller before use. */
export const ALIGN_PX = 8;

/** Screen-px threshold for FACING-edge (contact / place-beside) alignment; wider than
 *  ALIGN_PX so "make two pieces touch" is easier to hit. Converted to metres by caller.
 *  Kept < WALL_FLUSH_PX (12) so a nearby wall still wins a contested axis by feel. */
export const ALIGN_CONTACT_PX = 11;

/** Screen-px room-center threshold; converted to metres by the caller before use. */
export const ROOM_CENTER_PX = 8;

/**
 * @typedef {{
 *   delta: number,
 *   line: number,
 *   kind: "edge"|"center"|"room-center",
 *   guide: { a: {x:number,y:number}, b: {x:number,y:number} },
 *   center?: { x:number, y:number },
 *   facing?: boolean
 * }} AlignAxisMatch
 *
 * @typedef {{ x: AlignAxisMatch|null, y: AlignAxisMatch|null }} AlignResult
 */

/**
 * Compute the world-axis-aligned bounding box (AABB) of a symbol from its
 * rotated corners. Returns { minX, maxX, cx, minY, maxY, cy }.
 *
 * @param {Sym} sym
 * @returns {{ minX:number, maxX:number, cx:number, minY:number, maxY:number, cy:number }}
 */
export function aabb(sym) {
  const cs = corners(sym);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of cs) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }
  return { minX, maxX, cx: (minX + maxX) / 2, minY, maxY, cy: (minY + maxY) / 2 };
}

// Tiny epsilon for floating-point tie comparisons (avoids FP equality issues).
const TIE_EPS = 1e-9;

/**
 * Best in-threshold X-axis match of the dragged AABB against ONE candidate.
 *
 * Scans the 3×3 reference/line index pairs (0=min, 1=max, 2=center). A pair is
 * a *facing* (contact / place-beside) pair iff it is drag.max↔cand.min (1,0) or
 * drag.min↔cand.max (0,1) — those use `contactThresholdM`; every other pair uses
 * `edgeThresholdM`. Within the candidate, prefers the smaller |gap|; on a tie
 * prefers a center match, then first-seen. Returns the AlignAxisMatch or null.
 *
 * @param {{ minX:number, maxX:number, cx:number, minY:number, maxY:number, cy:number }} dragAABB
 * @param {{ minX:number, maxX:number, cx:number, minY:number, maxY:number, cy:number }} cand
 * @param {number} edgeThresholdM
 * @param {number} contactThresholdM
 * @returns {AlignAxisMatch|null}
 */
function _bestAxisMatchX(dragAABB, cand, edgeThresholdM, contactThresholdM) {
  const dragRefs = [dragAABB.minX, dragAABB.maxX, dragAABB.cx];
  const candLines = [cand.minX, cand.maxX, cand.cx];
  /** @type {AlignAxisMatch|null} */
  let best = null;
  let bestGapAbs = Infinity;

  for (let ri = 0; ri < dragRefs.length; ri++) {
    for (let ci = 0; ci < candLines.length; ci++) {
      const gap = candLines[ci] - dragRefs[ri];
      const gapAbs = Math.abs(gap);
      // Facing (contact) pair gets the wider threshold; all others the edge threshold.
      const facing = (ri === 1 && ci === 0) || (ri === 0 && ci === 1);
      const threshold = facing ? contactThresholdM : edgeThresholdM;
      if (gapAbs > threshold) continue;

      const isCenterMatch = ri === 2 && ci === 2;
      const existingIsCenterMatch = best !== null && best.kind === "center";
      const strictlyBetter = gapAbs < bestGapAbs - TIE_EPS;
      const tieAndCenter = gapAbs <= bestGapAbs + TIE_EPS && isCenterMatch && !existingIsCenterMatch;
      if (strictlyBetter || tieAndCenter) {
        bestGapAbs = gapAbs;
        const kind = isCenterMatch ? "center" : "edge";
        // Vertical guide spanning both symbols' Y extents
        const guideMinY = Math.min(dragAABB.minY, cand.minY);
        const guideMaxY = Math.max(dragAABB.maxY, cand.maxY);
        const lineX = candLines[ci];
        best = {
          delta: gap,
          line: lineX,
          kind,
          guide: {
            a: { x: lineX, y: guideMinY },
            b: { x: lineX, y: guideMaxY },
          },
          facing,
        };
      }
    }
  }
  return best;
}

/**
 * Best in-threshold Y-axis match of the dragged AABB against ONE candidate.
 * Mirror of `_bestAxisMatchX` on the Y axis (facing pairs, tie rule identical).
 *
 * @param {{ minX:number, maxX:number, cx:number, minY:number, maxY:number, cy:number }} dragAABB
 * @param {{ minX:number, maxX:number, cx:number, minY:number, maxY:number, cy:number }} cand
 * @param {number} edgeThresholdM
 * @param {number} contactThresholdM
 * @returns {AlignAxisMatch|null}
 */
function _bestAxisMatchY(dragAABB, cand, edgeThresholdM, contactThresholdM) {
  const dragRefs = [dragAABB.minY, dragAABB.maxY, dragAABB.cy];
  const candLines = [cand.minY, cand.maxY, cand.cy];
  /** @type {AlignAxisMatch|null} */
  let best = null;
  let bestGapAbs = Infinity;

  for (let ri = 0; ri < dragRefs.length; ri++) {
    for (let ci = 0; ci < candLines.length; ci++) {
      const gap = candLines[ci] - dragRefs[ri];
      const gapAbs = Math.abs(gap);
      const facing = (ri === 1 && ci === 0) || (ri === 0 && ci === 1);
      const threshold = facing ? contactThresholdM : edgeThresholdM;
      if (gapAbs > threshold) continue;

      const isCenterMatch = ri === 2 && ci === 2;
      const existingIsCenterMatch = best !== null && best.kind === "center";
      const strictlyBetter = gapAbs < bestGapAbs - TIE_EPS;
      const tieAndCenter = gapAbs <= bestGapAbs + TIE_EPS && isCenterMatch && !existingIsCenterMatch;
      if (strictlyBetter || tieAndCenter) {
        bestGapAbs = gapAbs;
        const kind = isCenterMatch ? "center" : "edge";
        // Horizontal guide spanning both symbols' X extents
        const guideMinX = Math.min(dragAABB.minX, cand.minX);
        const guideMaxX = Math.max(dragAABB.maxX, cand.maxX);
        const lineY = candLines[ci];
        best = {
          delta: gap,
          line: lineY,
          kind,
          guide: {
            a: { x: guideMinX, y: lineY },
            b: { x: guideMaxX, y: lineY },
          },
          facing,
        };
      }
    }
  }
  return best;
}

/**
 * Find the nearest per-axis alignment of a dragged symbol's AABB to any
 * candidate AABB.
 *
 * Pure: no global reads.
 *
 * Coherent-corner model (LLD 60 Defect 1): rather than picking bestX and bestY
 * independently across all candidates (which let X snap to one neighbour and Y
 * to another — a "phantom corner" belonging to no object), this computes each
 * candidate's OWN best X and Y match, then selects a single "primary" candidate
 * and emits ONLY its two axes. Both applied axes therefore always originate from
 * one object; when the primary matches both axes the crossing guides form a real
 * corner. Removing simultaneous two-object alignment is a deliberate simplicity
 * tradeoff, not solely a bug fix — a corner now means exactly one neighbour.
 *
 * Primary-candidate comparator (deterministic):
 *   1. Smaller `bestAxisGap` = min(|mx.delta|, |my.delta|) over the candidate's
 *      non-null axis matches — the object the drag is most clearly aligning to.
 *   2. Tie within TIE_EPS: the candidate matching BOTH axes wins (corner-affinity),
 *      without overriding a clearly-tighter single-edge alignment.
 *   3. Further tie: more center matches, then first-seen.
 *
 * Two-tier threshold (LLD 60 Defect 2): facing-edge (contact / place-beside)
 * pairs use the wider `contactThresholdM`; same-side edge, center, and edge↔center
 * pairs use `edgeThresholdM`. `contactThresholdM` defaults to `edgeThresholdM` so
 * every pre-existing three-arg caller keeps its single-window behaviour.
 *
 * @param {{ minX:number, maxX:number, cx:number, minY:number, maxY:number, cy:number }} dragAABB
 * @param {{ minX:number, maxX:number, cx:number, minY:number, maxY:number, cy:number }[]} candidates
 * @param {number} edgeThresholdM  gates same-side edge, center, edge↔center pairs
 * @param {number} [contactThresholdM=edgeThresholdM]  gates facing-edge (contact) pairs
 * @returns {AlignResult}
 */
export function nearestObjectAlignment(dragAABB, candidates, edgeThresholdM, contactThresholdM = edgeThresholdM) {
  /** @type {AlignAxisMatch|null} */
  let primaryX = null;
  /** @type {AlignAxisMatch|null} */
  let primaryY = null;
  let primaryBestAxisGap = Infinity;
  let primaryBothAxes = false;
  let primaryCenterCount = -1;

  for (const cand of candidates) {
    const mx = _bestAxisMatchX(dragAABB, cand, edgeThresholdM, contactThresholdM);
    const my = _bestAxisMatchY(dragAABB, cand, edgeThresholdM, contactThresholdM);
    if (mx === null && my === null) continue; // candidate matches nothing in range

    // The gap of the axis this candidate aligns to most clearly.
    let bestAxisGap = Infinity;
    if (mx !== null) bestAxisGap = Math.min(bestAxisGap, Math.abs(mx.delta));
    if (my !== null) bestAxisGap = Math.min(bestAxisGap, Math.abs(my.delta));
    const bothAxes = mx !== null && my !== null;
    const centerCount = (mx !== null && mx.kind === "center" ? 1 : 0)
                      + (my !== null && my.kind === "center" ? 1 : 0);

    // Compare against the current primary (comparator rules above; first-seen keeps).
    let better;
    if (primaryX === null && primaryY === null) {
      better = true;
    } else if (bestAxisGap < primaryBestAxisGap - TIE_EPS) {
      better = true;                                   // rule 1: strictly tighter
    } else if (bestAxisGap > primaryBestAxisGap + TIE_EPS) {
      better = false;
    } else if (bothAxes !== primaryBothAxes) {
      better = bothAxes;                               // rule 2: corner-affinity on tie
    } else if (centerCount !== primaryCenterCount) {
      better = centerCount > primaryCenterCount;       // rule 3: more center matches
    } else {
      better = false;                                  // rule 3b: first-seen keeps
    }

    if (better) {
      primaryX = mx;
      primaryY = my;
      primaryBestAxisGap = bestAxisGap;
      primaryBothAxes = bothAxes;
      primaryCenterCount = centerCount;
    }
  }

  return { x: primaryX, y: primaryY };
}

// ── Room-center snapping (LLD 37) ─────────────────────────────────────────────

/**
 * Snap the dragged AABB CENTER to a SINGLE room's centroid / mid-lines.
 *
 * Selects one target room (min dx²+dy² among rooms with at least one axis in
 * threshold; ties first-seen), then emits x and/or y matches from THAT room only,
 * so both returned axes share one centroid (ring marker is unambiguous, full snap
 * lands exactly on the centroid). Pure: no global reads. Only cx/cy of the drag
 * AABB participate (center-only snap).
 *
 * @param {{ minX:number, maxX:number, cx:number, minY:number, maxY:number, cy:number }} dragAABB
 * @param {{ cx:number, cy:number }[]} roomCenters
 * @param {number} thresholdM
 * @returns {AlignResult}   // { x:AlignAxisMatch|null, y:... }; both from same room
 */
export function nearestRoomCenter(dragAABB, roomCenters, thresholdM) {
  // Find the eligible room with the smallest dx²+dy² from the drag center
  let bestRoom = null;
  let bestDistSq = Infinity;

  for (const rc of roomCenters) {
    const dx = rc.cx - dragAABB.cx;
    const dy = rc.cy - dragAABB.cy;
    // A room is eligible if at least one axis is within threshold
    if (Math.abs(dx) > thresholdM && Math.abs(dy) > thresholdM) continue;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestRoom = rc;
    }
  }

  if (bestRoom === null) {
    return { x: null, y: null };
  }

  // From the chosen room only, emit matches for in-range axes
  const dx = bestRoom.cx - dragAABB.cx;
  const dy = bestRoom.cy - dragAABB.cy;
  const centerPt = { x: bestRoom.cx, y: bestRoom.cy };

  let xMatch = null;
  if (Math.abs(dx) <= thresholdM) {
    // Vertical guide at x = room.cx, spanning y ∈ [min(dragAABB.minY, room.cy), max(dragAABB.maxY, room.cy)]
    const guideMinY = Math.min(dragAABB.minY, bestRoom.cy);
    const guideMaxY = Math.max(dragAABB.maxY, bestRoom.cy);
    xMatch = {
      delta: dx,
      line: bestRoom.cx,
      kind: "room-center",
      guide: {
        a: { x: bestRoom.cx, y: guideMinY },
        b: { x: bestRoom.cx, y: guideMaxY },
      },
      center: centerPt,
    };
  }

  let yMatch = null;
  if (Math.abs(dy) <= thresholdM) {
    // Horizontal guide at y = room.cy, spanning x ∈ [min(dragAABB.minX, room.cx), max(dragAABB.maxX, room.cx)]
    const guideMinX = Math.min(dragAABB.minX, bestRoom.cx);
    const guideMaxX = Math.max(dragAABB.maxX, bestRoom.cx);
    yMatch = {
      delta: dy,
      line: bestRoom.cy,
      kind: "room-center",
      guide: {
        a: { x: guideMinX, y: bestRoom.cy },
        b: { x: guideMaxX, y: bestRoom.cy },
      },
      center: centerPt,
    };
  }

  return { x: xMatch, y: yMatch };
}

// ── Hydrate (LLD 16) ─────────────────────────────────────────────────────────

/**
 * Replace symbols array IN PLACE (same array identity) and re-sync _counter
 * past the max s<n> id so the next createSymbol doesn't collide.
 * @param {{ symbols: Sym[] }} next
 */
export function hydrate(next) {
  model.symbols.splice(0, model.symbols.length, ...next.symbols);

  let maxId = -1;
  for (const s of model.symbols) {
    const m = typeof s.id === "string" ? s.id.match(/^s(\d+)$/) : null;
    if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
  }
  _counter = maxId + 1;
}

/**
 * Four world-space corners of the rotated box, order TL, TR, BR, BL (local frame).
 * Used by render + chip placement.
 * @param {Sym} sym
 * @returns {{ x:number, y:number }[]}
 */
export function corners(sym) {
  const rad = (sym.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = sym.w / 2;
  const hh = sym.h / 2;

  // Local frame corners: TL=(-hw,-hh), TR=(hw,-hh), BR=(hw,hh), BL=(-hw,hh)
  // CW rotation in screen (y-down): x' = lx*cos - ly*sin, y' = lx*sin + ly*cos
  return [
    { x: sym.x + (-hw) * cos - (-hh) * sin, y: sym.y + (-hw) * sin + (-hh) * cos }, // TL
    { x: sym.x + ( hw) * cos - (-hh) * sin, y: sym.y + ( hw) * sin + (-hh) * cos }, // TR
    { x: sym.x + ( hw) * cos - ( hh) * sin, y: sym.y + ( hw) * sin + ( hh) * cos }, // BR
    { x: sym.x + (-hw) * cos - ( hh) * sin, y: sym.y + (-hw) * sin + ( hh) * cos }, // BL
  ];
}
