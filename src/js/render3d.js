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

// ── Pure geometry core (no DOM, no three.js) ────────────────────────────────

/**
 * @typedef {{
 *   kind: "wall"|"furniture"|"rug"|"floor",
 *   footprint: {x:number,y:number}[],  // world-metre polygon (convex)
 *   z0: number,                        // base height (m)
 *   z1: number,                        // top height (m); ≈ z0 for flat items
 *   color: string,                     // opaque rgb()/hex (from buildItems.baseColor)
 *   flat: boolean                      // true → ShapeGeometry on ground (rug/floor)
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

/**
 * Map buildItems() output + closed-room floor slabs into framework-agnostic
 * mesh descriptors and compute the scene bounds. Does NOT import three.js, so
 * it is unit-testable headless.
 *
 * - walls/furniture → flat:false box descriptors (z0..z1)
 * - rugs (kind:"rug") → flat:true ground decals
 * - floor slabs (one per closed room) → kind:"floor", flat:true
 *
 * Degenerate footprints (<3 corners or ~zero area) emit no descriptor
 * (mirrors how buildItems/extrudeFootprint drop degenerate polygons).
 *
 * @param {ReturnType<import("./isoRender.js").buildItems>} items
 * @param {{ rooms:{closed:boolean,verts:{x:number,y:number}[]}[] }} wallsModel  // for floor slabs
 * @param {string} floorColor  // opaque neutral for slabs (theme roomFill, opaque-ised)
 * @returns {{ descriptors: MeshDescriptor[], bounds: SceneBounds }}
 */
