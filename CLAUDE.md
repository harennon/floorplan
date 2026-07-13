# CLAUDE.md

**floorplan** — a browser-based floor-plan sketcher. Draw walls on a snapping grid,
shape rooms, drop in to-scale doors, windows, and furniture, and read off live
area/perimeter as you go. Lives at `floorplan.danbing.app`, one of the danbing.app
portfolio projects. The wedge: frictionless, no-signup, everything-free, with a "does my
couch fit?" measuring focus the incumbents (e.g. floorplancreator.net) don't offer.

## Project Structure

- `src/` — the app source (HTML, CSS, vanilla JS). Built by Vite into `dist/`.
- `dist/` — Vite build output; the deployed artifact (gitignored, produced by `npm run build`).
- `design-mockups/` — throwaway HTML mockups for visual design exploration.
- `docs/` — design docs; `docs/lld/` holds low-level designs written by the pipeline.

## Tech Stack

- **HTML + CSS + vanilla JS, no framework.** Bundled with **Vite** (`npm run build` → `dist/`).
  Dependencies are allowed (npm, version-locked); the "no build step" constraint was lifted
  in #102 in favor of proper dependency hygiene.
- **Hosting:** Cloudflare Pages (Git-integrated; runs `npm run build`, deploys `dist/`),
  subdomain `floorplan.danbing.app`.
- **State (v1):** entirely client-side. Plans autosave to `localStorage`; a plan can be
  exported as JSON/PNG/SVG or shared via a URL hash that encodes the whole plan —
  **nothing is sent to a server in v1.**

## Design Philosophy

A real tool that's also fun to poke at — the neal.fun sensibility applied to a utility.
Optimize for "sketch my studio in two minutes and text the link to a roommate," not
surveyor-grade CAD. Personality through design (a graph-paper / blueprint feel is a
candidate direction), minimal chrome. Visual language echoes the danbing.app portfolio.

## Principles

- **Client-side only (v1).** No backend, no accounts, no persistence beyond localStorage
  and the URL. The optional accounts/sync phase is explicitly a *later* phase (see
  `docs/` roadmap) and must not be bundled into v1.
- **Instant + zero-setup.** A first-time visitor can sketch a recognizable room and read
  its area within ~2 minutes, on mobile or desktop, with no signup.
- **Deploy cheap.** Cloudflare Pages builds and serves the static `dist/` for free. Keep the
  build fast and dependencies lean — add a dependency only when it removes more complexity than
  it adds (the #102 rationale).
- **Free, no gates.** The differentiator vs. incumbents is no paywalled export and no
  forced login. Vector (SVG) and raster (PNG) export stay free.
- **Shareable artifacts.** Favor features that produce something a person wants to send
  (the URL-hash share link; the PNG/SVG export).

## Future: accounts & multi-platform (later phase, not v1)

Optional login so a plan drawn on the **website** and a **phone app/PWA** sync across
devices. Intended backend is **Supabase** (auth + Postgres), talked to **directly from
the static frontend** with Row-Level Security — mirroring the sibling `cardgamesimulator`
project, but *without* a custom server since a floor-plan editor is not
server-authoritative. This keeps the site static and adds only a managed dependency.
Caveat: Supabase's free tier pauses a project after 1 week of inactivity — plan for it.
This phase is tracked as its own issues; it is a growth step after the core editor proves
out.

## Agent Routing

| Trigger | Agent |
| --- | --- |
| Visual design, mockups, layout | `frontend-architect` |
| Design / write an LLD | `architect` |
| Review an LLD before implementation | `design-reviewer` |
| Build / implement from an approved LLD | `implementer` |
| Review code after implementation | `code-reviewer` |
| Verify UX | `qa` |
| What to build next / prioritize | `ceo` |

## Deployment

Push to `main` → Cloudflare Pages runs `npm run build` and deploys the resulting `dist/`.
The build command is set in the Cloudflare Pages dashboard (it cannot live in `wrangler.toml`,
which only carries `pages_build_output_dir`). Per-PR preview deployments remain automatic via
the Git integration.
