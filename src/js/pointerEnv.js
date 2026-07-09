/**
 * pointerEnv.js — shared pointer-capability constants (LLD 46)
 *
 * Evaluated once at module load. All touch-ergonomics code imports from here
 * to keep the coarse-pointer flag and threshold constants in one place.
 *
 * NOTE: isCoarsePointer is not reactive to hot-plugging a mouse — matches
 * how the rest of the codebase reads matchMedia once at boot.
 */

/** True when any input is a coarse pointer (touch). Evaluated once at load. */
export const isCoarsePointer =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(any-pointer: coarse)").matches
    : false;

/** Loupe offset in screen px: snap crosshair rendered above the fingertip (draw mode, touch only). */
export const LOUPE_OFFSET_PX = 56;

/** Drag/tap threshold for mouse and pen (screen px). */
export const MOUSE_DRAG_THRESHOLD = 6;

/** Drag/tap threshold for touch (screen px) — wider to absorb finger jitter. */
export const TOUCH_DRAG_THRESHOLD = 10;

/**
 * Pure function: given a pointer event's type and coordinates, return the
 * effective draw-hook coordinate. For touch, the y is shifted up by
 * LOUPE_OFFSET_PX so the snap crosshair appears above the fingertip.
 * For mouse and pen the raw coordinate is returned unchanged.
 *
 * Exposed as a pure function so unit tests can call it without a live event.
 *
 * @param {"touch"|"mouse"|"pen"|string} pointerType
 * @param {number} x  raw clientX
 * @param {number} y  raw clientY
 * @returns {{ x: number, y: number }}
 */
export function effectiveDrawPoint(pointerType, x, y) {
  if (pointerType === "touch") {
    return { x, y: y - LOUPE_OFFSET_PX };
  }
  return { x, y };
}

/**
 * Pure function: return the drag threshold for a pointer type.
 *
 * @param {"touch"|"mouse"|"pen"|string} pointerType
 * @returns {number}
 */
export function dragThreshold(pointerType) {
  return pointerType === "touch" ? TOUCH_DRAG_THRESHOLD : MOUSE_DRAG_THRESHOLD;
}

/**
 * Pure function: return handle sizes based on coarse-pointer flag.
 *
 * @param {boolean} coarse
 * @returns {{ rotateHitR: number, minHitPx: number, rotateHandleR: number }}
 */
export function handleSizes(coarse) {
  return {
    rotateHitR:    coarse ? 22 : 14,
    minHitPx:      coarse ? 44 : 12,
    rotateHandleR: coarse ? 14 : 6,
  };
}
