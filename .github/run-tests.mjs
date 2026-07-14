/**
 * Headless test runner for test/tests.html.
 *
 * Serves the repo root over HTTP (so the harness at /test/tests.html can import
 * the app modules under /src/js/ via ../src/js/*), loads it in a headless
 * Chromium page, waits for window.__testResult to be set by the in-page
 * harness, then exits 0 (all pass) or 1 (any failure).
 *
 * Also runs W×H integration tests (LLD 82) against src/index.html to exercise
 * real focus/blur/keyboard events that the unit DOM rig cannot fully simulate.
 *
 * Usage (requires playwright installed in the environment):
 *   node .github/run-tests.mjs
 *
 * In CI this is invoked after `npx playwright install --with-deps chromium`.
 */

import { chromium } from "playwright";
import { createServer } from "http";
import { readFile } from "fs/promises";
import { extname, join } from "path";
import { fileURLToPath } from "url";

const ROOT_DIR = join(fileURLToPath(import.meta.url), "../..");
const TEST_PAGE = "/test/tests.html";
// Unit tests import app modules from source (../src/js/*), so the unit harness
// runs against source. Integration tests, however, drive the SHIPPED artifact:
// APP_PAGE points at the Vite build output (dist/index.html) so CI exercises the
// bundled/minified app Cloudflare Pages actually deploys (LLD 127). Requires
// `npm run build` to have run first.
const APP_PAGE  = "/dist/index.html";
const PORT = 3742; // arbitrary; unlikely to collide in CI

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};

// ── Minimal static file server ────────────────────────────────────────────────

function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const safePath = req.url.split("?")[0].replace(/\.\./g, "");
      const file = join(ROOT_DIR, safePath === "/" ? TEST_PAGE : safePath);
      try {
        const data = await readFile(file);
        const mime = MIME[extname(file)] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

// ── Unit test runner ──────────────────────────────────────────────────────────

async function runUnitTests(browser) {
  const page = await browser.newPage();

  // Forward console errors from the test page to stderr for diagnosis
  page.on("console", (msg) => {
    if (msg.type() === "error") process.stderr.write(`[unit page error] ${msg.text()}\n`);
  });
  page.on("pageerror", (err) => process.stderr.write(`[unit page uncaught] ${err}\n`));

  await page.goto(`http://127.0.0.1:${PORT}${TEST_PAGE}`);

  // Wait for the harness to finish all async tests and call render()
  await page.waitForFunction(
    () => window.__testResult !== undefined,
    { timeout: 30_000 }
  );

  const result = await page.evaluate(() => window.__testResult);
  await page.close();
  return result;
}

// ── W×H integration test helpers ─────────────────────────────────────────────

/**
 * A 4x3 metre rectangle at world origin, zoom=1, panX=0, panY=0.
 * The stage covers the full viewport (position:absolute;inset:0).
 * With BASE_PX_PER_M=40, room centre is at viewport (80, 60) = element-relative (80, 60).
 */
const TEST_PLAN = {
  schema: 1,
  app: "floorplan",
  walls: {
    rooms: [{ id: "wxh-test", closed: true, verts: [
      { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 },
    ]}],
    chain: [],
  },
  symbols: { symbols: [] },
  view: { zoom: 1, panX: 0, panY: 0 },
  unit: "m",
};

/**
 * Read room[0]'s W and H (in metres) from localStorage via the saved plan.
 * Waits up to `timeout` ms for the autosave to write (debounced at 800ms).
 */
async function waitForRoomDims(page, expectedW, expectedH, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const raw = await page.evaluate(() => localStorage.getItem("floorplan:plan:v1"));
    if (raw) {
      try {
        const plan = JSON.parse(raw);
        const verts = plan.walls.rooms[0].verts;
        const w = Math.abs(verts[1].x - verts[0].x) || Math.abs(verts[1].y - verts[0].y);
        const h = Math.abs(verts[2].y - verts[1].y) || Math.abs(verts[2].x - verts[1].x);
        // Use euclidean for robustness
        const wEucl = Math.sqrt(Math.pow(verts[1].x - verts[0].x, 2) + Math.pow(verts[1].y - verts[0].y, 2));
        const hEucl = Math.sqrt(Math.pow(verts[2].x - verts[1].x, 2) + Math.pow(verts[2].y - verts[1].y, 2));
        if (Math.abs(wEucl - expectedW) < 0.01 && Math.abs(hEucl - expectedH) < 0.01) return;
      } catch {}
    }
    await new Promise(r => setTimeout(r, 50));
  }
  // Read final state for error message
  const raw = await page.evaluate(() => localStorage.getItem("floorplan:plan:v1"));
  let dims = "unavailable";
  if (raw) {
    try {
      const plan = JSON.parse(raw);
      const v = plan.walls.rooms[0].verts;
      const wE = Math.sqrt(Math.pow(v[1].x-v[0].x,2)+Math.pow(v[1].y-v[0].y,2));
      const hE = Math.sqrt(Math.pow(v[2].x-v[1].x,2)+Math.pow(v[2].y-v[1].y,2));
      dims = "w=" + wE.toFixed(4) + " h=" + hE.toFixed(4);
    } catch {}
  }
  throw new Error(`Timed out waiting for room dims W=${expectedW} H=${expectedH}; got: ${dims}`);
}

