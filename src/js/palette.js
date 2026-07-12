/**
 * palette.js — curated swatch data for furniture and floor color pickers (LLD 97)
 *
 * Pure, DOM-free module. No runtime dependencies.
 *
 * Chosen colors are literal hex strings that read as real-material colors in
 * both light and dark themes. All swatches satisfy the legibility contract:
 *   - fill-vs-dark-bg (#14140f) and fill-vs-light-bg luminance separation
 *   - interior glyphs continue to use theme stroke/ink (drawn over the fill)
 *   - the lightest (white) and darkest (near-black) swatches stay distinguishable
 *     from the canvas via the 1px var(--muted) border on the swatch button
 */

/** @typedef {{ hex:string, name:string }} Swatch */
/** @typedef {"wood"|"upholstery"|"appliance"|"neutral"|"floor"} SwatchGroup */

/**
 * Ordered swatch groups. Each entry is a curated, real-material color.
 * @type {Record<SwatchGroup, Swatch[]>}
 */
export const SWATCHES = {
  wood: [
    { hex: "#e8d5b0", name: "Light oak" },
    { hex: "#c8a96a", name: "Oak" },
    { hex: "#a0784a", name: "Teak" },
    { hex: "#7a4f2e", name: "Walnut" },
    { hex: "#4a2e1a", name: "Espresso" },
  ],
  upholstery: [
    { hex: "#d4c4a8", name: "Linen" },
    { hex: "#8a9ba8", name: "Slate" },
    { hex: "#2c4a6e", name: "Navy" },
    { hex: "#3a6048", name: "Forest" },
    { hex: "#b85c38", name: "Rust" },
  ],
  appliance: [
    { hex: "#f0f0ee", name: "White" },
    { hex: "#b0b8be", name: "Stainless" },
    { hex: "#2a2a2a", name: "Matte black" },
  ],
  neutral: [
    { hex: "#f5f5f0", name: "White" },
    { hex: "#c8c8c0", name: "Light grey" },
    { hex: "#909088", name: "Mid grey" },
    { hex: "#484840", name: "Charcoal" },
    { hex: "#1a1a18", name: "Black" },
  ],
  floor: [
    { hex: "#dfc99a", name: "Light oak" },
    { hex: "#c09050", name: "Honey" },
    { hex: "#8a5c30", name: "Walnut" },
    { hex: "#9aa0a8", name: "Cool grey" },
    { hex: "#d0c8bc", name: "Tile" },
  ],
};

/**
 * Map from symbol category → swatch groups shown in the picker.
 * "neutral" is always appended for furniture categories so any piece can go
 * grey/white/black. Openings (door/window) return [] — not colorable.
 *
 * @type {Record<string, SwatchGroup[]>}
 */
const _CATEGORY_GROUPS = {
  openings: [],
  living:   ["wood", "upholstery"],
  kitchen:  ["appliance", "wood"],
  bedroom:  ["upholstery", "wood"],
  bath:     ["neutral"],
  outdoor:  ["wood", "upholstery"],
};

/**
 * Return the swatch groups that should appear in the picker for a given
 * symbol category. "neutral" is appended for all non-empty, non-openings
 * results. Floor → use the "floor" group. Unknown category → ["neutral"].
 *
 * @param {string} category  e.g. "living", "kitchen", "openings", "floor"
 * @returns {SwatchGroup[]}
 */
export function swatchGroupsForCategory(category) {
  if (category === "floor") return ["floor"];
  const base = _CATEGORY_GROUPS[category];
  if (base === undefined) return ["neutral"]; // unknown/future category
  if (base.length === 0) return [];           // openings
  // Deduplicate: avoid appending "neutral" if it's already in the base list
  if (base.includes("neutral")) return base;
  return [...base, "neutral"];
}

/**
 * Strict hex validator shared by validatePlan/parseCompact boundary.
 * Accepts #rgb and #rrggbb only (no alpha, no CSS color names).
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isValidHexColor(v) {
  return typeof v === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
}

/**
 * Coerce an untrusted value to a valid hex string, or undefined.
 * Prevents arbitrary strings from reaching SVG fill= attributes.
 *
 * @param {unknown} v
 * @returns {string|undefined}
 */
export function coerceColor(v) {
  return isValidHexColor(v) ? /** @type {string} */ (v) : undefined;
}
