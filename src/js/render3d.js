/**
 * render3d.js — true 3D WebGL preview via three.js, orbit camera (LLD 130)
 *
 * Phase 2 of the 3D-preview feature (#101): replaces the 2.5D isometric SVG
 * painter (LLD 128) behind the SAME #tool-preview toggle with a real
 * PerspectiveCamera + OrbitControls WebGL scene. three.js is npm-installed,
 * version-locked, and LAZY-LOADED (dynamic import on first preview entry) so
 * the default editor load is unaffected.
 *
 * Architecture — a pure/impure split mirroring isoRender.js:
 *
 *  - Pure (NO three.js import, headless unit-testable):
 *      buildSceneDescriptors(items, wallsModel, floorColor) → { descriptors, bounds }
 *      worldToScene(wx, wy, wz) → { x, y, z }   (the single y-down→y-up map)
 *      webglAvailable(canvasOrFactory?) → boolean
 *
 *  - Impure (DOM + lazily-imported three.js):
 *      initRender3d, enter, exit, frame, resize, dispose
 *
 * The 3D data source is REUSED from isoRender.js: buildItems() (extrusion
 * items), toOpaqueRgb, CEILING_M. The hand-rolled 2.5D machinery
 * (extrudeFootprint/depthSort/shade/worldToScreenIso) is NOT reused — WebGL's
 * depth buffer + real lighting replace it. isoRender.render() stays as the
 * WebGL-unavailable fallback painter (wired in main.js).
 *
 * Read-only: the preview never mutates walls.model / symbols.model. Camera
 * state lives entirely in three.js objects and is session-only (not persisted).
 */

import { buildItems, toOpaqueRgb, CEILING_M } from "./isoRender.js";
import { palette } from "./theme.js";
import { CATALOG, corners } from "./symbols.js";
import { WALL_M } from "./walls.js";
import { symbolBelongsToRoom } from "./clearance.js";
import { getScope } from "./preview.js";

// ── Pure geometry core (no DOM, no three.js) ────────────────────────────────

/**
 * @typedef {{
 *   kind: "wall"|"furniture"|"rug"|"floor"|"opening",
 *   footprint: {x:number,y:number}[],  // world-metre polygon (convex)
 *   z0: number,                        // base height (m)
 *   z1: number,                        // top height (m); ≈ z0 for flat items
 *   color: string,                     // opaque rgb()/hex (from buildItems.baseColor)
 *   flat: boolean,                     // true → ShapeGeometry on ground (rug/floor)
 *   translucent?: boolean              // opening reveal pane → translucent/lighter material
 * }} MeshDescriptor
 */

/**
 * @typedef {{
 *   minX:number, minY:number, maxX:number, maxY:number,  // world XY (plan footprint)
 *   minZ:number, maxZ:number                             // height range (m)
 * } | null} SceneBounds
 */

/**
 * Signed area (shoelace) of a polygon. Sign encodes winding; magnitude the
 * area. Winding-independent callers use the absolute value.
 * @param {{x:number,y:number}[]} poly
 * @returns {number}
 */
function _signedArea(poly) {
  let a = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** True if a footprint is renderable (>=3 corners, non-degenerate area). */
function _isRenderable(footprint) {
  if (!footprint || footprint.length < 3) return false;
  return Math.abs(_signedArea(footprint)) > 1e-9;
}

// ── Opening geometry helpers (pure, LLD 142) ────────────────────────────────

/**
 * Merge overlapping/adjacent 1-D intervals. Returns sorted, non-overlapping
 * intervals. Intervals are [t0, t1] with t0 <= t1.
 * @param {[number,number][]} spans
 * @returns {[number,number][]}
 */
function _mergeSpans(spans) {
  if (spans.length === 0) return [];
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1]) {
      last[1] = Math.max(last[1], sorted[i][1]);
    } else {
      merged.push(sorted[i].slice());
    }
  }
  return merged;
}

/**
 * Build a rectangular wall-segment footprint from a 1-D along-span [t0,t1] on
 * an edge, given the edge's unit along-vector (tx,ty) and unit normal (nx,ny),
 * edge start (ax,ay), and wall half-thickness. Returns 4 world-metre corners.
 * @returns {{x:number,y:number}[]}
 */
function _wallSegFootprint(ax, ay, tx, ty, nx, ny, t0, t1, halfWall) {
  return [
    { x: ax + t0 * tx + halfWall * nx, y: ay + t0 * ty + halfWall * ny },
    { x: ax + t1 * tx + halfWall * nx, y: ay + t1 * ty + halfWall * ny },
    { x: ax + t1 * tx - halfWall * nx, y: ay + t1 * ty - halfWall * ny },
    { x: ax + t0 * tx - halfWall * nx, y: ay + t0 * ty - halfWall * ny },
  ];
}