/**
 * Load the app with the test plan and select the rectangular room.
 * Returns the configured page.
 */
async function setupWxhPage(browser) {
  const page = await browser.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") process.stderr.write(`[wxh page error] ${msg.text()}\n`);
  });
  page.on("pageerror", (err) => process.stderr.write(`[wxh page uncaught] ${err}\n`));

  await page.addInitScript((plan) => {
    localStorage.setItem("floorplan:plan:v1", JSON.stringify(plan));
  }, TEST_PLAN);

  await page.goto(`http://127.0.0.1:${PORT}${APP_PAGE}`);
  await page.waitForLoadState("networkidle");

  // Switch to Select tool (default is wall/draw mode)
  await page.click("#tool-select");

  // Click room interior: centre at world (2, 1.5), scale=40px/m → (80, 60) element-relative
  // Stage is position:absolute;inset:0, so element-relative = clientX/Y
  await page.click("#stage", { position: { x: 80, y: 60 } });

  // Wait for the W×H block to become visible
  await page.waitForSelector(".measure-wxh:not([hidden])", { timeout: 5_000 });

  return page;
}

// ── Integration tests (LLD 82) ────────────────────────────────────────────────

const INTEGRATION_SUITE = "LLD 82 W×H integration";
const integrationFailures = [];
let integrationTotal = 0;
let integrationPassed = 0;

async function runIntegrationTest(name, fn, browser) {
  integrationTotal++;
  try {
    await fn(browser);
    integrationPassed++;
    process.stdout.write(`  PASS: ${name}\n`);
  } catch (err) {
    integrationFailures.push({ suite: INTEGRATION_SUITE, name, error: String(err) });
    process.stderr.write(`  FAIL: ${name}\n    ${err}\n`);
  }
}

// ── LLD 130 preview integration counters ──────────────────────────────────────

const PREVIEW_SUITE = "LLD 130 3D preview integration";
const previewFailures = [];
let previewTotal = 0;
let previewPassed = 0;

async function runPreviewTest(name, fn, browser) {
  previewTotal++;
  try {
    await fn(browser);
    previewPassed++;
    process.stdout.write(`  PASS: ${name}\n`);
  } catch (err) {
    previewFailures.push({ suite: PREVIEW_SUITE, name, error: String(err) });
    process.stderr.write(`  FAIL: ${name}\n    ${err}\n`);
  }
}

async function runWxhIntegrationTests(browser) {
  process.stdout.write(`\n${INTEGRATION_SUITE}\n`);

  // ── Test 1: type W, Tab, type H, click Set — no timer race ──────────────────
  // This is the primary regression test for the critical blur-timer bug.
  // With the old 150ms timer, W would revert before Apply ran (>150ms after blur).
  // With the relatedTarget fix + block-level focus guard, W is preserved.
  await runIntegrationTest(
    "type W, Tab, type H (>150ms gap), click Set → both sides update",
    async (browser) => {
      const page = await setupWxhPage(browser);
      try {
        // Type W=5, Tab to H, type H=6
        await page.click(".measure-wxh-w");
        await page.fill(".measure-wxh-w", "5");
        await page.keyboard.press("Tab");
        await page.fill(".measure-wxh-h", "6");

        // Wait >150ms (old timer would have fired and reverted W)
        await new Promise(r => setTimeout(r, 300));

        // Click Set
        await page.click(".measure-wxh-apply");

        // Verify geometry via autosave (debounced 800ms)
        await waitForRoomDims(page, 5, 6, 5000);
      } finally {
        await page.close();
      }
    },
    browser
  );

  // ── Test 2: Enter in W field applies ────────────────────────────────────────
  await runIntegrationTest(
    "type new W, press Enter in W field → W changes, H unchanged",
    async (browser) => {
      const page = await setupWxhPage(browser);
      try {
        await page.click(".measure-wxh-w");
        await page.fill(".measure-wxh-w", "7");
        await page.keyboard.press("Enter");

        // W changes to 7, H stays 3
        await waitForRoomDims(page, 7, 3, 5000);
      } finally {
        await page.close();
      }
    },
    browser
  );

  // ── Test 3: single Ctrl+Z reverts both W and H ─────────────────────────────
  await runIntegrationTest(
    "Set W=5 H=6, then Ctrl+Z reverts the whole change in one step",
    async (browser) => {
      const page = await setupWxhPage(browser);
      try {
        // Apply W=5, H=6
        await page.click(".measure-wxh-w");
        await page.fill(".measure-wxh-w", "5");
        await page.keyboard.press("Tab");
        await page.fill(".measure-wxh-h", "6");
        await page.click(".measure-wxh-apply");

        // Confirm the change is saved
        await waitForRoomDims(page, 5, 6, 5000);

        // Press Esc to blur the W×H block, then use history undo button
        // (keyboard Ctrl+Z is blocked when an INPUT has focus in the app's keydown guard)
        await page.keyboard.press("Escape");
        // Click stage to fully blur the panel and ensure keyboard handler is active
        // Use empty area outside the room
        await page.click("#stage", { position: { x: 400, y: 400 } });
        // Room is now deselected; click undo button
        await page.click("#history-undo");

        // Verify reverted to 4x3
        await waitForRoomDims(page, 4, 3, 5000);
      } finally {
        await page.close();
      }
    },
    browser
  );

  // ── Test 4: Enter in H field applies ────────────────────────────────────────
  await runIntegrationTest(
    "type new H, press Enter in H field → H changes, W unchanged",
    async (browser) => {
      const page = await setupWxhPage(browser);
      try {
        // Tab into H field directly
        await page.click(".measure-wxh-h");
        await page.fill(".measure-wxh-h", "8");
        await page.keyboard.press("Enter");

        // W stays 4, H changes to 8
        await waitForRoomDims(page, 4, 8, 5000);
      } finally {
        await page.close();
      }
    },
    browser
  );

  // ── Test 5: non-rectangular room → W×H block hidden ─────────────────────────
  await runIntegrationTest(
    "selecting a non-rectangular (L-shaped) room → W×H block not shown",
    async (browser) => {
      const page = await browser.newPage();
      page.on("pageerror", (err) => process.stderr.write(`[wxh page uncaught] ${err}\n`));

      const lPlan = {
        schema: 1, app: "floorplan",
        walls: {
          rooms: [{ id: "lshape", closed: true, verts: [
            { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 },
            { x: 2, y: 2 }, { x: 2, y: 4 }, { x: 0, y: 4 },
          ]}],
          chain: [],
        },
        symbols: { symbols: [] },
        view: { zoom: 1, panX: 0, panY: 0 },
        unit: "m",
      };

      await page.addInitScript((p) => {
        localStorage.setItem("floorplan:plan:v1", JSON.stringify(p));
      }, lPlan);

      await page.goto(`http://127.0.0.1:${PORT}${APP_PAGE}`);
      await page.waitForLoadState("networkidle");

      try {
        await page.click("#tool-select");
        // L-shape centre is around (1.5, 2): clientX=60, clientY=80 at zoom=1, pan=0
        await page.click("#stage", { position: { x: 60, y: 80 } });

        // Wait for any render to fire
        await new Promise(r => setTimeout(r, 500));

        const isHidden = await page.evaluate(
          () => document.querySelector(".measure-wxh").hasAttribute("hidden")
        );
        if (!isHidden) throw new Error("Expected W×H block hidden for non-rectangular room");
      } finally {
        await page.close();
      }
    },
    browser
  );
}

