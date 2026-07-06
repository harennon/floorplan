# floorplan

A friction-free, browser-based floor-plan sketcher. Draw walls on a snapping grid, shape
rooms, drop in to-scale furniture, and read off live area — then share it as a link. No
signup, everything free.

Live at **[floorplan.danbing.app](https://floorplan.danbing.app)** · a [danbing.app](https://danbing.app) tool.

## Run locally

Pure static site, no build step:

```bash
python3 -m http.server 8093 --directory src
# open http://localhost:8093
```

## How it works

Everything is client-side (v1). Plans autosave to your browser and can be exported as
PNG/SVG/JSON or shared via a URL that encodes the whole plan in its hash — **nothing is
sent to a server.** Deployed as static files from `src/` via Cloudflare Pages.

Inspired by floorplancreator.net, but free and login-free, with a "does my couch fit?"
measuring focus.