/**
 * Split a wall edge hosting openings into pier/lintel/sill boxes + window
 * reveal panes. Pure; returns MeshDescriptor fragments.
 *
 * For each opening on this edge:
 *  - A door ([0, head]) leaves the band completely open: no geometry in [0,head]
 *    over the opening width. Only a lintel above [head, CEILING_M].
 *  - A window ([sill, head]) adds a sill wall [0,sill], a lintel [head,CEILING_M],
 *    and a translucent reveal pane at [sill,head].
 *
 * Pier segments (wall at full height between openings) are emitted for the
 * complementary spans on the edge.
 *
 * Edge Cases handled:
 *  - Spans are clipped to [0, edgeLen]; zero-width pier segments are dropped.
 *  - Overlapping openings: spans are merged before splitting (Edge Case 4).
 *  - window sill >= head: skip the band cut (degenerate, Edge Case 6).
 *  - head > CEILING_M: no lintel (clamp to zero, Edge Case 6).
 *
 * @param {{a:{x:number,y:number},b:{x:number,y:number}}} edge  wall centerline
 * @param {{sill:number,head:number,along:[number,number],isDoor:boolean,color:string}[]} openings
 * @param {number} ceilingM
 * @param {string} wallColor
 * @returns {MeshDescriptor[]}
 */
export function _splitWallForOpenings(edge, openings, ceilingM, wallColor) {
  const { a, b } = edge;
  const edgeDx = b.x - a.x;
  const edgeDy = b.y - a.y;
  const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
  if (edgeLen < 1e-9) return [];

  const tx = edgeDx / edgeLen;
  const ty = edgeDy / edgeLen;
  const nx = -ty;  // one normal direction; both sides of wall use +/- halfWall
  const ny = tx;
  const halfWall = WALL_M / 2;

  /** @type {MeshDescriptor[]} */
  const out = [];

  // Filter to valid openings and clip along-spans to [0, edgeLen]
  /** @type {{sill:number,head:number,along:[number,number],isDoor:boolean,color:string}[]} */
  const valid = [];
  for (const op of openings) {
    const t0 = Math.max(0, op.along[0]);
    const t1 = Math.min(edgeLen, op.along[1]);
    if (t1 <= t0) continue; // clipped to zero width → skip
    // Degenerate guard: sill >= head (Edge Case 6)
    if (op.sill >= op.head) continue;
    valid.push({ ...op, along: [t0, t1] });
  }

  if (valid.length === 0) {
    // No valid openings: emit the edge as a single full-height wall piece
    const fp = _wallSegFootprint(a.x, a.y, tx, ty, nx, ny, 0, edgeLen, halfWall);
    if (_isRenderable(fp)) {
      out.push({ kind: "wall", footprint: fp, z0: 0, z1: ceilingM, color: wallColor, flat: false });
    }
    return out;
  }

  // Merge opening along-spans to avoid overlapping pier/lintel geometry
  const openingSpans = _mergeSpans(valid.map(op => [op.along[0], op.along[1]]));

  // Build a list of opening data indexed by merged span — carry per-opening info
  // for the merged span (when multiple openings merge, use the one with the larger
  // extent; in practice openings rarely overlap, so the first valid one wins)
  /** @type {Map<string, {sill:number,head:number,isDoor:boolean,color:string}>} */
  const spanInfo = new Map();
  for (const ms of openingSpans) {
    const key = `${ms[0]},${ms[1]}`;
    // Find the valid opening whose span overlaps this merged span; prefer the one
    // that contributed most to it (first matching is sufficient for v1)
    for (const op of valid) {
      if (op.along[0] <= ms[1] && op.along[1] >= ms[0]) {
        spanInfo.set(key, { sill: op.sill, head: op.head, isDoor: op.isDoor, color: op.color });
        break;
      }
    }
  }

  // Compute pier spans: complementary to opening spans within [0, edgeLen]
  const pierSpans = [];
  let cursor = 0;
  for (const [t0, t1] of openingSpans) {
    if (t0 > cursor + 1e-9) pierSpans.push([cursor, t0]);
    cursor = t1;
  }
  if (cursor < edgeLen - 1e-9) pierSpans.push([cursor, edgeLen]);

  // Emit full-height piers
  for (const [t0, t1] of pierSpans) {
    if (t1 - t0 < 1e-9) continue;
    const fp = _wallSegFootprint(a.x, a.y, tx, ty, nx, ny, t0, t1, halfWall);
    if (_isRenderable(fp)) {
      out.push({ kind: "wall", footprint: fp, z0: 0, z1: ceilingM, color: wallColor, flat: false });
    }
  }

  // Emit lintel/sill/reveal for each merged opening span
  for (const [t0, t1] of openingSpans) {
    if (t1 - t0 < 1e-9) continue;
    const key = `${t0},${t1}`;
    const info = spanInfo.get(key);
    if (!info) continue;

    const { sill, head, isDoor } = info;

    // Lintel: [head, ceilingM] — clamped so head > ceilingM gives zero lintel (EC6)
    const lintelZ0 = head;
    const lintelZ1 = ceilingM;
    if (lintelZ1 > lintelZ0 + 1e-9) {
      const fp = _wallSegFootprint(a.x, a.y, tx, ty, nx, ny, t0, t1, halfWall);
      if (_isRenderable(fp)) {
        out.push({ kind: "wall", footprint: fp, z0: lintelZ0, z1: lintelZ1, color: wallColor, flat: false });
      }
    }

    if (!isDoor) {
      // Sill wall: [0, sill] — only for windows
      if (sill > 1e-9) {
        const fp = _wallSegFootprint(a.x, a.y, tx, ty, nx, ny, t0, t1, halfWall);
        if (_isRenderable(fp)) {
          out.push({ kind: "wall", footprint: fp, z0: 0, z1: sill, color: wallColor, flat: false });
        }
      }
      // Window reveal pane: thin translucent panel at [sill, head] filling the opening
      // Use the same wall-thickness footprint — the translucent material makes it read as glazing
      const fp = _wallSegFootprint(a.x, a.y, tx, ty, nx, ny, t0, t1, halfWall);
      if (_isRenderable(fp)) {
        out.push({ kind: "opening", footprint: fp, z0: sill, z1: head, color: wallColor, flat: false, translucent: true });
      }
    }
    // Door: gap [0, head] is genuinely open — no sill box, no reveal pane (EC5)
  }

  return out;
}