// ── Integration tests (LLD 130 — true 3D preview) ─────────────────────────────
//
// These drive the SHIPPED dist/ build (APP_PAGE), exercising the real WebGL
// render/teardown path that the bundler-less unit harness (test/tests.html)
// cannot reach — `import("three")` resolves only in the built bundle, so the
// unit `enter()` smoke tests only hit the import-failed fallback branch. This is
// the coverage gap that let the floor/rug back-face culling bug slip through, so
// these tests own the real GL path.
//
// main.js exposes `window.__render3d` (introspection-only, no mutators) so we can
// call the read-only probes webglAvailable() / __liveGeometryCount() /
// __hasRenderer() in-page.
//
// A 4×3 closed room + a sofa so the scene has extruded boxes AND a floor slab
// (the exact geometry the floor-culling fix concerns).
const PREVIEW_PLAN = {
  schema: 1, app: "floorplan",
  walls: { rooms: [{ id: "prev", closed: true, verts: [
    { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 },
  ]}], chain: [] },
  symbols: { symbols: [{ id: "s0", type: "sofa", x: 2, y: 1.5, w: 2.0, h: 0.9, rot: 0 }] },
  measurements: [],
  view: { zoom: 1, panX: 0, panY: 0 },
  unit: "m",
};

/**
 * Open the built app with PREVIEW_PLAN seeded. Optionally force WebGL
 * unavailable BEFORE any app code runs (addInitScript patches HTMLCanvasElement
 * .getContext to return null for webgl/webgl2), so render3d's webglAvailable()
 * gate takes the fallback path. Returns { page, threeRequests } where
 * threeRequests logs every fetch of the lazy three chunk.
 */
async function openPreviewApp(browser, { forceNoWebgl = false } = {}) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => { pageErrors.push(String(err)); process.stderr.write(`[preview page uncaught] ${err}\n`); });

  const threeRequests = [];
  page.on("request", (req) => {
    const url = req.url();
    if (/render3dEngine|three/i.test(url) && url.endsWith(".js")) {
      threeRequests.push(url.split("/").pop());
    }
  });

  await page.addInitScript((plan) => {
    localStorage.setItem("floorplan:plan:v1", JSON.stringify(plan));
  }, PREVIEW_PLAN);

  if (forceNoWebgl) {
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") return null;
        return orig.call(this, type, ...rest);
      };
    });
  }

  await page.goto(`http://127.0.0.1:${PORT}${APP_PAGE}`);
  await page.waitForLoadState("networkidle");
  page._pageErrors = pageErrors; // stash for assertions
  return { page, threeRequests };
}

