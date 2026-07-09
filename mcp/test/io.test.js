/**
 * Unit — I/O sandbox (io.js, security). LLD 32 Test reqs.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import * as session from "../src/session.js";
import * as tools from "../src/tools.js";
import { savePlanFile, safeFilename, plansDir } from "../src/io.js";

let dir;
beforeEach(async () => {
  session.resetAll();
  dir = await mkdtemp(path.join(os.tmpdir(), "fp-mcp-io-"));
  process.env.FLOORPLAN_MCP_PLANS_DIR = dir;
});
after(async () => {
  delete process.env.FLOORPLAN_MCP_PLANS_DIR;
});

test("save_plan writes a serialized plan file into the plans dir", async () => {
  session.newPlan();
  tools.tool_add_room({ rect: { x: 0, y: 0, w: 5, h: 7 } });
  const r = await tools.tool_save_plan({ filename: "studio" });
  assert.equal(r.ok, true);
  assert.equal(path.dirname(r.path), path.resolve(dir));
  const text = await readFile(r.path, "utf8");
  const doc = JSON.parse(text);
  assert.equal(doc.app, "floorplan");
  assert.equal(doc.walls.rooms.length, 1);
});

test("path-traversal filenames are reduced to a safe basename inside the dir", async () => {
  session.newPlan();
  for (const evil of ["../evil", "../../etc/passwd", "/tmp/abs", "..%2Fx"]) {
    const r = await savePlanFile("{}", evil, dir);
    assert.equal(r.ok, true, `wrote for ${evil}`);
    // Resolved path must be a DIRECT child of the plans dir (no traversal).
    assert.equal(path.dirname(r.path), path.resolve(dir), `${evil} stayed inside dir`);
    assert.ok(r.path.endsWith(".json"));
  }
});

test("safeFilename forces a .json basename", () => {
  assert.equal(safeFilename("../../foo"), "foo.json");
  assert.equal(safeFilename("bar.json"), "bar.json");
  assert.equal(safeFilename(undefined), "plan.json");
  assert.equal(safeFilename(""), "plan.json");
});

test("missing plans dir is created on demand", async () => {
  const nested = path.join(dir, "deep", "nested");
  const r = await savePlanFile("{}", "x.json", nested);
  assert.equal(r.ok, true);
  const s = await stat(nested);
  assert.ok(s.isDirectory());
});

test("creation failure returns {ok:false} without crashing", async () => {
  // Point the dir at a path under a regular FILE so mkdir must fail.
  const filePath = path.join(dir, "afile");
  await (await import("node:fs/promises")).writeFile(filePath, "x");
  const badDir = path.join(filePath, "sub"); // parent is a file → mkdir fails
  const r = await savePlanFile("{}", "x.json", badDir);
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test("plansDir honours env override and Root", () => {
  assert.equal(plansDir("/some/root"), path.resolve("/some/root"));
  assert.equal(plansDir(undefined), path.resolve(dir)); // from env
});