/**
 * Project a symbol's center onto an edge and return the along-span [t0, t1]
 * where the opening occupies on that edge, or null if the symbol does not
 * sit on this edge.
 *
 * Uses the same on-wall tolerance as symbolBelongsToRoom.
 *
 * @param {{x:number,y:number}} center  symbol center
 * @param {number} halfW  half the symbol width in the along direction
 * @param {{a:{x:number,y:number},b:{x:number,y:number}}} edge
 * @returns {[number,number]|null}
 */
function _openingAlongSpan(center, halfW, edge) {
  const { a, b } = edge;
  const edgeDx = b.x - a.x;
  const edgeDy = b.y - a.y;
  const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
  if (edgeLen < 1e-9) return null;

  const tx = edgeDx / edgeLen;
  const ty = edgeDy / edgeLen;
  const nx = -ty;
  const ny = tx;

  const relX = center.x - a.x;
  const relY = center.y - a.y;
  const along = relX * tx + relY * ty;
  const perp  = Math.abs(relX * nx + relY * ny);

  const halfWall = WALL_M / 2 + 0.05;
  if (perp > halfWall) return null;
  if (along + halfW < -halfWall || along - halfW > edgeLen + halfWall) return null;

  return [along - halfW, along + halfW];
}

/**
 * Build filtered (scoped) VIEWS of the live models — pure, no mutation.
 *
 * scope === null → returns the models unchanged (whole plan).
 * scope === roomId → { walls:{rooms:[room],chain:[]}, symbols:{symbols:[…belongs]} }.
 * If the room id is not found, falls back to whole-plan (null scope).
 *
 * @param {{rooms:import("./walls.js").Room[],chain:any[]}} wallsModel
 * @param {{symbols:import("./symbols.js").Sym[]}} symbolsModel
 * @param {string|null} scope
 * @returns {{ walls:{rooms:import("./walls.js").Room[],chain:any[]}, symbols:{symbols:import("./symbols.js").Sym[]} }}
 */
export function scopeModels(wallsModel, symbolsModel, scope) {
  if (scope === null) return { walls: wallsModel, symbols: symbolsModel };

  const room = wallsModel.rooms.find(r => r.id === scope);
  if (!room) return { walls: wallsModel, symbols: symbolsModel }; // Edge Case 7: room not found

  const filteredSymbols = symbolsModel.symbols.filter(s => symbolBelongsToRoom(room, s));

  return {
    walls: { rooms: [room], chain: [] },
    symbols: { symbols: filteredSymbols },
  };
}

/**
 * Map buildItems() output + closed-room floor slabs into framework-agnostic
 * mesh descriptors and compute the scene bounds. Does NOT import three.js, so
 * it is unit-testable headless.
 *
 * - walls → split for openings (LLD 142 §2): pier/lintel/sill boxes + reveal
 * - furniture → flat:false box descriptors (z0..z1)
 * - openings → handled during wall-split; fallback to [sill,head] box if
 *   no host edge is found (Edge Case 2)
 * - rugs (kind:"rug") → flat:true ground decals
 * - floor slabs (one per closed room) → kind:"floor", flat:true
 *
 * Degenerate footprints (<3 corners or ~zero area) emit no descriptor
 * (mirrors how buildItems/extrudeFootprint drop degenerate polygons).
 *
 * @param {ReturnType<import("./isoRender.js").buildItems>} items
 * @param {{ rooms:{closed:boolean,verts:{x:number,y:number}[]}[] }} wallsModel  // for floor slabs + opening→wall association
 * @param {string} floorColor  // opaque neutral for slabs (theme roomFill, opaque-ised)
 * @param {{symbols:import("./symbols.js").Sym[]}} [symbolsModel]  // for opening→wall association
 * @returns {{ descriptors: MeshDescriptor[], bounds: SceneBounds }}
 */
