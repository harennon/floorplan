/**
 * view.js — coordinate / scale module (the load-bearing contract)
 *
 * World unit is METRES. At zoom 1, BASE_PX_PER_M px == 1 world metre.
 *
 * Projection:
 *   screen = world * (zoom * BASE_PX_PER_M) + pan
 *   world  = (screen - pan) / (zoom * BASE_PX_PER_M)
 *
 * All world↔screen conversion must go through this module.
 * No other module may read panX/panY/zoom and do its own math.
 *
 * Isometric projection (LLD 128): worldToScreenIso is the sanctioned z-aware
 * projection. It folds a 3D world point (wx, wy, wz) into the dimetric plane
 * and then calls worldToScreen so pan/zoom handling stays here.
 */

export const BASE_PX_PER_M = 40; // 40px = 1m at zoom 1
export const MIN_ZOOM = 0.15;    // ~6px/m — whole floors visible
export const MAX_ZOOM = 16;      // ~640px/m — detail work; raised from 8 so Auto snap can reach 0.1m cell

/**
 * Mutable view state — single source of truth.
 * Only view.js writes these; callers may read.
 */
export const view = { zoom: 1, panX: 0, panY: 0 };

/** Registered render callbacks. */
const _listeners = [];

/** Current pixels per metre. */
export function pxPerM() {
  return view.zoom * BASE_PX_PER_M;
}

/** World metres → screen pixels. */
export function worldToScreen(wx, wy) {
  const scale = pxPerM();
  return {
    x: wx * scale + view.panX,
    y: wy * scale + view.panY,
  };
}

/** Screen pixels → world metres. */
export function screenToWorld(sx, sy) {
  const scale = pxPerM();
  return {
    x: (sx - view.panX) / scale,
    y: (sy - view.panY) / scale,
  };
}

/** Clamp zoom to [MIN_ZOOM, MAX_ZOOM]. */
export function clampZoom(z) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/**
 * Zoom by factor, keeping the world point under screen position (sx, sy) fixed.
 * Clamping uses the *clamped* zoom so there is no drift at the limits.
 */
export function zoomAbout(sx, sy, factor) {
  const newZoom = clampZoom(view.zoom * factor);
  // World point under (sx,sy) before zoom:  w = (sx - panX) / (oldZoom * BASE)
  // Same world point must be at sx after:    sx = w * (newZoom * BASE) + newPanX
  // => newPanX = sx - w * (newZoom * BASE)
  const w = screenToWorld(sx, sy);
  view.zoom = newZoom;
  const newScale = pxPerM();
  view.panX = sx - w.x * newScale;
  view.panY = sy - w.y * newScale;
  _notify();
}

/**
 * Reset to a sensible initial frame for a viewport of size W × H.
 * Places world origin at ~(15%, 30%) of the viewport so the grid is immediately visible.
 */
export function resetView(W, H) {
  view.zoom = 1;
  view.panX = W * 0.15;
  view.panY = H * 0.30;
  _notify();
}

/** Register a callback fired after any view mutation (render trigger). */
export function onChange(cb) {
  _listeners.push(cb);
}

/**
 * Set zoom/panX/panY directly (zoom clamped) and fire onChange.
 * Used by applyPlan for same-device localStorage restore.
 * @param {{ zoom:number, panX:number, panY:number }} v
 */
export function setView(v) {
  view.zoom = clampZoom(v.zoom);
  view.panX = v.panX;
  view.panY = v.panY;
  _notify();
}

/**
 * Compute and apply a zoom/pan that fits `bounds` (world-space) centered within
 * a W×H viewport with a fixed 10% margin, then fire onChange.
 * Zoom is clamped to [MIN_ZOOM, MAX_ZOOM].
 * @param {{ minX:number, minY:number, maxX:number, maxY:number }} bounds
 * @param {number} W  viewport width in pixels
 * @param {number} H  viewport height in pixels
 */
export function fitToContent(bounds, W, H) {
  const MARGIN = 0.10; // 10% margin
  const contentW = bounds.maxX - bounds.minX;
  const contentH = bounds.maxY - bounds.minY;

  if (contentW <= 0 || contentH <= 0) {
    resetView(W, H);
    return;
  }

  const availW = W * (1 - 2 * MARGIN);
  const availH = H * (1 - 2 * MARGIN);

  // Scale that fits content in available area
  const scaleX = availW / contentW;
  const scaleY = availH / contentH;
  const fitScale = Math.min(scaleX, scaleY);

  const newZoom = clampZoom(fitScale / BASE_PX_PER_M);
  const newScale = newZoom * BASE_PX_PER_M;

  // Center content in viewport
  const contentCenterX = (bounds.minX + bounds.maxX) / 2;
  const contentCenterY = (bounds.minY + bounds.maxY) / 2;
  view.zoom = newZoom;
  view.panX = W / 2 - contentCenterX * newScale;
  view.panY = H / 2 - contentCenterY * newScale;
  _notify();
}

function _notify() {
  for (const cb of _listeners) cb();
}

// ── Isometric projection (LLD 128) ───────────────────────────────────────────

/** Fixed axonometric fold angle (30°). */
export const ISO_THETA = Math.PI / 6;

/**
 * Vertical scale factor: metres-of-height → folded-world-metres.
 * Nonzero (0.82) so raising an item visibly lifts its top face on screen.
 */
export const ISO_KZ = 0.82;

/**
 * Axonometric world→screen projection (LLD 128). Folds the 3D world point
 * (wx, wy, wz) into the dimetric plane and applies the SAME zoom/pan as
 * worldToScreen so the isometric scene shares the 2D editor's framing.
 *
 * wz is "up" in world space (decreases screen y).
 * Pan/zoom remain exclusively inside view.js — callers must not read
 * panX/panY/zoom directly (invariant holds for the iso case too).
 *
 * @param {number} wx  world x (metres)
 * @param {number} wy  world y (metres)
 * @param {number} wz  world z (metres, height above floor)
 * @returns {{ x:number, y:number }} screen pixels
 */
export function worldToScreenIso(wx, wy, wz) {
  const isoWX = (wx - wy) * Math.cos(ISO_THETA);
  const isoWY = (wx + wy) * Math.sin(ISO_THETA) - wz * ISO_KZ;
  return worldToScreen(isoWX, isoWY);
}