export function buildSceneDescriptors(items, wallsModel, floorColor) {
  /** @type {MeshDescriptor[]} */
  const descriptors = [];

  // Boxes (walls, furniture) + flat rug decals — straight from buildItems.
  for (const item of items) {
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

  // Floor slabs — one per closed room. Same closed-room filter buildItems uses.
  const rooms = (wallsModel && wallsModel.rooms) || [];
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
/** @type {number|null} rAF handle for the in-flight view tween */
let _tweenHandle = null;
let _listenersBound = false;

// ── Preset bearings (LLD 152) ────────────────────────────────────────────────

/** Unit bearing (target→camera) for the default fit-to-bounds three-quarter view. */
const DEFAULT_BEARING = [1, 0.8, 1];

/** Named preset bearings (unit-normalized at use). */
const PRESET_BEARINGS = {
  ne: [1, 0.8, -1],
  nw: [-1, 0.8, -1],
  se: [1, 0.8, 1],
  top: [0, 1, 0.0001],
};

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
      _cancelTween();
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
 * Exit preview: stop the loop, cancel any tween, dispose the plan group +
 * cached materials, keep renderer/scene/camera/controls alive for cheap
 * re-entry (Approach §7).
 */
export function exit() {
  _stopLoop();
  _cancelTween();
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
  // Cancel any in-flight tween when the user starts interacting (Edge Case 4).
  _controls.addEventListener("start", _cancelTween);
}

/** Cache/create the material for a descriptor (one instance per distinct look). */
function _material(THREE, kind, color) {
  const key = kind + "|" + color;
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

/** Extruded box mesh for a wall/furniture descriptor. */
function _makeBoxMesh(THREE, d) {
  const depth = d.z1 - d.z0;
  if (depth <= 0) return null;
  const shape = _footprintShape(THREE, d.footprint);
  const geom = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  // local (worldX, worldY, height∈[0,depth]) → three (worldX, height, worldY)
  geom.applyMatrix4(_swapMatrix(THREE));
  geom.translate(0, d.z0, 0); // lift base to its z0
  return new THREE.Mesh(geom, _material(THREE, d.kind, d.color));
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

  const wallsModel = /** @type {any} */ (_wallsMod && _wallsMod.model) || { rooms: [], chain: [] };
  const symbolsModel = /** @type {any} */ (_symbolsMod && _symbolsMod.model) || { symbols: [] };

  const pal = palette();
  const bg = toOpaqueRgb(pal.bg, "#14140f");
  const floorColor = toOpaqueRgb(pal.roomFill || "rgba(201,168,76,0.07)", bg);

  const items = buildItems(wallsModel, symbolsModel);
  const { descriptors, bounds } = buildSceneDescriptors(items, wallsModel, floorColor);
  _bounds = bounds;

  for (const d of descriptors) {
    const mesh = d.flat ? _makeFlatMesh(THREE, d) : _makeBoxMesh(THREE, d);
    if (mesh) _planGroup.add(mesh);
  }
  _scene.add(_planGroup);
}

// ── View pose computation (pure-ish; reads _bounds + _camera.fov) ────────────

/**
 * Compute the canonical camera pose for a given bearing from the current scene
 * bounds. Pure w.r.t. _bounds/_camera.fov — no side effects, no tween. Uses
 * only plain math (no THREE dependency) so the helpers are unit-testable headless.
 * @param {[number,number,number]} bearing  target→camera direction (need not be unit)
 * @returns {{ target:{x,y,z}, position:{x,y,z}, near:number, far:number,
 *             minDistance:number, maxDistance:number }}
 */
function _viewPose(bearing) {
  let cx, cy, cz, diag;
  if (_bounds) {
    const sMinX = _bounds.minX, sMaxX = _bounds.maxX;
    const sMinY = _bounds.minZ, sMaxY = _bounds.maxZ; // height range → scene Y
    const sMinZ = _bounds.minY, sMaxZ = _bounds.maxY; // world-y → scene Z
    cx = (sMinX + sMaxX) / 2;
    cy = (sMinY + sMaxY) / 2;
    cz = (sMinZ + sMaxZ) / 2;
    const dx = sMaxX - sMinX, dy = sMaxY - sMinY, dz = sMaxZ - sMinZ;
    diag = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  } else {
    cx = 0; cy = CEILING_M / 2; cz = 0;
    diag = 8;
  }

  const fov = (_camera.fov * Math.PI) / 180;
  const dist = (diag / 2) / Math.tan(fov / 2) * 1.15;

  // Normalize bearing with plain math (avoids THREE.Vector3 dependency so _viewPose
  // is testable headless without three.js).
  const bx = bearing[0], by = bearing[1], bz = bearing[2];
  const bmag = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
  const ox = (bx / bmag) * dist;
  const oy = (by / bmag) * dist;
  const oz = (bz / bmag) * dist;

  return {
    target: { x: cx, y: cy, z: cz },
    position: { x: cx + ox, y: cy + oy, z: cz + oz },
    near: Math.max(0.1, dist - diag),
    far: dist + diag * 3,
    minDistance: diag * 0.15,
    maxDistance: dist * 4 + diag,
  };
}

/**
 * Recompute the camera to fit the current scene bounds (~10% margin). A pleasant
 * three-quarter view from a +X/+Y/+Z corner, echoing the retired isometric angle.
 * Applies instantly (used by entry/resize/context-restore). Contract unchanged.
 */
export function frame() {
  if (!_camera || !_controls) return;
  const { w, h } = _size();
  _camera.aspect = w / h;
  const pose = _viewPose(DEFAULT_BEARING);

  _camera.position.set(pose.position.x, pose.position.y, pose.position.z);
  _camera.near = pose.near;
  _camera.far = pose.far;
  _camera.updateProjectionMatrix();

  _controls.target.set(pose.target.x, pose.target.y, pose.target.z);
  _controls.minDistance = pose.minDistance;
  _controls.maxDistance = pose.maxDistance;
  _controls.update();
}

// ── Reduced-motion helper ────────────────────────────────────────────────────

/** True when the OS-level prefers-reduced-motion setting is active. */
function _reducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// ── Tween helpers (orbit-space interpolation) ────────────────────────────────

/** Ease-out cubic: 0→0, 1→1, monotonic. */
function _easeOut(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Shortest signed delta between two angles in radians. Result is in (-π, π].
 * Used to pick the short arc for azimuth interpolation (NE→NW never spins
 * the long way).
 */
function _shortestDelta(a, b) {
  let d = ((b - a) % (2 * Math.PI));
  // Normalise to (-π, π]
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Cancel any in-flight tween rAF. */
function _cancelTween() {
  if (_tweenHandle !== null) {
    cancelAnimationFrame(_tweenHandle);
    _tweenHandle = null;
  }
}

/** Lerp a scalar. */
function _lerp(a, b, t) { return a + (b - a) * t; }

/** Lerp a Vec3 object {x,y,z}. */
function _lerpVec(a, b, t) {
  return { x: _lerp(a.x, b.x, t), y: _lerp(a.y, b.y, t), z: _lerp(a.z, b.z, t) };
}

/**
 * Apply a pose snapshot immediately (without tween). Shared by frame() after
 * refactor, resetView(animate:false), setPreset(animate:false), and reduced-motion.
 * @param {{ target:{x,y,z}, position:{x,y,z}, near:number, far:number,
 *           minDistance:number, maxDistance:number }} pose
 */
function _applyPoseInstant(pose) {
  _camera.position.set(pose.position.x, pose.position.y, pose.position.z);
  _camera.near = pose.near;
  _camera.far = pose.far;
  _camera.updateProjectionMatrix();
  _controls.target.set(pose.target.x, pose.target.y, pose.target.z);
  _controls.minDistance = pose.minDistance;
  _controls.maxDistance = pose.maxDistance;
  _controls.update();
  _renderOnce();
}

/**
 * Start an eased orbit-space tween from the current camera pose to `goalPose`.
 * Duration ~300 ms. Cancels any previous tween first. The tween runs its own
 * rAF loop distinct from _loopHandle (the damping loop).
 * @param {{ target:{x,y,z}, position:{x,y,z}, near:number, far:number,
 *           minDistance:number, maxDistance:number }} goalPose
 */
function _startTween(goalPose) {
  _cancelTween();

  // Read start state from live camera
  const startTarget = {
    x: _controls.target.x,
    y: _controls.target.y,
    z: _controls.target.z,
  };
  const camPos = _camera.position;

  // Convert start camera position to spherical relative to startTarget
  const dx0 = camPos.x - startTarget.x;
  const dy0 = camPos.y - startTarget.y;
  const dz0 = camPos.z - startTarget.z;
  const startRadius = Math.sqrt(dx0 * dx0 + dy0 * dy0 + dz0 * dz0) || 1;
  const startPolar = Math.acos(Math.max(-1, Math.min(1, dy0 / startRadius)));
  const startAzimuth = Math.atan2(dx0, dz0);

  // Convert goal position to spherical relative to goalTarget
  const gtx = goalPose.target.x, gty = goalPose.target.y, gtz = goalPose.target.z;
  const gdx = goalPose.position.x - gtx;
  const gdy = goalPose.position.y - gty;
  const gdz = goalPose.position.z - gtz;
  const goalRadius = Math.sqrt(gdx * gdx + gdy * gdy + gdz * gdz) || 1;
  const goalPolar = Math.acos(Math.max(-1, Math.min(1, gdy / goalRadius)));
  const goalAzimuth = Math.atan2(gdx, gdz);

  const azimuthDelta = _shortestDelta(startAzimuth, goalAzimuth);

  const DURATION_MS = 300;
  let startTime = null;

  function _tweenFrame(now) {
    if (!_controls || !_renderer || !_scene || !_camera) { _tweenHandle = null; return; }

    if (startTime === null) startTime = now;
    const elapsed = now - startTime;
    const rawT = Math.min(1, elapsed / DURATION_MS);
    const e = _easeOut(rawT);

    // Interpolate target
    const target = _lerpVec(startTarget, goalPose.target, e);

    // Interpolate spherical coords (azimuth via shortest arc)
    const radius = _lerp(startRadius, goalRadius, e);
    const polar = Math.max(0.01, _lerp(startPolar, goalPolar, e));
    const azimuth = startAzimuth + azimuthDelta * e;

    // Reconstruct camera position from spherical
    const sinPolar = Math.sin(polar);
    const px = target.x + radius * sinPolar * Math.sin(azimuth);
    const py = target.y + radius * Math.cos(polar);
    const pz = target.z + radius * sinPolar * Math.cos(azimuth);

    _controls.target.set(target.x, target.y, target.z);
    _camera.position.set(px, py, pz);
    _controls.update();
    _renderer.render(_scene, _camera);

    if (rawT < 1) {
      _tweenHandle = requestAnimationFrame(_tweenFrame);
    } else {
      // Settle exactly at goal
      _applyPoseInstant(goalPose);
      _tweenHandle = null;
    }
  }

  _tweenHandle = requestAnimationFrame(_tweenFrame);
}

// ── Public API: reset + presets (LLD 152) ────────────────────────────────────

/**
 * Return the orbit camera to the default fit-to-bounds framing (Recenter / Home).
 * Eased orbit-space tween by default; instant when animate:false or reduced-motion.
 * No-op if the engine/camera does not yet exist (loading / fallback).
 * @param {{ animate?: boolean }} [opts]
 */
export function resetView(opts) {
  if (!_camera || !_controls || !_renderer) return;
  const animate = (opts && opts.animate === false) ? false : !_reducedMotion();
  const pose = _viewPose(DEFAULT_BEARING);
  if (animate) {
    _startTween(pose);
  } else {
    _cancelTween();
    _applyPoseInstant(pose);
  }
}

/**
 * Snap/tween to a named preset bearing (NE/NW/SE/Top). Same pose machinery as
 * resetView. No-op if name unknown or camera absent.
 * @param {"ne"|"nw"|"se"|"top"} name
 * @param {{ animate?: boolean }} [opts]
 */
export function setPreset(name, opts) {
  if (!_camera || !_controls || !_renderer) return;
  const bearing = PRESET_BEARINGS[name];
  if (!bearing) return;
  const animate = (opts && opts.animate === false) ? false : !_reducedMotion();
  const pose = _viewPose(bearing);
  if (animate) {
    _startTween(pose);
  } else {
    _cancelTween();
    _applyPoseInstant(pose);
  }
}

// ── Test-only accessors for pure helpers ─────────────────────────────────────

/** @internal — exposed for unit tests: the DEFAULT_BEARING constant. */
export function __defaultBearing() { return DEFAULT_BEARING.slice(); }
/** @internal — exposed for unit tests: the PRESET_BEARINGS map. */
export function __presetBearings() { return Object.assign({}, PRESET_BEARINGS); }
/** @internal — exposed for unit tests: compute a pose from current _bounds/_camera. */
export function __viewPose(bearing) { return _viewPose(bearing); }
/** @internal — exposed for unit tests: the shortest-delta helper. */
export function __shortestDelta(a, b) { return _shortestDelta(a, b); }
/** @internal — exposed for unit tests: the ease-out helper. */
export function __easeOut(t) { return _easeOut(t); }

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
  _cancelTween();
  _disposePlanGroup();
  if (_controls) {
    _controls.removeEventListener("start", _armLoop);
    _controls.removeEventListener("change", _armLoop);
    _controls.removeEventListener("start", _cancelTween);
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
