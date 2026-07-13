import { defineConfig } from "vite";

// Vite build for the floorplan static site (LLD 127 — adopt build step).
//
// - root "src": index.html and js/ live under src/, which stays the source tree.
// - base "./": emit relative asset URLs so the built index.html works both when
//   served at the subdomain root on Cloudflare Pages AND when the CI test server
//   serves it from /dist/index.html (the harness serves the repo root over HTTP).
// - outDir "../dist": build output lands at repo-root dist/, which is what
//   Cloudflare Pages deploys (pages_build_output_dir in wrangler.toml).
export default defineConfig({
  root: "src",
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
