/**
 * Build smoke test (LLD 127).
 *
 * The unit suite (test/tests.html) imports app modules from source (src/js/*),
 * so it verifies logic but never exercises the SHIPPED artifact. This smoke test
 * closes that gap: it validates the Vite build output under dist/ that Cloudflare
 * Pages actually deploys.
 *
 * Checks:
 *   1. dist/index.html exists.
 *   2. It references a HASHED bundled asset under assets/ (proves Vite transformed
 *      the source rather than passing raw modules through).
 *   3. The built page boots in headless Chromium with ZERO console/page errors and
 *      the core app DOM (#stage, #tool-select) is present.
 *
 * Run AFTER `npm run build`. Usage: node .github/build-smoke.mjs
 */

import { chromium } from "playwright";
import { createServer } from "http";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { extname, join } from "path";
import { fileURLToPath } from "url";

const ROOT_DIR = join(fileURLToPath(import.meta.url), "../..");
const DIST_INDEX = join(ROOT_DIR, "dist", "index.html");
const PORT = 3743;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function fail(msg) {
  process.stderr.write(`FAIL (build smoke): ${msg}\n`);
  process.exit(1);
}

// ── Check 1: dist/index.html exists ───────────────────────────────────────────
if (!existsSync(DIST_INDEX)) {
  fail(`dist/index.html not found — did \`npm run build\` run first?`);
}

// ── Check 2: references a hashed bundled asset ────────────────────────────────
const html = await readFile(DIST_INDEX, "utf8");
const assetRef = html.match(/(?:src|href)="\.?\/?assets\/[^"]+"/);
if (!assetRef) {
  fail(`dist/index.html references no assets/ bundle — build did not transform the source.`);
}
// Vite content-hashes emitted chunks: assets/<name>-<hash>.<ext>
if (!/assets\/[^"]*-[A-Za-z0-9_-]{8,}\.(?:js|css)/.test(assetRef[0])) {
  fail(`bundled asset is not content-hashed (${assetRef[0]}) — unexpected build output.`);
}

// ── Check 3: built page boots headless with zero errors ───────────────────────
function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const safePath = req.url.split("?")[0].replace(/\.\./g, "");
      const file = join(ROOT_DIR, "dist", safePath === "/" ? "/index.html" : safePath);
      try {
        const data = await readFile(file);
        res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

const server = await serve();
const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(`uncaught: ${e}`));

await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const hasStage = await page.evaluate(() => !!document.querySelector("#stage"));
const hasTools = await page.evaluate(() => !!document.querySelector("#tool-select"));

await browser.close();
server.close();

if (errors.length > 0) fail(`built page logged ${errors.length} error(s):\n  ${errors.join("\n  ")}`);
if (!hasStage) fail(`built page missing #stage — app did not render.`);
if (!hasTools) fail(`built page missing #tool-select — app did not render.`);

process.stdout.write(`PASS  build smoke: dist/ boots clean, hashed bundle ${assetRef[0]}\n`);
