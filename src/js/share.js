/**
 * share.js — URL-hash encode/decode for share links
 *
 * Hash format: <codec-byte><payload>
 *   'd' = deflate-raw compressed, base64url
 *   'u' = uncompressed, base64url (fallback when CompressionStream unavailable)
 *
 * Nothing is sent to a server. All encoding is client-side only.
 */

import { buildPlan, validatePlan, serializePlan } from "./plan.js";

const CODEC_COMPRESSED   = "d";
const CODEC_UNCOMPRESSED = "u";

// ── Encoding ──────────────────────────────────────────────────────────────────

/**
 * Plan → compressed base64url hash string (prefixed with codec byte).
 * Falls back to uncompressed base64url if CompressionStream is unavailable.
 * @param {import("./plan.js").Plan} plan
 * @returns {Promise<string>}
 */
export async function encodePlanToHash(plan) {
  const json = serializePlan(plan);
  const bytes = new TextEncoder().encode(json);

  if (typeof CompressionStream !== "undefined") {
    try {
      const compressed = await _compress(bytes);
      return CODEC_COMPRESSED + _bytesToBase64url(compressed);
    } catch {
      // Fallback to uncompressed on any compression error
    }
  }

  return CODEC_UNCOMPRESSED + _bytesToBase64url(bytes);
}

/**
 * Hash string → Plan|null (validated). Never throws.
 * @param {string} hash  (without leading '#')
 * @returns {Promise<import("./plan.js").Plan|null>}
 */
export async function decodeHashToPlan(hash) {
  try {
    if (!hash || hash.length < 2) return null;

    const codec = hash[0];
    const payload = hash.slice(1);

    let bytes;
    if (codec === CODEC_COMPRESSED) {
      const compressed = _base64urlToBytes(payload);
      bytes = await _decompress(compressed);
    } else if (codec === CODEC_UNCOMPRESSED) {
      bytes = _base64urlToBytes(payload);
    } else {
      return null; // unknown codec
    }

    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json);
    return validatePlan(parsed);
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
 * Read location.hash on boot; returns decoded Plan or null.
 * - Returns null when no hash is present.
 * - Returns the decoded Plan when the hash is valid.
 * - Throws an error when a hash IS present but cannot be decoded (malformed/truncated).
 *   Callers should catch this to show a "couldn't be opened" toast.
 * Strips the hash after reading in all cases so a later reload does not
 * re-trigger the share path.
 * @returns {Promise<import("./plan.js").Plan|null>}
 */
export async function readBootHash() {
  const raw = location.hash;
  if (!raw || raw.length <= 1) return null;

  // Strip leading '#'
  const hash = raw.slice(1);

  // Clear the hash from URL (without page reload)
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    // ignore (some environments don't support history API)
  }

  const plan = await decodeHashToPlan(hash);
  if (plan === null) {
    // Hash was present but undecodable — signal to caller to show a toast
    throw new Error("share-hash-decode-failed");
  }
  return plan;
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