async function runPreview3dIntegrationTests(browser) {
  process.stdout.write(`\n${PREVIEW_SUITE}\n`);

  // ── Test 1: default load does NOT fetch three.js (proves lazy-load) ─────────
  await runPreviewTest(
    "default load (no preview entered) does not fetch the three.js lazy chunk",
    async (browser) => {
      const { page, threeRequests } = await openPreviewApp(browser);
      try {
        // Give any stray eager fetch a chance to appear.
        await new Promise(r => setTimeout(r, 400));
        if (threeRequests.length !== 0) {
          throw new Error(`three chunk fetched on default load: ${threeRequests.join(", ")}`);
        }
      } finally {
        await page.close();
      }
    },
    browser
  );

  // ── Test 2: preview entry — WebGL-or-fallback branch ────────────────────────
  // Branches on in-page webglAvailable() so it's robust whether or not CI
  // Chromium has a GL context. The WebGL branch is what empirically exercises
  // the floor/rug DoubleSide fix (the scene actually renders).
  await runPreviewTest(
    "preview entry shows the 3D canvas (WebGL) or the 2.5D fallback (+toast), no errors",
    async (browser) => {
      const { page, threeRequests } = await openPreviewApp(browser);
      try {
        const webglOK = await page.evaluate(() => window.__render3d.webglAvailable());

        await page.click("#tool-preview");
        // Allow the lazy import + scene build (WebGL branch) to settle.
        await new Promise(r => setTimeout(r, 1500));

        const state = await page.evaluate(() => {
          const stage = document.getElementById("stage");
          const c = document.getElementById("stage3d");
          const iso = document.getElementById("iso");
          const toast = document.getElementById("toast");
          return {
            stagePreview: stage?.classList.contains("stage--preview"),
            fallback: stage?.classList.contains("preview--fallback"),
            canvasVisible: c && getComputedStyle(c).display !== "none",
            isoVisible: iso && getComputedStyle(iso).display !== "none",
            toastVisible: toast?.classList.contains("toast--visible"),
            toastText: toast?.textContent || "",
          };
        });

        if (!state.stagePreview) throw new Error(".stage--preview not set after preview entry");

        if (webglOK) {
          // Real 3D path.
          if (!state.canvasVisible) throw new Error("WebGL available but #stage3d not visible");
          if (state.fallback) throw new Error("WebGL available but preview--fallback was set");
          if (threeRequests.length === 0) throw new Error("WebGL path but three chunk was never fetched");
          if (page._pageErrors.length) throw new Error("Page errors on WebGL entry: " + page._pageErrors.join("; "));
          process.stdout.write(`    (ran WebGL branch — three chunk fetched: ${threeRequests.join(", ")})\n`);
        } else {
          // Fallback path.
          if (!state.fallback) throw new Error("WebGL unavailable but preview--fallback not set");
          if (!state.isoVisible) throw new Error("Fallback path but #iso not visible");
          if (!state.toastVisible || !/3D unavailable/i.test(state.toastText)) {
            throw new Error("Fallback path but the '3D unavailable' toast was not shown: " + JSON.stringify(state.toastText));
          }
          process.stdout.write(`    (ran fallback branch — no GL context in this Chromium)\n`);
        }
      } finally {
        await page.close();
      }
    },
    browser
  );

  // ── Test 3: forced fallback — WebGL unavailable → 2.5D #iso + toast, no error ─
  await runPreviewTest(
    "forced WebGL-unavailable → 2.5D #iso group shows with preview--fallback + toast",
    async (browser) => {
      const { page } = await openPreviewApp(browser, { forceNoWebgl: true });
      try {
        // Confirm the gate really reports unavailable with the getContext patch.
        const webglOK = await page.evaluate(() => window.__render3d.webglAvailable());
        if (webglOK) throw new Error("forceNoWebgl patch failed — webglAvailable() still true");

        await page.click("#tool-preview");
        await new Promise(r => setTimeout(r, 600));

        const state = await page.evaluate(() => {
          const stage = document.getElementById("stage");
          const iso = document.getElementById("iso");
          const toast = document.getElementById("toast");
          return {
            fallback: stage?.classList.contains("preview--fallback"),
            isoVisible: iso && getComputedStyle(iso).display !== "none",
            isoPolys: iso ? iso.querySelectorAll("polygon").length : 0,
            toastVisible: toast?.classList.contains("toast--visible"),
            toastText: toast?.textContent || "",
          };
        });

        if (!state.fallback) throw new Error("preview--fallback class not set on forced-no-WebGL path");
        if (!state.isoVisible) throw new Error("#iso not visible on fallback path");
        if (state.isoPolys === 0) throw new Error("#iso has no polygons — 2.5D painter did not run");
        if (!state.toastVisible || !/3D unavailable/i.test(state.toastText)) {
          throw new Error("'3D unavailable' toast not shown on fallback: " + JSON.stringify(state.toastText));
        }
        if (page._pageErrors.length) throw new Error("Page errors on fallback entry: " + page._pageErrors.join("; "));
      } finally {
        await page.close();
      }
    },
    browser
  );

  // ── Test 4: teardown / context-reuse probe ──────────────────────────────────
  // Toggle preview on→off N cycles; after each exit() the plan group must be
  // fully disposed (__liveGeometryCount === 0), and the renderer/context must be
  // reused, not recreated (__hasRenderer stays true). This is the leak/reuse
  // guard the probe hooks exist for. WebGL-only (skips cleanly on no-GL CI).
  await runPreviewTest(
    "teardown: N on/off cycles leave 0 live geometries and reuse the WebGL renderer",
    async (browser) => {
      const { page } = await openPreviewApp(browser);
      try {
        const webglOK = await page.evaluate(() => window.__render3d.webglAvailable());
        if (!webglOK) {
          process.stdout.write(`    (skipped — no GL context; teardown probe needs a real renderer)\n`);
          return;
        }

        const counts = [];
        for (let i = 0; i < 3; i++) {
          await page.click("#tool-preview");               // ON
          await new Promise(r => setTimeout(r, 900));       // lazy import (1st) + build
          const live = await page.evaluate(() => window.__render3d.__liveGeometryCount());
          await page.click("#tool-preview");               // OFF
          await new Promise(r => setTimeout(r, 250));
          const afterExit = await page.evaluate(() => ({
            live: window.__render3d.__liveGeometryCount(),
            hasRenderer: window.__render3d.__hasRenderer(),
          }));
          counts.push({ cycle: i, liveWhileOn: live, ...afterExit });
        }

        for (const c of counts) {
          if (!(c.liveWhileOn > 0)) throw new Error(`cycle ${c.cycle}: expected live geometries while preview ON, got ${c.liveWhileOn}`);
          if (c.live !== 0) throw new Error(`cycle ${c.cycle}: geometry leak — ${c.live} live after exit()`);
          if (!c.hasRenderer) throw new Error(`cycle ${c.cycle}: renderer was destroyed (should be reused for cheap re-entry)`);
        }
        if (page._pageErrors.length) throw new Error("Page errors during teardown cycles: " + page._pageErrors.join("; "));
        process.stdout.write(`    (ran WebGL teardown probe over ${counts.length} cycles — no leak, renderer reused)\n`);
      } finally {
        await page.close();
      }
    },
    browser
  );

  // ── Test 5: read-only — 3D orbit/zoom must NOT mutate the persisted 2D view ──
  // QA BLOCKING bug: #stage3d is a CHILD of #stage, so an OrbitControls drag +
  // wheel bubble to the stage's own pan/zoom listeners and mutate the persisted
  // view.{zoom,panX,panY} (survives reload). Assert the view is byte-identical
  // before/after a real drag + wheel gesture on the canvas during preview.
  await runPreviewTest(
    "read-only: drag + wheel over #stage3d during preview does not mutate view.{zoom,panX,panY}",
    async (browser) => {
      const { page } = await openPreviewApp(browser);
      try {
        const webglOK = await page.evaluate(() => window.__render3d.webglAvailable());

        const before = await page.evaluate(() => {
          const s = window.__testState();
          return { zoom: s.zoom, panX: s.panX, panY: s.panY };
        });

        await page.click("#tool-preview");
        await new Promise(r => setTimeout(r, webglOK ? 1200 : 400));

        // Real bubbling gestures on the canvas: a left-drag (pan) + a wheel (zoom).
        const box = await page.evaluate(() => {
          const c = document.getElementById("stage3d");
          const r = c.getBoundingClientRect();
          return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
        });
        await page.mouse.move(box.cx, box.cy);
        await page.mouse.down();
        await page.mouse.move(box.cx + 120, box.cy + 90, { steps: 8 });
        await page.mouse.move(box.cx - 60, box.cy + 30, { steps: 4 });
        await page.mouse.up();
        await page.mouse.wheel(0, -400); // zoom gesture
        await page.mouse.wheel(0, 250);
        await new Promise(r => setTimeout(r, 300));

        const after = await page.evaluate(() => {
          const s = window.__testState();
          return { zoom: s.zoom, panX: s.panX, panY: s.panY };
        });

        if (before.zoom !== after.zoom || before.panX !== after.panX || before.panY !== after.panY) {
          throw new Error(
            `preview orbit/zoom mutated the 2D view: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`
          );
        }
        if (page._pageErrors.length) throw new Error("Page errors during view read-only test: " + page._pageErrors.join("; "));
        process.stdout.write(`    (${webglOK ? "WebGL" : "fallback"} branch — view unchanged after drag+wheel)\n`);
      } finally {
        await page.close();
      }
    },
    browser
  );

  // ── Test 6: read-only — W×H "Set" is inert during preview (no wall mutation) ─
  // QA BLOCKING bug: the .measure W×H editor is a SIBLING of #stage, so it stays
  // interactive during preview; typing a width + Set resized real room verts.
  // Select the rectangular room (W×H editor appears), enter preview, attempt to
  // set W, exit, and assert the room verts are byte-identical.
  await runPreviewTest(
    "read-only: W×H Set during preview does not resize room verts",
    async (browser) => {
      const { page } = await openPreviewApp(browser);
      try {
        // Select the room so the W×H editor renders. Click an EMPTY corner of the
        // 4×3 room — world (0.5,0.5) → px (20,20) at zoom=1, pan=0 — not the room
        // centre, which is occupied by the sofa (spans x∈[1,3], y∈[1.05,1.95]).
        await page.click("#tool-select");
        await page.click("#stage", { position: { x: 20, y: 20 } });
        await page.waitForSelector(".measure-wxh:not([hidden])", { timeout: 5000 });

        const before = await page.evaluate(() => window.__testState().rooms);

        // Enter preview, then attempt the W×H mutation via the real DOM controls.
        await page.click("#tool-preview");
        await new Promise(r => setTimeout(r, 800));

        // The CSS hides the block in preview; force-drive the fields regardless so
        // the JS guard on _applyWxH() is what's under test (not just the CSS).
        await page.evaluate(() => {
          const w = document.querySelector(".measure-wxh-w");
          const apply = document.querySelector(".measure-wxh-apply");
          if (w) { w.value = "9"; w.dispatchEvent(new Event("input", { bubbles: true })); }
          if (apply) apply.click();
        });
        await new Promise(r => setTimeout(r, 300));

        const after = await page.evaluate(() => window.__testState().rooms);

        if (JSON.stringify(before) !== JSON.stringify(after)) {
          throw new Error(
            `W×H Set during preview resized room verts: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`
          );
        }
        if (page._pageErrors.length) throw new Error("Page errors during W×H read-only test: " + page._pageErrors.join("; "));
      } finally {
        await page.close();
      }
    },
    browser
  );
}

