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
const APP_PAGE  = "/src/index.html";
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

// ── Teardown ──────────────────────────────────────────────────────────────────
await browser.close();
server.close();

const anyFailed = failed > 0 || integrationFailures.length > 0;
if (anyFailed) process.exit(1);