export function buildSceneDescriptors(items, wallsModel, floorColor, symbolsModel) {
  /** @type {MeshDescriptor[]} */
  const descriptors = [];

  const rooms = (wallsModel && wallsModel.rooms) || [];

  // Partition items: openings need wall-split processing; others are simple boxes
  const wallItems = items.filter(it => it.kind === "wall");
  const openingItems = items.filter(it => it.kind === "opening");
  const otherItems = items.filter(it => it.kind !== "wall" && it.kind !== "opening");

  // All wall items share the same color (all derived from the same theme palette).
  // Use the first wall item's color, or the fallback gold if no walls.
  const wallColor = (wallItems.length > 0)
    ? (wallItems[0].baseColor || wallItems[0].color || "#c9a84c")
    : "#c9a84c";

  // Set of opening item indexes that were successfully associated to a wall edge
  const associatedOpenings = new Set();

  // For each closed room, build wall descriptors with opening cuts
  for (const room of rooms) {
    if (!room.closed) continue;
    const verts = room.verts;
    const n = verts.length;
    if (n < 2) continue;

    for (let i = 0; i < n; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % n];
      const edge = { a, b };

      // Find openings hosted on this edge
      const hosted = [];
      for (let oi = 0; oi < openingItems.length; oi++) {
        const opItem = openingItems[oi];

        const sill = opItem.z0; // set by buildItems from cat.sill ?? 0
        const head = opItem.z1; // set by buildItems from cat.head ?? cat.z
        // A door has sill=0 (its gap runs from the floor); a window has sill>0.
        const isDoor = sill < 1e-6;

        // Centroid of the opening's footprint
        const fpLen = opItem.footprint.length;
        let fcx = 0, fcy = 0;
        for (const p of opItem.footprint) { fcx += p.x; fcy += p.y; }
        fcx /= fpLen; fcy /= fpLen;
        const center = { x: fcx, y: fcy };

        // Opening width: match to the symbol if symbolsModel is provided,
        // otherwise estimate from the footprint diagonal
        let openingHalfW = 0.4; // safe default ~0.8m opening
        if (symbolsModel) {
          const sym = symbolsModel.symbols.find(s => {
            const cat = CATALOG[s.type];
            return cat && cat.openings && Math.abs(s.x - fcx) < 0.08 && Math.abs(s.y - fcy) < 0.08;
          });
          if (sym) {
            openingHalfW = sym.w / 2;
          } else {
            // Estimate from footprint: width of the opening (longest edge parallel to opening direction)
            openingHalfW = Math.sqrt(
              Math.pow(opItem.footprint[0].x - opItem.footprint[1].x, 2) +
              Math.pow(opItem.footprint[0].y - opItem.footprint[1].y, 2)
            ) / 2;
          }
        }

        const span = _openingAlongSpan(center, openingHalfW, edge);
        if (span === null) continue;

        hosted.push({ sill, head, along: span, isDoor, color: opItem.baseColor || opItem.color });
        associatedOpenings.add(oi);
      }

      // Emit wall descriptors for this edge (split if openings hosted)
      const edgeParts = _splitWallForOpenings(edge, hosted, CEILING_M, wallColor);
      for (const d of edgeParts) {
        if (_isRenderable(d.footprint)) descriptors.push(d);
      }
    }
  }

  // Non-wall, non-opening items: furniture + rugs — straight from buildItems.
  for (const item of otherItems) {
    if (!_isRenderable(item.footprint)) continue;
    descriptors.push({
      kind: item.kind,
      footprint: item.footprint,
      z0: item.z0,
      z1: item.z1,
      color: item.color ?? item.baseColor,
      flat: item.kind === "rug",
    });
  }

  // Unassociated openings: fallback box at [sill, head] at symbol footprint (Edge Case 2)
  for (let oi = 0; oi < openingItems.length; oi++) {
    if (associatedOpenings.has(oi)) continue;
    const opItem = openingItems[oi];
    if (!_isRenderable(opItem.footprint)) continue;
    descriptors.push({
      kind: "opening",
      footprint: opItem.footprint,
      z0: opItem.z0,
      z1: opItem.z1,
      color: opItem.color ?? opItem.baseColor,
      flat: false,
      translucent: true,
    });
  }

  // Floor slabs — one per closed room. Same closed-room filter buildItems uses.
  for (const room of rooms) {
    if (!room.closed) continue;
    if (!_isRenderable(room.verts)) continue;
    descriptors.push({
      kind: "floor",
      footprint: room.verts,
      z0: 0,
      z1: 0,
      color: floorColor,
      flat: true,
    });
  }

  // Bounds: union all footprint XY; height range [0, max(z1, CEILING_M)].
  let bounds = null;
  if (descriptors.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let maxZ = CEILING_M;
    for (const d of descriptors) {
      for (const p of d.footprint) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      if (d.z1 > maxZ) maxZ = d.z1;
    }
    bounds = { minX, minY, maxX, maxY, minZ: 0, maxZ };
  }

  return { descriptors, bounds };
}