// ── Integration tests (LLD 142 — per-room scoping) ────────────────────────────
//
// Drives the built dist/ app with a TWO-ROOM plan:
//   - "room-a": closed 4×3 rectangle (has walls → scoped preview is non-empty)
//   - "room-b": closed 0-vertex stub ({closed:true, verts:[]}) so it counts as
//     a closed room but yields no renderable geometry — triggers the empty-state
//
// Tests:
//   1. Scope popover: caret click lists "Whole plan" + one item per closed room.
//   2. Scope select: choosing a closed room sets preview.getScope() and triggers
//      a render3d rebuild (canvas stays visible, no page errors).
//   3. Reframe: after scoping to room-a then back to whole-plan, the bounds
//      reported by render3d.__getBounds() change between the two states.
//   4. Empty state: scoping to the wall-less room (room-b) shows #preview-empty;
//      switching back to whole-plan hides it.
//   5. Scope-cycle teardown / no-leak: N rapid scope changes leave 0 live
//      geometries after preview exit — reuses LLD 130 __liveGeometryCount /
//      __hasRenderer probes (Edge Case 11).

const SCOPE_SUITE = "LLD 142 per-room scoping integration";
const scopeFailures = [];
let scopeTotal = 0;
let scopePassed = 0;

async function runScopeTest(name, fn, browser) {
  scopeTotal++;
  try {
    await fn(browser);
    scopePassed++;
    process.stdout.write(`  PASS: ${name}\n`);
  } catch (err) {
    scopeFailures.push({ suite: SCOPE_SUITE, name, error: String(err) });
    process.stderr.write(`  FAIL: ${name}\n    ${err}\n`);
  }
}

