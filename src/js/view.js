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
 */

export const BASE_PX_PER_M = 40; // 40px = 1m at zoom 1
export const MIN_ZOOM = 0.15;    // ~6px/m — whole floors visible
export const MAX_ZOOM = 8;       // ~320px/m — detail work

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
 * Center + zoom so the world bbox fits the viewport W × H with padPx padding.
 * If bbox is null (empty plan) falls back to resetView.
 * @param {number} W  viewport width px
 * @param {number} H  viewport height px
 * @param {{ minX:number, minY:number, maxX:number, maxY:number } | null} bbox
 * @param {number} [padPx=40]
 */
export function fitView(W, H, bbox, padPx = 40) {
  if (!bbox) {
    resetView(W, H);
    return;
  }
  const bw = bbox.maxX - bbox.minX;
  const bh = bbox.maxY - bbox.minY;
  if (bw <= 0 && bh <= 0) {
    resetView(W, H);
    return;
  }
  const availW = Math.max(1, W - padPx * 2);
  const availH = Math.max(1, H - padPx * 2);
  const scaleX = bw > 0 ? availW / (bw * BASE_PX_PER_M) : MAX_ZOOM;
  const scaleY = bh > 0 ? availH / (bh * BASE_PX_PER_M) : MAX_ZOOM;
  const rawZoom = Math.min(scaleX, scaleY);
  view.zoom = clampZoom(rawZoom);
  const ppm = view.zoom * BASE_PX_PER_M;
  // Center bbox in viewport
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  view.panX = W / 2 - cx * ppm;
  view.panY = H / 2 - cy * ppm;
  _notify();
}

function _notify() {
  for (const cb of _listeners) cb();
}