/**
 * World-metre point → three.js scene coords (y-up). z is height (m).
 * The single place the y-down→y-up + XZ-ground mapping lives:
 *   threeX = worldX ; threeY = worldZ (height) ; threeZ = worldY (depth).
 * Pure.
 * @param {number} wx
 * @param {number} wy
 * @param {number} wz  height (metres)
 * @returns {{x:number,y:number,z:number}}
 */
export function worldToScene(wx, wy, wz) {
  return { x: wx, y: wz, z: wy };
}

/**
 * True if a WebGL(2) context is obtainable — gate before importing three.
 * Takes an OPTIONAL canvas (or a zero-arg factory returning one) so unit tests
 * can inject a stub whose getContext returns null, without monkeypatching the
 * global `document`. Defaults to a throwaway `document.createElement("canvas")`.
 * @param {HTMLCanvasElement|(()=>HTMLCanvasElement)} [canvasOrFactory]
 * @returns {boolean}
 */
export function webglAvailable(canvasOrFactory) {
  try {
    let canvas;
    if (typeof canvasOrFactory === "function") canvas = canvasOrFactory();
    else if (canvasOrFactory) canvas = canvasOrFactory;
    else canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    return !!gl;
  } catch {
    return false;
  }
}

// ── Impure WebGL layer (DOM + lazily-imported three.js) ─────────────────────

/** @type {any} resolved three engine ({ ...three, OrbitControls }) */
let _three = null;
/** @type {Promise<any>|null} in-flight import promise (dedupes rapid toggles) */
let _loadPromise = null;

/** @type {HTMLCanvasElement|null} */
let _canvas = null;
/** @type {(()=>boolean)|null} */
let _getActive = null;
/** @type {{ model:{ rooms:any[], chain:any[] } }|null} */
let _wallsMod = null;
/** @type {{ model:{ symbols:any[] } }|null} */
let _symbolsMod = null;
/** @type {HTMLElement|null} */
let _loadingEl = null;

// three.js objects — created once, kept for cheap re-entry (Approach §7).
let _renderer = null;
let _scene = null;
let _camera = null;
let _controls = null;
/** @type {any} the per-plan geometry group; disposed on exit, rebuilt on entry */
let _planGroup = null;
/** @type {Map<string, any>} material cache keyed by "kind|color"; disposed with the group */
let _materialCache = new Map();
/** @type {SceneBounds} */
let _bounds = null;

/** @type {number|null} rAF handle for the self-terminating damping loop */
let _loopHandle = null;
let _listenersBound = false;

/**
 * Lazy-load three.js once, via the render3dEngine.js facade. A single dynamic
 * import of that facade is what code-splits three into its own lazy chunk (never
 * fetched on default editor load). The facade uses STATIC NAMED imports from
 * "three" so Vite/Rollup can tree-shake three's surface — a namespace import +
 * runtime property access would defeat that and blow the ~150 KB budget (LLD §9).
 * @returns {Promise<any>}
 */
function ensureThree() {
  if (_three) return Promise.resolve(_three);
  if (!_loadPromise) {
    _loadPromise = import("./render3dEngine.js")
      .then((engine) => {
        _three = engine;
        return _three;
      })
      .catch((err) => {
        // Reset so a later re-entry can retry the download (Edge Case 2).
        _loadPromise = null;
        throw err;
      });
  }
  return _loadPromise;
}

/** Bind the canvas + model refs + active getter + loading element. Once, from main.js. */
export function initRender3d(canvasEl, getActive, wallsMod, symbolsMod, loadingEl) {
  _canvas = canvasEl;
  _getActive = getActive;
  _wallsMod = wallsMod;
  _symbolsMod = symbolsMod;
  _loadingEl = loadingEl || null;

  // WebGL context-loss guards (Edge Case 11). Safe to bind before a context
  // exists; they fire only once the renderer has created one.
  if (_canvas && !_listenersBound) {
    _listenersBound = true;
    _canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      _stopLoop();
    });
    _canvas.addEventListener("webglcontextrestored", () => {
      if (_getActive && _getActive() && _three) {
        _buildPlanGroup();
        frame();
        _renderOnce();
      }
    });
  }
}

