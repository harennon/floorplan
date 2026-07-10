/**
 * Headless test runner for test/tests.html.
 *
 * Serves the repo root over HTTP (so the harness at /test/tests.html can import
 * the app modules under /src/js/ via ../src/js/*), loads it in a headless
 * Chromium page, waits for window.__testResult to be set by the in-page
 * harness, then exits 0 (all pass) or 1 (any failure).
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

// ── Main ──────────────────────────────────────────────────────────────────────

const server = await serve();
const browser = await chromium.launch();
const page = await browser.newPage();

// Forward console errors from the test page to stderr for diagnosis
page.on("console", (msg) => {
  if (msg.type() === "error") process.stderr.write(`[page error] ${msg.text()}\n`);
});
page.on("pageerror", (err) => process.stderr.write(`[page uncaught] ${err}\n`));

await page.goto(`http://127.0.0.1:${PORT}${TEST_PAGE}`);

// Wait for the harness to finish all async tests and call render()
await page.waitForFunction(
  () => window.__testResult !== undefined,
  { timeout: 30_000 }
);

// Collect results while the page is still open
const result = await page.evaluate(() => window.__testResult);

await browser.close();
server.close();

const { total, passed, failed, failures } = result;
const icon = failed === 0 ? "PASS" : "FAIL";
process.stdout.write(`${icon}  ${passed}/${total} tests passed`);
if (failed > 0) process.stdout.write(` (${failed} failed)\n`);
else process.stdout.write("\n");

if (failed > 0) {
  for (const f of failures) {
    process.stderr.write(`  - ${f.suite}\n      ${f.name}\n      ${f.error}\n`);
  }
  process.exit(1);
}
