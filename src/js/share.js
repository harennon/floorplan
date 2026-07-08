/**
 * share.js — URL-hash codec (LLD 15)
 *
 * encode(doc)  → base64url payload (gzip when available, else raw)
 * decode(hash) → PlanDoc | null
 *
 * Payload format:  <prefix_char><data>
 *   "1" prefix = gzip-compressed then base64url
 *   "0" prefix = raw UTF-8 JSON then base64url (fallback)
 *
 * Nothing is sent to a server.
 */

import { validate } from "./persist.js";

const HASH_PREFIX = "plan=";
const LARGE_LINK_WARN = 12000; // chars

// ── Encoding helpers ─────────────────────────────────────────────────────────

/**
 * Encode a Uint8Array to base64url (no padding).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function _bytesToBase64url(bytes) {
  // btoa works on binary strings
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Decode a base64url string to Uint8Array.
 * @param {string} b64url
 * @returns {Uint8Array}
 */
function _base64urlToBytes(b64url) {
  const b64 = b64url
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  // Re-add padding
  const padded = b64 + "===".slice((b64.length % 4) || 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Compress bytes via CompressionStream("gzip").
 * Returns null if CompressionStream is unavailable.
 * @param {Uint8Array} input
 * @returns {Promise<Uint8Array|null>}
 */
async function _compress(input) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(input);
    writer.close();
    const chunks = [];
    const reader = cs.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    // Concatenate
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Decompress gzip bytes via DecompressionStream("gzip").
 * Returns null on any failure.
 * @param {Uint8Array} input
 * @returns {Promise<Uint8Array|null>}
 */
async function _decompress(input) {
  if (typeof DecompressionStream === "undefined") return null;
  try {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(input);
    writer.close();
    const chunks = [];
    const reader = ds.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Encode a PlanDoc to a base64url payload string (no leading '#').
 * Tries gzip first; falls back to uncompressed.
 * @param {any} doc  PlanDoc
 * @returns {Promise<string>}
 */
export async function encode(doc) {
  const json = JSON.stringify(doc);
  const enc = new TextEncoder();
  const bytes = enc.encode(json);

  const compressed = await _compress(bytes);
  if (compressed !== null) {
    return "1" + _bytesToBase64url(compressed);
  }
  // Fallback: uncompressed
  return "0" + _bytesToBase64url(bytes);
}

/**
 * Decode a payload string back to a PlanDoc, or null on any failure.
 * @param {string} payload
 * @returns {Promise<any|null>}
 */
export async function decode(payload) {
  if (typeof payload !== "string" || payload.length < 2) return null;
  try {
    const prefix = payload[0];
    const data = payload.slice(1);
    const bytes = _base64urlToBytes(data);

    let jsonStr;
    if (prefix === "1") {
      const decompressed = await _decompress(bytes);
      if (decompressed === null) return null;
      const dec = new TextDecoder();
      jsonStr = dec.decode(decompressed);
    } else if (prefix === "0") {
      const dec = new TextDecoder();
      jsonStr = dec.decode(bytes);
    } else {
      return null;
    }

    const parsed = JSON.parse(jsonStr);
    return validate(parsed);
  } catch {
    return null;
  }
}

/**
 * Read the `plan=` payload from location.hash. Returns null if absent or unrelated.
 * @returns {string|null}
 */
export function readHash() {
  const hash = location.hash;
  if (!hash) return null;
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.startsWith(HASH_PREFIX)) return null;
  const payload = raw.slice(HASH_PREFIX.length);
  return payload.length > 0 ? payload : null;
}

/**
 * Build the full shareable URL for a payload.
 * @param {string} payload
 * @returns {string}
 */
export function buildShareURL(payload) {
  return location.origin + location.pathname + "#" + HASH_PREFIX + payload;
}

/**
 * Remove the hash from the URL without triggering a reload.
 */
export function clearHash() {
  if (history.replaceState) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

/** Soft warning threshold for large share links. */
export const LARGE_LINK_CHARS = LARGE_LINK_WARN;