/** Current canvas pixel size (falls back to the window if unlaid-out). */
function _size() {
  const w = (_canvas && _canvas.clientWidth) || window.innerWidth || 1;
  const h = (_canvas && _canvas.clientHeight) || window.innerHeight || 1;
  return { w, h };
}

/**
 * Enter preview: lazy-load three.js (once), build renderer/scene/camera/controls
 * if needed, (re)build the plan group from live models, frame the camera, and
 * render the initial static frame. Shows the loading state while importing.
 * On WebGL-absent or import failure, resolves to a { fallback:true } result so
 * main.js paints the 2.5D SVG fallback.
 * @returns {Promise<{ ok:true } | { ok:false, fallback:true, reason:string }>}
 */
export async function enter() {
  // Gate on WebGL BEFORE importing three (uses a throwaway canvas, not the
  // real one, so we don't consume the renderer's future context).
  if (!webglAvailable()) {
    return { ok: false, fallback: true, reason: "no-webgl" };
  }

  if (_loadingEl) _loadingEl.hidden = false;

  let three;
  try {
    three = await ensureThree();
  } catch (err) {
    if (_loadingEl) _loadingEl.hidden = true;
    return { ok: false, fallback: true, reason: "import-failed" };
  }

  if (_loadingEl) _loadingEl.hidden = true;

  // Rapid toggle: preview was switched off while the chunk loaded. Bail before
  // building — main.js will call exit() (Edge Case 3).
  if (_getActive && !_getActive()) return { ok: true };

  try {
    _ensureEngine(three);
    _buildPlanGroup();
    frame();
    _renderOnce();
  } catch (err) {
    // Any GPU/context failure at build time → fall back cleanly.
    return { ok: false, fallback: true, reason: "build-failed" };
  }

  return { ok: true };
}

/**
 * Exit preview: stop the loop, dispose the plan group + cached materials, keep
 * renderer/scene/camera/controls alive for cheap re-entry (Approach §7).
 */
export function exit() {
  _stopLoop();
  _disposePlanGroup();
}

/** Create renderer/scene/camera/controls + lights once; reused across entries. */
function _ensureEngine(THREE) {
  if (_renderer) return;
  const { w, h } = _size();

  _renderer = new THREE.WebGLRenderer({ canvas: _canvas, antialias: true });
  _renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // HiDPI cap (Edge Case 15)
  _renderer.setSize(w, h, false); // false: CSS controls the canvas box

  _scene = new THREE.Scene();

  _camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);

  // Lights: ambient fill + one directional for gentle face differentiation.
  // No shadows (out of scope). Directional rays are parallel, so an off-origin
  // plan is lit uniformly regardless of position.
  _scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(1, 1.4, 1);
  _scene.add(dir);

  _controls = new THREE.OrbitControls(_camera, _canvas);
  _controls.enableDamping = true;
  _controls.enablePan = true;
  _controls.maxPolarAngle = Math.PI / 2 - 0.04; // stay above the floor slab
  _controls.addEventListener("start", _armLoop);
  _controls.addEventListener("change", _armLoop);
}

/** Cache/create the material for a descriptor (one instance per distinct look). */
function _material(THREE, kind, color, translucent) {
  // Key must include the translucent flag so translucent and opaque opening
  // materials don't collide in the cache.
  const key = kind + "|" + color + (translucent ? "|t" : "");
  let mat = _materialCache.get(key);
  if (mat) return mat;
  if (kind === "floor") {
    // DoubleSide (see below): the _swapMatrix Y↔Z reflection flips winding, so a
    // flat ShapeGeometry laid on the ground is back-facing (and culled under
    // FrontSide) when the orbit camera looks down at it — floors would vanish.
    mat = new THREE.MeshLambertMaterial({
      color, side: THREE.DoubleSide, flatShading: true,
      transparent: true, opacity: 0.5,
    });
  } else if (kind === "rug") {
    mat = new THREE.MeshLambertMaterial({
      color, side: THREE.DoubleSide, flatShading: true,
    });
  } else if (kind === "opening" || translucent) {
    // Window reveal pane: translucent/lighter material so it reads as glazing.
    mat = new THREE.MeshLambertMaterial({
      color: 0xb0d8f0, side: THREE.DoubleSide, flatShading: true,
      transparent: true, opacity: 0.35,
    });
  } else {
    // Walls + furniture: DoubleSide is MANDATORY. corners() (CCW) and
    // _wallQuad (CW) wind oppositely, so under default FrontSide one class
    // renders inside-out (the LLD 128 back-face bug, re-incarnated). DoubleSide
    // makes face correctness winding-independent (Approach §3/§5).
    mat = new THREE.MeshLambertMaterial({
      color, side: THREE.DoubleSide, flatShading: true,
    });
  }
  _materialCache.set(key, mat);
  return mat;
}

