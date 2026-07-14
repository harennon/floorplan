/**
 * share.js — URL-hash encode/decode for share links
 *
 * Hash format: <codec-byte><payload>
 *   'c' = compact lean payload, deflate-raw compressed, base64url (default)
 *   'd' = full JSON, deflate-raw compressed, base64url (legacy — decode only)
 *   'u' = full JSON, uncompressed, base64url (fallback when CompressionStream unavailable)
 *
 * Nothing is sent to a server. All encoding is client-side only.
 */

import { buildPlan, validatePlan, serializePlan, buildCompact, parseCompact } from "./plan.js";

const CODEC_COMPACT      = "c";  // compact payload + deflate-raw + base64url (new default)
const CODEC_COMPRESSED   = "d";  // full JSON + deflate-raw (legacy, decode-only)
const CODEC_UNCOMPRESSED = "u";  // full JSON, no compression (fallback)

// ── Encoding ──────────────────────────────────────────────────────────────────

/**
 * Plan → compact base64url hash string (prefixed with codec byte).
 * Emits 'c' (compact + deflate) when CompressionStream is available;
 * falls back to 'u' (full JSON, uncompressed) otherwise.
 * The legacy 'd' codec is no longer emitted but remains decodable.
 * @param {import("./plan.js").Plan} plan
 * @returns {Promise<string>}
 */
export async function encodePlanToHash(plan) {
  if (typeof CompressionStream !== "undefined") {
    try {
      const compactObj = buildCompact(plan);
      const json = JSON.stringify(compactObj);
      const bytes = new TextEncoder().encode(json);
      const compressed = await _compress(bytes);
      return CODEC_COMPACT + _bytesToBase64url(compressed);
    } catch {
      // Fallback to uncompressed on any compression error
    }
  }

  const json = serializePlan(plan);
  const bytes = new TextEncoder().encode(json);
  return CODEC_UNCOMPRESSED + _bytesToBase64url(bytes);
}

/**
 * Hash string → Plan|null (validated). Never throws.
 * Supports all codecs: 'c' (compact), 'd' (legacy compressed), 'u' (uncompressed).
 * @param {string} hash  (without leading '#')
 * @returns {Promise<import("./plan.js").Plan|null>}
 */
export async function decodeHashToPlan(hash) {
  try {
    if (!hash || hash.length < 2) return null;

    const codec = hash[0];
    const payload = hash.slice(1);

    if (codec === CODEC_COMPACT) {
      const compressed = _base64urlToBytes(payload);
      const bytes = await _decompress(compressed);
      const compact = JSON.parse(new TextDecoder().decode(bytes));
      return validatePlan(parseCompact(compact));
    } else if (codec === CODEC_COMPRESSED) {
      const compressed = _base64urlToBytes(payload);
      const bytes = await _decompress(compressed);
      const json = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(json);
      return validatePlan(parsed);
    } else if (codec === CODEC_UNCOMPRESSED) {
      const bytes = _base64urlToBytes(payload);
      const json = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(json);
      return validatePlan(parsed);
    } else {
      return null; // unknown codec
    }
  } catch {
    return null;
  }
}

/**
 * Build the absolute share URL for the current plan.
 * @returns {Promise<string>}
 */
export async function buildShareUrl() {
  const plan = buildPlan();
  const hash = await encodePlanToHash(plan);
  const base = location.origin + location.pathname;
  return base + "#" + hash;
}

/**
 * Split a raw hash (no leading '#') into the plan blob and parsed flag pairs.
 * Legacy hashes with no '&' return the whole string as planHash and flags={}.
 * Never throws.
 * @param {string} rawHash  (without leading '#')
 * @returns {{ planHash: string, flags: { pv?: boolean } }}
 */
export function parseHashParts(rawHash) {
  if (!rawHash) return { planHash: "", flags: {} };
  const ampIdx = rawHash.indexOf("&");
  if (ampIdx === -1) {
    return { planHash: rawHash, flags: {} };
  }
  const planHash = rawHash.slice(0, ampIdx);
  const flagStr = rawHash.slice(ampIdx + 1); // everything after the first '&'
  const flags = {};
  for (const part of flagStr.split("&")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx);
    const val = part.slice(eqIdx + 1);
    if (key === "pv") flags.pv = val === "1";
  }
  return { planHash, flags };
}

/**
 * Build the full hash string for a plan, appending '&pv=1' when preview is on.
 * Reuses encodePlanToHash for the plan blob.
 * @param {import("./plan.js").Plan} plan
 * @param {{ preview: boolean }} opts
 * @returns {Promise<string>}
 */
export async function encodeShareHash(plan, opts) {
  const planBlob = await encodePlanToHash(plan);
  if (opts && opts.preview) {
    return planBlob + "&pv=1";
  }
  return planBlob;
}

/**
 * Read location.hash on boot; returns decoded Plan (or null) and preview flag.
 * - Returns { plan: null, preview: false } when no hash is present.
 * - Returns { plan, preview } when the hash is valid.
 * - Throws an error when a hash IS present but cannot be decoded (malformed/truncated).
 *   Callers should catch this to show a "couldn't be opened" toast.
 * Strips the hash after reading in all cases so a later reload does not
 * re-trigger the share path.
 *
 * CALLER CONTRACT (main.js): because this both returns an object AND can throw,
 * the caller must declare the `preview` flag OUTSIDE the try/catch with a safe
 * default (false) so the catch path and every boot branch can read it.
 * @returns {Promise<{ plan: import("./plan.js").Plan | null, preview: boolean }>}
 */
export async function readBootHash() {
  const raw = location.hash;
  if (!raw || raw.length <= 1) return { plan: null, preview: false };

  // Strip leading '#'
  const rawHash = raw.slice(1);

  // Clear the hash from URL (without page reload)
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    // ignore (some environments don't support history API)
  }

  const { planHash, flags } = parseHashParts(rawHash);
  const plan = await decodeHashToPlan(planHash);
  if (plan === null) {
    // Hash was present but undecodable — signal to caller to show a toast
    throw new Error("share-hash-decode-failed");
  }
  return { plan, preview: flags.pv === true };
}

// ── Private: CompressionStream helpers ───────────────────────────────────────

async function _compress(bytes) {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return _concatUint8Arrays(chunks);
}

async function _decompress(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return _concatUint8Arrays(chunks);
}

function _concatUint8Arrays(arrays) {
  const totalLen = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// ── Private: base64url ────────────────────────────────────────────────────────

function _bytesToBase64url(bytes) {
  // Convert Uint8Array → binary string → base64 → base64url
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(binary);
  // base64url: replace + with -, / with _, strip trailing =
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function _base64urlToBytes(str) {
  // Restore standard base64: replace - with +, _ with /, add padding
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad === 2) b64 += "==";
  else if (pad === 3) b64 += "=";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
