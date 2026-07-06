# floorplan — roadmap & post-live execution plan

The order of work after the [MVP](https://github.com/harennon/floorplan/issues/1) ships.
Each phase past the MVP has a tracking GitHub issue (linked below). Phases are
deliberately sequenced so the tool is useful and shippable at the end of every one, and
so the client-side-only invariant only relaxes when we consciously choose to (Phase 3).

## Phase 0 — MVP (in flight)

The core editor: draw walls on a snapping grid, live area/perimeter, drag-drop
furniture, and localStorage + PNG/SVG/JSON + share-by-URL. Client-side only, no backend.
→ **#1** (`triage:fix`, `priority:high`)

## Phase 1 — the wedge: "does my couch fit?" clearance checking

The differentiating feature. Once furniture exists (MVP), show **live clearance
distances** between furniture and walls/other furniture, and flag tight gaps. This is the
sharp, none-of-the-incumbents-have-it angle that makes floorplan worth using over
floorplancreator.net. Small, high-signal, builds directly on the MVP.
→ **#2** (`triage:defer`)

## Phase 2 — polish & delight

Quality-of-life and personality once the core loop is proven: a richer furniture/symbol
set, keyboard-shortcut coverage, the graph-paper/blueprint visual identity fully
realized, mobile-touch drawing ergonomics, templates/examples to start from, and
onboarding that gets a first-timer drawing in seconds.
→ **#3** (`triage:defer`)

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

## Later / maybe (not yet scheduled)

Ideas parked until there's a reason to pull them forward — captured so they aren't lost,
not committed to: curved/angled walls, scale-accurate PDF export, DXF/OBJ interchange,
simple 3D preview, real-time collaboration, a larger branded furniture catalog. Most of
these are exactly where the paid incumbents spend their money; we only chase one if it
clearly serves the "quick apartment sketch you can share" job.