/**
 * The y-down world → y-up scene mapping as a geometry matrix. Swapping Y↔Z is a
 * reflection (det −1), which is exactly the intended worldToScene() map: a shape
 * built in the (worldX, worldY) plane and extruded/laid along local +Z lands as
 * (threeX=worldX, threeY=height, threeZ=worldY). Cached per engine.
 */
let _swapYZ = null;
function _swapMatrix(THREE) {
  if (!_swapYZ) {
    _swapYZ = new THREE.Matrix4().set(
      1, 0, 0, 0,
      0, 0, 1, 0,
      0, 1, 0, 0,
      0, 0, 0, 1,
    );
  }
  return _swapYZ;
}

/** Build a THREE.Shape in the (worldX, worldY) plane from a footprint polygon. */
function _footprintShape(THREE, footprint) {
  const shape = new THREE.Shape();
  shape.moveTo(footprint[0].x, footprint[0].y);
  for (let i = 1; i < footprint.length; i++) shape.lineTo(footprint[i].x, footprint[i].y);
  shape.closePath();
  return shape;
}

/** Extruded box mesh for a wall/furniture/opening descriptor. */
function _makeBoxMesh(THREE, d) {
  const depth = d.z1 - d.z0;
  if (depth <= 0) return null;
  const shape = _footprintShape(THREE, d.footprint);
  const geom = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  // local (worldX, worldY, height∈[0,depth]) → three (worldX, height, worldY)
  geom.applyMatrix4(_swapMatrix(THREE));
  geom.translate(0, d.z0, 0); // lift base to its z0
  return new THREE.Mesh(geom, _material(THREE, d.kind, d.color, d.translucent));
}

/** Flat ground mesh (floor slab or rug decal). */
function _makeFlatMesh(THREE, d) {
  const shape = _footprintShape(THREE, d.footprint);
  const geom = new THREE.ShapeGeometry(shape);
  // local (worldX, worldY, 0) → three (worldX, 0, worldY); faces up.
  geom.applyMatrix4(_swapMatrix(THREE));
  const lift = d.kind === "rug" ? 0.002 : 0; // tiny lift avoids z-fighting w/ slab
  if (lift) geom.translate(0, lift, 0);
  return new THREE.Mesh(geom, _material(THREE, d.kind, d.color));
}

/** Dispose the current plan group's geometries + cached materials, detach it. */
function _disposePlanGroup() {
  if (_planGroup && _scene) {
    _planGroup.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
    });
    _scene.remove(_planGroup);
  }
  _planGroup = null;
  for (const mat of _materialCache.values()) mat.dispose();
  _materialCache.clear();
}

/** (Re)build the plan group from the live models (a pure function of the plan). */
function _buildPlanGroup() {
  const THREE = _three;
  _disposePlanGroup();
  _planGroup = new THREE.Group();

  const rawWallsModel = /** @type {any} */ (_wallsMod && _wallsMod.model) || { rooms: [], chain: [] };
  const rawSymbolsModel = /** @type {any} */ (_symbolsMod && _symbolsMod.model) || { symbols: [] };

  // Apply per-room scoping filter (LLD 142 §4)
  const scope = getScope();
  const { walls: wallsModel, symbols: symbolsModel } = scopeModels(rawWallsModel, rawSymbolsModel, scope);

  const pal = palette();
  const bg = toOpaqueRgb(pal.bg, "#14140f");
  const floorColor = toOpaqueRgb(pal.roomFill || "rgba(201,168,76,0.07)", bg);

  const items = buildItems(wallsModel, symbolsModel);
  const { descriptors, bounds } = buildSceneDescriptors(items, wallsModel, floorColor, symbolsModel);
  _bounds = bounds;

  for (const d of descriptors) {
    const mesh = d.flat ? _makeFlatMesh(THREE, d) : _makeBoxMesh(THREE, d);
    if (mesh) _planGroup.add(mesh);
  }
  _scene.add(_planGroup);
}

/**
 * Rebuild the plan group from the current (scoped) models, reframe the camera,
 * and render once. Used on scope change while preview is active (cheaper than
 * exit() + enter() since three.js and the engine are already initialized).
 * Returns true if the scoped descriptor set is empty (empty-state trigger).
 */
export function rebuild() {
  if (!_three || !_renderer || !_scene) return false;
  try {
    _buildPlanGroup();
    frame();
    _renderOnce();
  } catch {
    // On unexpected error, leave existing state intact
  }
  return _bounds === null;
}

/**
 * Recompute the camera to fit the current scene bounds (~10% margin). A pleasant
 * three-quarter view from a +X/+Y/+Z corner, echoing the retired isometric angle.
 */