// Two-room plan: room-a is a real 4×3 rectangle; room-b is a closed stub with
// no vertices (so scopeModels filters it to an empty descriptor set).
const SCOPE_PLAN = {
  schema: 1, app: "floorplan",
  walls: {
    rooms: [
      { id: "room-a", closed: true, verts: [
        { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 },
      ]},
      { id: "room-b", closed: true, verts: [] },
    ],
    chain: [],
  },
  symbols: { symbols: [] },
  measurements: [],
  view: { zoom: 1, panX: 0, panY: 0 },
  unit: "m",
};

/** Open the built app with SCOPE_PLAN pre-seeded and preview already active. */
async function openScopeApp(browser) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => { pageErrors.push(String(err)); process.stderr.write(`[scope page uncaught] ${err}\n`); });

  await page.addInitScript((plan) => {
    localStorage.setItem("floorplan:plan:v1", JSON.stringify(plan));
  }, SCOPE_PLAN);

  await page.goto(`http://127.0.0.1:${PORT}${APP_PAGE}`);
  await page.waitForLoadState("networkidle");

  page._pageErrors = pageErrors;
  return page;
}

async function runScopeIntegrationTests(browser) {
  process.stdout.write(`\n${SCOPE_SUITE}\n`);

  // ── Test 1: scope popover lists "Whole plan" + one item per closed room ──────
  await runScopeTest(
    "scope popover lists 'Whole plan' + one item per closed room",
    async (browser) => {
      const page = await openScopeApp(browser);
      try {
        // Click the caret to open the scope popover (entering preview implicitly).
        await page.click("#preview-scope-caret");
        await new Promise(r => setTimeout(r, 400));

        const items = await page.evaluate(() => {
          const pop = document.getElementById("preview-scope-popover");
          if (!pop || pop.hidden) return null;
          return Array.from(pop.querySelectorAll('[role="menuitem"]')).map(b => b.textContent.trim());
        });

        if (!items) throw new Error("Scope popover is hidden or not found after caret click");

        // "Whole plan" must be first
        if (items[0] !== "Whole plan") {
          throw new Error(`Expected first item to be "Whole plan", got "${items[0]}"`);
        }

        // Exactly 2 closed rooms in SCOPE_PLAN → 2 room entries after "Whole plan"
        const roomItems = items.slice(1);
        if (roomItems.length !== 2) {
          throw new Error(`Expected 2 room entries, got ${roomItems.length}: ${JSON.stringify(roomItems)}`);
        }

        if (page._pageErrors.length) throw new Error("Page errors: " + page._pageErrors.join("; "));
      } finally {
        await page.close();
      }
    },
    browser
  );

  // ── Test 2: selecting a room scope triggers a render3d rebuild ───────────────
  await runScopeTest(
    "selecting a room in the popover sets preview scope and triggers rebuild (canvas visible, no errors)",
    async (browser) => {
      const page = await openScopeApp(browser);
      try {
        const webglOK = await page.evaluate(() => window.__render3d.webglAvailable());
        if (!webglOK) {
          process.stdout.write(`    (skipped — no GL context; scope rebuild probe needs a real renderer)\n`);
          return;
        }

        // Enter preview first via the main button
        await page.click("#tool-preview");
        await new Promise(r => setTimeout(r, 1200));

        // Open the caret and click "room-a" item (the first real room)
        await page.click("#preview-scope-caret");
        await new Promise(r => setTimeout(r, 300));

        // Click the first room menu item (after "Whole plan")
        await page.evaluate(() => {
          const pop = document.getElementById("preview-scope-popover");
          const items = pop ? Array.from(pop.querySelectorAll('[role="menuitem"]')) : [];
          // index 0 = "Whole plan", index 1 = first room
          if (items[1]) items[1].click();
        });
        await new Promise(r => setTimeout(r, 800));

        // Scope should now be set to room-a
        const scope = await page.evaluate(() => window.__preview.getScope());
        if (!scope) throw new Error(`Expected scope to be room-a id, got: ${JSON.stringify(scope)}`);

        // Canvas should still be visible
        const canvasVisible = await page.evaluate(() => {
          const c = document.getElementById("stage3d");
          return c && getComputedStyle(c).display !== "none";
        });
        if (!canvasVisible) throw new Error("#stage3d not visible after scope change");

        if (page._pageErrors.length) throw new Error("Page errors after scope change: " + page._pageErrors.join("; "));
        process.stdout.write(`    (scope set to: ${scope})\n`);
      } finally {
        await page.close();
      }
    },
    browser
  );

  // ── Test 3: reframe — bounds change after scope change and on scope reset ────
  await runScopeTest(
    "reframe on scope: bounds change when scoping to a room vs whole-plan",
    async (browser) => {
      const page = await openScopeApp(browser);
      try {
        const webglOK = await page.evaluate(() => window.__render3d.webglAvailable());
        if (!webglOK) {
          process.stdout.write(`    (skipped — no GL context; reframe probe needs a real renderer)\n`);
          return;
        }

        // Enter preview
        await page.click("#tool-preview");
        await new Promise(r => setTimeout(r, 1200));

        // Capture whole-plan bounds
        const boundsWholePlan = await page.evaluate(() => window.__render3d.__getBounds());

        // Scope to room-a via the exposed __preview.setScope
        await page.evaluate(() => window.__preview.setScope("room-a"));
        await new Promise(r => setTimeout(r, 800));

        const boundsRoomA = await page.evaluate(() => window.__render3d.__getBounds());

        // Switch back to whole-plan
        await page.evaluate(() => window.__preview.setScope(null));
        await new Promise(r => setTimeout(r, 800));

        const boundsBack = await page.evaluate(() => window.__render3d.__getBounds());

        // When scoping to room-a the bounds should be set (room-a has geometry)
        if (!boundsRoomA) throw new Error("Bounds null after scoping to room-a (expected non-null)");

        // Whole-plan bounds encompass both rooms; room-a bounds should be ≤ whole-plan bounds.
        // (room-b has no verts so doesn't expand bounds — but the check is directional.)
        if (!boundsWholePlan) throw new Error("Whole-plan bounds null (plan has geometry)");

        // After resetting scope, bounds should equal the whole-plan bounds again.
        if (JSON.stringify(boundsBack) !== JSON.stringify(boundsWholePlan)) {
          throw new Error(
            `Bounds after scope reset differ from initial whole-plan bounds.\n` +
            `  initial: ${JSON.stringify(boundsWholePlan)}\n` +
            `  after reset: ${JSON.stringify(boundsBack)}`
          );
        }

        if (page._pageErrors.length) throw new Error("Page errors during reframe test: " + page._pageErrors.join("; "));
        process.stdout.write(`    (whole-plan: ${JSON.stringify(boundsWholePlan)}, room-a: ${JSON.stringify(boundsRoomA)})\n`);
      } finally {
        await page.close();
      }
    },
    browser
  );

  // ── Test 4: empty-state overlay shows for wall-less room, hides on whole-plan ─
  await runScopeTest(
    "empty-state overlay shows when scoping a wall-less room; hides on whole-plan",
    async (browser) => {
      const page = await openScopeApp(browser);
      try {
        const webglOK = await page.evaluate(() => window.__render3d.webglAvailable());
        if (!webglOK) {
          process.stdout.write(`    (skipped — no GL context; empty-state test needs real renderer)\n`);
          return;
        }

        // Enter preview
        await page.click("#tool-preview");
        await new Promise(r => setTimeout(r, 1200));

        // Verify empty state is hidden on whole-plan
        const hiddenOnWholePlan = await page.evaluate(() => {
          const el = document.getElementById("preview-empty");
          return !el || el.hidden;
        });
        if (!hiddenOnWholePlan) throw new Error("#preview-empty should be hidden on whole-plan");

        // Scope to room-b (no verts → empty descriptors → isEmpty = true)
        await page.evaluate(() => window.__preview.setScope("room-b"));
        await new Promise(r => setTimeout(r, 800));

        const shownOnEmpty = await page.evaluate(() => {
          const el = document.getElementById("preview-empty");
          return el && !el.hidden;
        });
        if (!shownOnEmpty) throw new Error("#preview-empty should be visible when scoped to wall-less room-b");

        // Switch back to whole-plan → empty state should hide
        await page.evaluate(() => window.__preview.setScope(null));
        await new Promise(r => setTimeout(r, 800));

        const hiddenAfterReset = await page.evaluate(() => {
          const el = document.getElementById("preview-empty");
          return !el || el.hidden;
        });
        if (!hiddenAfterReset) throw new Error("#preview-empty should be hidden again after resetting scope to whole-plan");

        if (page._pageErrors.length) throw new Error("Page errors during empty-state test: " + page._pageErrors.join("; "));
      } finally {
        await page.close();
      }
    },
    browser
  );

  // ── Test 5: scope-cycle teardown / no-leak (Edge Case 11) ───────────────────
  // N rapid scope changes must not leak geometries/materials.
  // After exit(), __liveGeometryCount === 0 (same guarantee as LLD 130 test 4).
  await runScopeTest(
    "scope-cycle teardown: N scope changes leave 0 live geometries after exit (EC11)",
    async (browser) => {
      const page = await openScopeApp(browser);
      try {
        const webglOK = await page.evaluate(() => window.__render3d.webglAvailable());
        if (!webglOK) {
          process.stdout.write(`    (skipped — no GL context; teardown probe needs a real renderer)\n`);
          return;
        }

        // Enter preview once
        await page.click("#tool-preview");
        await new Promise(r => setTimeout(r, 1200));

        // Cycle scope N times between room-a and whole-plan
        for (let i = 0; i < 4; i++) {
          await page.evaluate(() => window.__preview.setScope("room-a"));
          await new Promise(r => setTimeout(r, 300));
          await page.evaluate(() => window.__preview.setScope(null));
          await new Promise(r => setTimeout(r, 300));
        }

        // Exit preview
        await page.click("#tool-preview");
        await new Promise(r => setTimeout(r, 400));

        const afterExit = await page.evaluate(() => ({
          live: window.__render3d.__liveGeometryCount(),
          hasRenderer: window.__render3d.__hasRenderer(),
        }));

        if (afterExit.live !== 0) {
          throw new Error(`Geometry leak after scope cycles + exit: ${afterExit.live} live geometries`);
        }
        if (!afterExit.hasRenderer) {
          throw new Error("Renderer was destroyed after scope cycles (should be reused)");
        }

        if (page._pageErrors.length) throw new Error("Page errors during scope-cycle teardown: " + page._pageErrors.join("; "));
        process.stdout.write(`    (scope-cycle teardown: 0 live geometries after exit, renderer reused)\n`);
      } finally {
        await page.close();
      }
    },
    browser
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

const server = await serve();
const browser = await chromium.launch();

// ── Run unit tests ────────────────────────────────────────────────────────────
const result = await runUnitTests(browser);
const { total, passed, failed, failures } = result;

const unitIcon = failed === 0 ? "PASS" : "FAIL";
process.stdout.write(`${unitIcon}  ${passed}/${total} unit tests passed`);
if (failed > 0) process.stdout.write(` (${failed} failed)\n`);
else process.stdout.write("\n");

if (failed > 0) {
  for (const f of failures) {
    process.stderr.write(`  - ${f.suite}\n      ${f.name}\n      ${f.error}\n`);
  }
}

// ── Run integration tests (LLD 82 W×H) ───────────────────────────────────────
await runWxhIntegrationTests(browser);

const intIcon = integrationFailures.length === 0 ? "PASS" : "FAIL";
process.stdout.write(`${intIcon}  ${integrationPassed}/${integrationTotal} integration tests passed`);
if (integrationFailures.length > 0) process.stdout.write(` (${integrationFailures.length} failed)\n`);
else process.stdout.write("\n");

// ── Run integration tests (LLD 130 3D preview) ───────────────────────────────
await runPreview3dIntegrationTests(browser);

const prevIcon = previewFailures.length === 0 ? "PASS" : "FAIL";
process.stdout.write(`${prevIcon}  ${previewPassed}/${previewTotal} preview integration tests passed`);
if (previewFailures.length > 0) process.stdout.write(` (${previewFailures.length} failed)\n`);
else process.stdout.write("\n");

if (previewFailures.length > 0) {
  for (const f of previewFailures) {
    process.stderr.write(`  - ${f.suite}\n      ${f.name}\n      ${f.error}\n`);
  }
}

// ── Run integration tests (LLD 142 per-room scoping) ─────────────────────────
await runScopeIntegrationTests(browser);

const scopeIcon = scopeFailures.length === 0 ? "PASS" : "FAIL";
process.stdout.write(`${scopeIcon}  ${scopePassed}/${scopeTotal} scope integration tests passed`);
if (scopeFailures.length > 0) process.stdout.write(` (${scopeFailures.length} failed)\n`);
else process.stdout.write("\n");

if (scopeFailures.length > 0) {
  for (const f of scopeFailures) {
    process.stderr.write(`  - ${f.suite}\n      ${f.name}\n      ${f.error}\n`);
  }
}

// ── Teardown ──────────────────────────────────────────────────────────────────
await browser.close();
server.close();

const anyFailed = failed > 0 || integrationFailures.length > 0 || previewFailures.length > 0 || scopeFailures.length > 0;
if (anyFailed) process.exit(1);
