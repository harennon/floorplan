/**
 * io.js — sandboxed file write of Plan JSON to a designated plans dir (LLD 32).
 *
 * Security (Q5): filenames are reduced to a basename, forced to .json, joined
 * onto the plans dir, and the resolved path is re-verified to be inside the
 * plans dir before any write. No path traversal, no writes outside the sandbox.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Resolve the plans directory. Honours a client-declared MCP Root if provided,
 * else falls back to FLOORPLAN_MCP_PLANS_DIR, else a temp default.
 * @param {string|undefined} rootDir  a client-declared root (absolute), optional
 */
export function plansDir(rootDir) {
  if (rootDir) return path.resolve(rootDir);
  if (process.env.FLOORPLAN_MCP_PLANS_DIR) {
    return path.resolve(process.env.FLOORPLAN_MCP_PLANS_DIR);
  }
  return path.join(os.tmpdir(), "floorplan-mcp-plans");
}

/**
 * Sanitise a user-supplied filename to a safe basename ending in .json.
 * Rejects nothing here — always yields a safe name; traversal is neutralised by
 * path.basename and the inside-dir re-check in savePlanFile.
 * @param {string|undefined} filename
 */
export function safeFilename(filename) {
  let name = typeof filename === "string" && filename.trim() ? filename : "plan.json";
  name = path.basename(name); // strips any dir components incl. ../
  if (!name.toLowerCase().endsWith(".json")) name += ".json";
  // Guard against a basename that reduced to something empty/hidden-only.
  if (name === ".json" || name === "") name = "plan.json";
  return name;
}

/**
 * Write a serialized Plan JSON string to the sandboxed plans dir.
 * Returns { ok:true, path } or { ok:false, error }. Never throws.
 *
 * @param {string} json  serialized plan (serializePlan output)
 * @param {string|undefined} filename
 * @param {string|undefined} rootDir  client-declared root, optional
 */
export async function savePlanFile(json, filename, rootDir) {
  const dir = path.resolve(plansDir(rootDir));
  const name = safeFilename(filename);
  const target = path.resolve(dir, name);

  // Inside-dir re-check: safeFilename yields a bare basename (no separators), so
  // a correctly-sandboxed target is always a DIRECT child of the plans dir.
  // Compare the resolved parent, not a string prefix — a legitimate filename may
  // itself start with ".." (e.g. "..%2Fx.json", where %2F is a literal char).
  if (path.dirname(target) !== dir) {
    return { ok: false, error: "refusing to write outside the plans directory" };
  }

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(target, json, "utf8");
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: `could not write plan: ${err && err.message}` };
  }
}