export function frame() {
  if (!_camera || !_controls) return;
  const THREE = _three;
  const { w, h } = _size();
  _camera.aspect = w / h;

  let cx, cy, cz, diag;
  if (_bounds) {
    // world → scene: x unchanged, height(z)→y, world-y→z.
    const sMinX = _bounds.minX, sMaxX = _bounds.maxX;
    const sMinY = _bounds.minZ, sMaxY = _bounds.maxZ; // height range → scene Y
    const sMinZ = _bounds.minY, sMaxZ = _bounds.maxY; // world-y → scene Z
    cx = (sMinX + sMaxX) / 2;
    cy = (sMinY + sMaxY) / 2;
    cz = (sMinZ + sMaxZ) / 2;
    const dx = sMaxX - sMinX, dy = sMaxY - sMinY, dz = sMaxZ - sMinZ;
    diag = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  } else {
    // Empty plan (Edge Case 4): default frame at the origin, no crash.
    cx = 0; cy = CEILING_M / 2; cz = 0;
    diag = 8;
  }

  const fov = (_camera.fov * Math.PI) / 180;
  const dist = (diag / 2) / Math.tan(fov / 2) * 1.15; // fit + ~10-15% margin

  // Three-quarter bearing: up and to a corner (elevation ~30-35°).
  const off = new THREE.Vector3(1, 0.8, 1).normalize().multiplyScalar(dist);
  _camera.position.set(cx + off.x, cy + off.y, cz + off.z);
  _camera.near = Math.max(0.1, dist - diag);
  _camera.far = dist + diag * 3;
  _camera.updateProjectionMatrix();

  _controls.target.set(cx, cy, cz);
  _controls.minDistance = diag * 0.15;
  _controls.maxDistance = dist * 4 + diag;
  _controls.update();
}

/** Update renderer size + camera aspect on a window resize (Edge Case 12). */
export function resize() {
  if (!_renderer || !_camera) return;
  const { w, h } = _size();
  _renderer.setSize(w, h, false);
  _camera.aspect = w / h;
  _camera.updateProjectionMatrix();
  _renderOnce();
}

/** One explicit static draw (initial frame / after resize / after rebuild). */
function _renderOnce() {
  if (_renderer && _scene && _camera) _renderer.render(_scene, _camera);
}

// ── Self-terminating damping loop (Approach §6) ─────────────────────────────
// No always-on rAF on a static scene. On user input the loop starts; each
// frame calls controls.update() (applies damping) then renders. update()
// returns true while the camera is still settling and false once it has —
// then the loop stops. So the loop exists only during/just after interaction.

function _armLoop() {
  if (_loopHandle === null) _loopHandle = requestAnimationFrame(_tick);
}

function _tick() {
  if (!_controls || !_renderer || !_scene || !_camera) { _loopHandle = null; return; }
  const still = _controls.update(); // true while damping is still applying
  _renderer.render(_scene, _camera);
  if (still) {
    _loopHandle = requestAnimationFrame(_tick);
  } else {
    _loopHandle = null;
  }
}

function _stopLoop() {
  if (_loopHandle !== null) {
    cancelAnimationFrame(_loopHandle);
    _loopHandle = null;
  }
}

/**
 * Full release (page unload): dispose renderer, force context loss, null refs.
 * Guards against the classic "too many active WebGL contexts" leak on bfcache /
 * SPA-like restores. Wired to a `pagehide` listener in main.js.
 */
export function dispose() {
  _stopLoop();
  _disposePlanGroup();
  if (_controls) {
    _controls.removeEventListener("start", _armLoop);
    _controls.removeEventListener("change", _armLoop);
    if (_controls.dispose) _controls.dispose();
  }
  if (_renderer) {
    _renderer.dispose();
    if (_renderer.forceContextLoss) _renderer.forceContextLoss();
  }
  _renderer = null;
  _scene = null;
  _camera = null;
  _controls = null;
  _bounds = null;
}

// ── Test-only introspection (no-op in production paths) ─────────────────────

/** Number of live meshes in the plan group (teardown-leak probe for tests). */
export function __liveGeometryCount() {
  if (!_planGroup) return 0;
  let n = 0;
  _planGroup.traverse((obj) => { if (obj.geometry) n++; });
  return n;
}

/** True if a WebGLRenderer currently exists (context-reuse probe for tests). */
export function __hasRenderer() {
  return !!_renderer;
}

/** True if the current plan group has no geometry (empty scoped room). */
export function __isEmpty() {
  return _bounds === null;
}

/** Return a copy of the current scene bounds (reframe-probe for integration tests). */
export function __getBounds() {
  if (!_bounds) return null;
  return { minX: _bounds.minX, minY: _bounds.minY, maxX: _bounds.maxX, maxY: _bounds.maxY,
           minZ: _bounds.minZ, maxZ: _bounds.maxZ };
}
