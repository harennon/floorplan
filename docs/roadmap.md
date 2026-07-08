# floorplan — roadmap & post-live execution plan

The order of work after the [MVP](https://github.com/harennon/floorplan/issues/1) ships.
Each phase past the MVP has a tracking GitHub issue (linked below). Phases are
deliberately sequenced so the tool is useful and shippable at the end of every one, and
so the client-side-only invariant only relaxes when we consciously choose to (Phase 3).

## Phase 0 — MVP ✅ shipped

The core editor: draw walls on a snapping grid, live area/perimeter, drag-drop
furniture, and localStorage + PNG/SVG/JSON + share-by-URL. Client-side only, no backend.
→ **#1** (epic, closed) — decomposed into **#5–#10**, all shipped:
- #5 drawing surface (SVG canvas, pan/zoom, grid)
- #6 wall drawing with grid + endpoint snapping
- #7 dimensions, live area/perimeter, metric/imperial toggle
- #8 drag-drop symbol set (doors, windows, ~6 furniture)
- #9 editing UX — undo/redo, delete, duplicate, keyboard shortcuts
- #10 persistence & share — localStorage autosave, JSON/PNG/SVG export, URL-hash share

Persistence landed as the `plan.js` document contract (`buildPlan`/`validatePlan`/
`applyPlan`/`serializePlan`) shared by localStorage, JSON export, and the URL hash.

## Phase 1 — the wedge: "does my couch fit?" clearance checking ⏳ in progress

The differentiating feature. Once furniture exists (MVP), show **live clearance
distances** between furniture and walls/other furniture, and flag tight gaps. This is the
sharp, none-of-the-incumbents-have-it angle that makes floorplan worth using over
floorplancreator.net. Small, high-signal, builds directly on the MVP.
→ **#2** — implemented in `src/js/clearance.js` (pure geometry core),
`clearancePanel.js`, and `clearanceRender.js`; delivered via PR #28.

## Phase 2 — polish & delight

Quality-of-life and personality once the core loop is proven: a richer furniture/symbol
set, keyboard-shortcut coverage, the graph-paper/blueprint visual identity fully
realized, mobile-touch drawing ergonomics, templates/examples to start from, and
onboarding that gets a first-timer drawing in seconds.
→ **#3** (`triage:defer`)

**Snapping cluster (near-term, queued ahead of the rest of Phase 2).** Real usage
surfaced that furniture placement against walls/objects is fiddly. Tracked as epic
**#23**, decomposed into three `triage:fix` sub-issues:
- **#29** — persistent snap toggle + wall-flush snapping for symbols
- **#30** — object-to-object alignment snapping with transient drag guides
- **#31** — room-center / mid-line snap to room centroid

These are polish in spirit but sharpen the core drawing loop, so they lead Phase 2.

## Phase 3 — accounts & multi-platform (the big one; relaxes "no backend")

**This is the phase that steps outside the pure-static model — do it consciously.**
Optional login so a plan drawn on the **website** and a **phone app/PWA** sync across
devices.

- **Backend: Supabase**, talked to **directly from the static frontend** (auth +
  Postgres, with Row-Level Security scoping each plan to its owner). Mirrors the sibling
  `cardgamesimulator` project's stack, but *without* a custom server — a floor-plan
  editor is not server-authoritative, so no Express/Socket.IO layer is needed. The site
  stays static on Cloudflare Pages; it just gains a managed dependency.
- **Client shape:** prefer an installable **PWA** over a native app first — it reuses the
  web codebase and is far cheaper to ship. Revisit native only if PWA proves limiting.
- **Free-tier fit (verified 2026-07):** Supabase Free = 2 active projects, 50k monthly
  active users, 500 MB Postgres, 1 GB storage, 5 GB egress. Floor-plan JSON is tiny, so a
  hobby-scale tool fits comfortably.
- ⚠️ **Caveat to design around:** Supabase free projects are **paused after 1 week of
  inactivity**. A low-traffic subdomain will hit cold starts / a paused DB. Decide up
  front: keep-alive ping, accept the wake-up delay, or gate the feature behind demand.
- **Migration must stay additive:** v1 (localStorage + share-links) keeps working with
  zero Supabase dependency for anyone who never logs in. Accounts are opt-in sync on top.

→ **#4** (`triage:defer`, `blocked:human`) — **do NOT start until Phase 0 proves the core editor.**

## Engineering / quality infrastructure

Not a user-facing phase, but tracked so the plan reflects how the project stays shippable.

- **Headless test suite + CI quality gate** (#17, `priority:high`). A browser ES-module
  test suite (`src/tests.html`, ~400 tests) is run headlessly in CI via Playwright/
  Chromium (`.github/run-tests.mjs`, wired into `.github/workflows/ci.yml` as the
  `validate` job's "Run unit tests" step, alongside HTML validation and JS syntax
  checks). Landed with PR #28.
- **Follow-up — make the ship pipeline run tests pre-PR.** The autonomous ship-batch
  pipeline only executes a project's tests when `.claude/project.json` configures a
  `commands.test`; floorplan had no `commands` block, so tests were authored and PR'd
  without ever being run locally (they surfaced only when CI ran them). Add a `commands`
  block (`test: "node .github/run-tests.mjs"` plus the Playwright `install` step) **after
  PR #28 merges** — the config must reference the runner once it exists on `main`. This
  closes the loop so future ticks catch failures during implement/code-review, before a
  PR is raised.
- **Branch protection / required checks** remain deferred (see LLD 13): once the gate is
  proven, `required_status_checks` can reference the `validate` job. Related: **#18**
  (auto-merge on green PR validation) is the full-autonomy step that depends on this.

## Later / maybe (not yet scheduled)

Ideas parked until there's a reason to pull them forward — captured so they aren't lost,
not committed to: curved/angled walls, scale-accurate PDF export, DXF/OBJ interchange,
simple 3D preview, real-time collaboration, a larger branded furniture catalog, light
mode (#12). Most of these are exactly where the paid incumbents spend their money; we
only chase one if it clearly serves the "quick apartment sketch you can share" job.

- **MCP server for AI-agent floorplan authoring** (#32, `triage:defer`) — a local stdio
  MCP server that reuses the `plan.js` core so agents can create/edit plans headlessly.
  Advances toward the Phase 3 backend (shared document contract) without duplicating
  work. Deferred pending an LLD. (A monetization spin-off, #33, was declined — `triage:close`.)
