# LLD 32: MCP server for agent-driven, requirement-satisfying floorplans

## Scope

This LLD covers a **local, dev-only prototype MCP server** whose purpose is to iterate the
agent tool/feedback design against a real agent — **not** a shippable npm package. The
frame is deliberate: the genuinely unknown questions here are all about *agent ergonomics*
(tool granularity, feedback shape, whether a visual preview is needed, statefulness), and
those can only be answered empirically by running an agent against a prototype and watching
where it fails to converge. Distribution machinery (npm publish, self-contained bundling,
one-click installers) is human-gated (npm 2FA) and partly throwaway if the tool design
changes, so it is explicitly **deferred to a later productionization phase** (see Open
questions Q6/Q7).

**The end goal this server serves.** An AI agent is given a natural-language design brief
with requirements (e.g. *"design a 4×5 m studio with a bed, a desk, and a couch, all with
60 cm walkways"*). The agent interfaces with floorplan and produces a plan that
**satisfies those requirements**. The operative word is *satisfying*: this is a **closed
feedback loop** — agent proposes geometry → server evaluates it against the requirements →
agent reads the violations → agent adjusts → repeat until satisfied — **not** a one-shot
document write. The LLD centers this loop. The differentiated value is exposing
floorplan's own requirement-evaluators (`walls.js` metrics + `clearance.js` couch-fit
checking) as **agent feedback tools**; this aligns directly with the product wedge ("does
my couch fit?"), unlike a generic CRUD-over-JSON MCP server.

**In scope**
- A new top-level **`mcp/`** directory with its own `package.json` and a Node stdio MCP
  server. `src/` stays 100% build-less; only `mcp/` gains a Node toolchain/dependency.
- **Mutator tools** that wrap the app's pure geometry core (`walls.js`, `symbols.js`) so
  the agent gets floorplan's guardrails for free (polygon closing, exact edge lengths,
  catalog min/max size clamps, world-metre coordinates) rather than hand-authoring JSON.
- **Evaluator (feedback) tools** — the heart of the loop — that run `roomMetrics` /
  `polygonArea` / `perimeter` and, above all, `clearance.js`'s `computeClearances`, and
  return the result in a **shape an agent can converge on** (per-neighbour gap in cm +
  status + a natural-language violation summary + a single `satisfied` boolean), rather
  than a raw geometry dump.
- **A stateful in-memory session**: the server holds one live plan across tool calls (the
  agent iterates: add room → check → nudge → re-check), implemented as a load/edit/dump
  discipline over the core's module-level singletons (see State model).
- **Validation on read**: every document the server ingests (from a file, or an
  agent-supplied whole-plan) is passed through `validatePlan()` and rejected without
  throwing on failure.
- **Human handoff, reusing what already works**: emit a `serializePlan()` JSON document
  the app's `importJson()` accepts, and emit a `floorplan.danbing.app/#<hash>` share URL
  via `share.js`'s `encodePlanToHash()`.
- **File I/O sandboxed** to a single designated plans directory (no path traversal).
- MCP **Resources** (current plan document, symbol catalog with clamp bounds, active
  brief) and a starter **Prompt**, to the extent they help the loop.
- A headless convergence **test harness**: a scripted "agent" that drives the tools to
  satisfy a brief and asserts the resulting plan passes clearance and `validatePlan`.

**Explicitly NOT in scope**
- **No npm publish, no self-contained bundle, no `.mcpb` one-click installer.** The MVP
  imports the core directly from `../src/js` in a dev checkout (Q6). This is *not*
  distributable and is knowingly deferred; the resolution framing is recorded in Open
  questions but not built here.
- **No remote / HTTP / OAuth MCP transport.** #32 rejected remote for security-first,
  cost-second reasons; that rejection is carried forward. Transport is **local stdio only**.
- **No Supabase / accounts / cross-device sync.** That is Phase 3 (#4) and is *orthogonal*
  to this work — they intersect only at the `plan.js` contract (see Dependencies). No
  storage adapter, JWT, or RLS work happens in this LLD.
- **No changes to `src/`.** The core is already Node-importable; the server adapts to it,
  not the reverse. (One tolerated exception discussed under *Headless import boundary* if a
  browser-only symbol leaks — but the design avoids it.)
- **No headless visual rendering (SVG/PNG) in the MVP.** The app renderers are DOM-based;
  a preview is treated as a *fast-follow* to test empirically whether the agent needs to
  "see" (Q3). MVP relies on text metrics + clearance feedback.
- **No door-swing / opening clearance, no rotated-polygon exact clearance.** The server
  inherits `clearance.js`'s v1 model as-is (AABB, furniture-subject only) — see LLD 24.
- **No room-to-room overlap evaluation.** The evaluators cover symbol-to-wall and
  symbol-to-symbol clearance (LLD 24) but nothing checks whether two *room polygons*
  overlap each other — a structurally valid plan can still be spatially nonsense at the
  room level. The single-room MVP brief (`Brief.room` is one room) cannot produce this;
  it becomes real only for multi-room layouts and is recorded as a known evaluator gap in
  Q8, not built here.
- **No real-time collaboration, no server-authoritative multi-client state.**

## Approach

### The plan document is the contract; the server is a headless editor of it

Everything funnels through `plan.js`. `buildPlan()` snapshots the live core singletons into
a JSON-safe `Plan`; `validatePlan(raw)` deep-validates and normalises (never throws, returns
`null` on invalid); `applyPlan(plan)` hydrates the singletons in place; `serializePlan(plan)`
produces the stable JSON the app already imports/shares. The server does **not** re-implement
any geometry or serialization — it reuses these verbatim. This keeps one source of truth for
the math and guarantees the emitted document is byte-compatible with the web app.

### Layering (three thin layers over the unchanged core)

```
mcp/
  package.json          # "type":"module", bin -> src/server.js, dep: @modelcontextprotocol/sdk
  src/
    server.js           # MCP wiring: registers tools/resources/prompts, stdio transport
    session.js          # the load/edit/dump discipline over the core singletons (State model)
    tools.js            # tool handlers: mutators + evaluators (calls session + core)
    feedback.js         # formats clearance/metrics into agent-convergable feedback (the loop)
    io.js               # sandboxed file read/write of Plan JSON to the plans dir
    brief.js            # in-memory requirement store + satisfaction evaluation
  README.md             # install docs (deferred content — stubbed in MVP)
```

- **`session.js`** owns the single in-memory plan and the concurrency discipline. Because
  `walls.js`/`symbols.js` mutate **module-level singletons in place**, a stdio server (one
  process, one client, requests handled one at a time over the event loop) treats the
  singletons as *the* working plan. Each tool handler runs to completion synchronously
  around any `await`-free core mutation, so no interleaving corrupts the singletons (see
  State model for the exact contract and the multi-session guard).
- **`tools.js`** is the only place that calls core mutators. Handlers are small: validate
  args → call the core fn → return a compact result (usually the affected id + a fresh
  metrics/clearance readout so the agent sees the effect of its action immediately).
- **`feedback.js`** is the differentiator. It converts `computeClearances()` +
  `roomMetrics()` into the loop-closing payload: per-item gaps **in centimetres**, a
  status, an explicit `satisfied` boolean against the brief's thresholds, and a
  natural-language `violations` list telling the agent *what to fix and by how much*.
- **`brief.js`** holds the parsed requirements (target room dims, required furniture, min
  walkway) so evaluators can answer "does the current plan satisfy the brief?" — this is
  what turns CRUD into goal-seeking.

### Decision: fine-grained tools + one coarse escape hatch (Q1)

Expose **fine-grained mutators** (`add_room`, `set_edge_length`, `place_symbol`,
`move_symbol`, `resize_symbol`, `rotate_symbol`, `remove_symbol`) **as the primary
surface**, because the whole point is to give the LLM the guardrails it is bad at freehand:
polygons that actually close, exact edge lengths via `rescaleEdge`, catalog clamps via
`clampDim`, metre coordinates. Also expose **one coarse `load_plan(document)`** that
`validatePlan`s and hydrates a whole document — this is the escape hatch for "resume an
existing plan" and for an agent that already knows the exact JSON. We deliberately do **not**
offer a coarse free-form `apply_plan(arbitrary_geometry)` write, since that bypasses the
guardrails that justify the server. **This split is the recommendation, not a proven
answer** — the empirical question the prototype exists to settle is whether the agent
converges faster with finer or coarser mutators; tool granularity is expected to be revised
after watching a real agent (see Open questions Q1).

### Decision: stateful session, load/edit/dump per call (Q2)

The server is **stateful** — it holds one plan across calls so the agent can iterate. Given
the module-level singletons, "stateful" is implemented as: the singletons *are* the session
plan; mutators call core fns directly; evaluators read live via `buildPlan()`/`walls.model`.
A `load_plan`/`new_plan`/`save_plan` boundary uses `applyPlan`/`hydrate` to swap contents. A
single-session guard (State model) rejects a second concurrent session so two logical plans
can never fight over the same singletons. Stateless pure `document→document` transforms were
rejected: they would force the agent to round-trip the entire document on every nudge and
would waste the "iterate cheaply" ergonomics the loop needs.

### Decision: no headless preview in MVP; text feedback first (Q3)

The MVP returns **no SVG/PNG**. The renderers (`wallRender.js`, `symbolRender.js`,
`surface.js`) are DOM-bound, so a preview means jsdom or a standalone SVG serializer — real
added surface area. The bet is that a well-shaped **text** payload (per-edge/per-gap numbers
+ violation summary, below) is enough for the agent to converge, and the human sees the real
thing via Import / share URL. A preview is a **fast-follow** we add only if prototype runs
show the agent thrashing for lack of a visual. If added later, prefer a **standalone SVG
serializer over jsdom** (smaller, deterministic, no DOM emulation), returned as an MCP image
content block.

### Decision: validate everything on read (Q4)

Any document entering the server — a file loaded from the plans dir, or a `load_plan` arg —
goes through `validatePlan()`, and a `null` return is surfaced to the agent as a structured
error, never thrown. `validatePlan`'s existing bounds are **sufficient** for the MVP: it
enforces the `app`/`schema` guard tags, finite vertices, finite symbol `x/y/w/h/rot`, and
`type ∈ CATALOG`. The one gap worth noting: `validatePlan` checks symbol dims are *finite*
but does **not** re-clamp them to catalog `[min,max]` — an out-of-range but finite dimension
validates. The server closes this on the *mutator* side (every `resize_symbol`/`place_symbol`
routes through `clampDim`), and `load_plan` documents are trusted as-authored (they came from
this app). No change to `plan.js` is required.

### Decision: reuse both handoff paths; note the `location` caveat

- **JSON file** (chosen primary path): `save_plan` writes a `serializePlan()` document to the
  sandboxed plans dir; the human clicks **Import** in the app (`importJson()` already
  validates + applies).
- **Share URL**: `get_share_url` calls `share.js`'s `encodePlanToHash(plan)` — which uses
  only Node-available globals (`TextEncoder`, `CompressionStream`, `btoa`), **verified
  importable headless** — and prepends the known base `https://floorplan.danbing.app/#`.
  **Caveat (verified):** `buildShareUrl()` and `readBootHash()` in `share.js` reference
  `location`/`history` (browser-only) and must **not** be called from Node; the server calls
  the pure `encodePlanToHash()` and constructs the URL string itself with a hard-coded base.
  This is a consume-the-pure-function boundary, not a `src/` change.

## Headless import boundary

The server imports the core with plain relative ES-module specifiers from a dev checkout:

```js
// mcp/src/session.js (illustrative specifiers, not full code)
import { buildPlan, validatePlan, applyPlan, serializePlan } from "../../src/js/plan.js";
import * as walls from "../../src/js/walls.js";
import * as symbols from "../../src/js/symbols.js";
import { computeClearances, worstStatus, classify, setThreshold } from "../../src/js/clearance.js";
import { encodePlanToHash } from "../../src/js/share.js";
```

**Verified Node-clean at module load** (the task confirmed this; re-stated as the contract
this LLD builds on): `plan.js` → `walls.js` / `symbols.js` / `view.js` / `units.js`, and
`clearance.js`, all import and run under `node --input-type=module` touching no
`document`/`window`. `share.js` also imports clean; only its *functions* `buildShareUrl()`
and `readBootHash()` touch `location`/`history`, and the server never calls those.

**What the server must NOT touch** (browser-only; not imported): `surface.js`, `main.js`,
`*Render.js`, `*Tool.js`, `actions.js`, `store.js` (localStorage), `exportJson.js`/
`exportImg.js` (DOM download), `measure.js`/`clearancePanel.js`/`hud.js`/`help.js`. Nothing
in the mutator/evaluator/handoff path needs them.

**Guardrail:** an MVP smoke test imports each core module the server depends on under Node
and asserts no throw at import time, so a future `src/` edit that accidentally introduces a
top-level `document` reference fails the `mcp/` test suite loudly (this is the early-warning
for the Q6 coupling).

This dev-checkout relative import is **knowingly not self-contained** — it breaks the moment
the package is published to npm (`npx` runs from a temp dir with no `../../src`). Resolving
that (bundle at build time / vendor a synced copy / depend on a separately-published core
package) is **deferred**; see Open questions Q6.

## Tool surface (the feedback loop)

Every tool returns JSON as its structured result. Mutators return the affected id **plus a
compact fresh readout** so a single call both acts and gives feedback — the agent doesn't
have to call an evaluator after every nudge, which shortens the loop. All lengths in tool
**arguments and results are metres** to match the core; the human-facing feedback strings
additionally echo centimetres because briefs are usually phrased in cm ("60 cm walkway").

### Session / lifecycle tools

| Tool | Args | Returns | Backed by |
|---|---|---|---|
| `set_brief` | `{ room?: {w,h}, furniture?: [{type,count?}], minWalkwayM?: number }` | `{ ok, brief }` | `brief.js` |
| `new_plan` | `{}` | `{ ok, plan_summary }` | `applyPlan(buildEmptyPlan())` |
| `load_plan` | `{ document: Plan }` | `{ ok } \| { error }` | `validatePlan` + `applyPlan` |
| `save_plan` | `{ filename?: string }` | `{ ok, path }` | `io.js` + `serializePlan` |
| `get_share_url` | `{}` | `{ url }` | `encodePlanToHash` |
| `get_plan` | `{}` | `{ document: Plan }` | `buildPlan` |

### Mutator tools (wrap the core; give the agent guardrails)

| Tool | Args | Core call | Notes |
|---|---|---|---|
| `add_room` | `{ verts: [{x,y}, …] }` or `{ rect: {x,y,w,h} }` | `placeVertex`×n → `closeRoom` | `rect` convenience builds 4 verts and closes; polygon path closes automatically (≥3 verts). Returns room id + `roomMetrics`. |
| `set_edge_length` | `{ roomId, edgeIndex, lengthM }` | `rescaleEdge` | Exact edge length; returns `{ ok, newMetrics }` or `{ ok:false, reason }` (out-of-range index / degenerate). |
| `place_symbol` | `{ type, x, y, w?, h?, rot? }` | `createSymbol`→`resizeSymbol`(clampDim)→`rotateSymbol`→`addSymbol` | Dims routed through `clampDim`; returns symbol id + a clearance readout for that symbol. |
| `move_symbol` | `{ id, x, y }` | `moveSymbol` | Returns fresh clearance for the moved symbol. |
| `resize_symbol` | `{ id, dim, metres, lockAspect? }` | `resizeSymbol` | Clamped; returns whether it changed + new dims + clearance. |
| `rotate_symbol` | `{ id, deg }` | `rotateSymbol` | Normalised to [0,360). |
| `remove_symbol` / `duplicate_symbol` | `{ id }` | `removeSymbol` / `duplicateSymbol` | — |

Mutator arg validation is strict (finite numbers, known `type`, existing `id`); invalid args
return `{ ok:false, reason }` rather than throwing, mirroring `validatePlan`'s discipline so
the agent can read and correct.

### Evaluator tools (the loop closers — this is the whole point)

**`get_metrics`** → per-room `{ id, areaM2, perimeterM, closed }` + totals. Backed by
`roomMetrics`. Lets the agent verify "4×5 m ⇒ ~20 m²" after `add_room`/`set_edge_length`.

**`check_clearance`** → the couch-fit evaluator, the reason this server is differentiated.
Args `{ id?, minWalkwayM? }`: with `id`, evaluates one symbol; without, evaluates **every**
furniture symbol. `minWalkwayM` overrides the session threshold for this call (defaults to
the brief's `minWalkwayM`, else `clearance.js` `DEFAULT_THRESHOLD` = 0.60 m). It calls
`setThreshold(minWalkway)` then `computeClearances(sym, {rooms, symbols})` per subject.

The **return shape is engineered for convergence** (this is the answer to "boolean vs
per-edge cm vs NL summary" — it is *all three, layered*, so the agent gets a fast
pass/fail, a precise number to act on, and a plain-language instruction):

```jsonc
{
  "thresholdM": 0.60,
  "satisfied": false,                 // fast top-level pass/fail against threshold
  "worstStatus": "tight",             // from clearance.js worstStatus()
  "items": [                          // one per subject furniture symbol
    {
      "id": "s3", "label": "Sofa",
      "worstStatus": "tight",
      "gaps": [                        // one per neighbour (wall or symbol)
        { "to": "left wall",  "kind": "wall",   "gapCm": 42, "gapM": 0.42, "status": "tight" },
        { "to": "Desk",       "kind": "symbol", "neighbourId": "s5", "gapCm": 18, "gapM": 0.18, "status": "bad" }
      ]
    }
  ],
  "violations": [                      // NL, actionable, ONLY the sub-threshold gaps
    "Sofa is 18 cm from Desk — needs 60 cm; move them 42 cm further apart.",
    "Sofa is 42 cm from the left wall — needs 60 cm; shift it 18 cm right."
  ]
}
```

Rationale for each layer:
- `satisfied` + `worstStatus` — the agent's **stopping condition**; the loop ends when
  `satisfied === true` across all subjects and the brief's furniture is all placed.
- `gaps[].gapCm` (integer cm) — the **precise, monotone signal** the agent optimises against;
  centimetre integers avoid the agent chasing sub-millimetre float noise, and the *delta to
  threshold* is directly computable, so the agent can compute exactly how far to move.
- `violations[]` — the **actionable instruction** ("move them 42 cm further apart"),
  computed as `round((thresholdM − gapM) * 100)` cm; this is what makes a weaker agent
  converge instead of guessing. Overlap (`gapM ≤ 0`) reads as "overlapping — separate them".

**`check_brief`** → the goal oracle. Combines `get_metrics` + `check_clearance` against the
stored brief and returns `{ satisfied, unmet: [ … ] }` where `unmet` enumerates, in NL, each
requirement not yet met: missing furniture (`"brief needs a desk; none placed"`), room-size
mismatch (`"room is 3.8×5.0 m; brief asked 4×5 m"`), and every clearance violation. This is
the single call an agent polls to decide whether it is done. `satisfied` here is the true
end-of-loop signal (brief-level, not just clearance-level).

### Why this shape works as a loop (worked trace)

1. `set_brief {room:{w:4,h:5}, furniture:[{type:"bed"},{type:"desk"},{type:"sofa"}], minWalkwayM:0.6}`
2. `add_room {rect:{x:0,y:0,w:4,h:5}}` → `{room:"w0", metrics:{areaM2:20,…}}`
3. `place_symbol {type:"bed", …}` ×3 (bed/desk/sofa) → each returns its own clearance readout.
4. `check_brief` → `satisfied:false, unmet:["Sofa is 18 cm from Desk — needs 60 cm …"]`.
5. Agent reads the exact deficit, calls `move_symbol` to open the gap.
6. `check_brief` → `satisfied:true`. Loop ends.
7. `save_plan` and/or `get_share_url` → human opens the result.

The convergence-test harness (Test requirements) scripts exactly this and asserts the loop
terminates with `satisfied:true` and a `validatePlan`-passing document.

## Data model / types

The **Plan document is unchanged** — it is exactly `plan.js`'s shape (`schema:1`,
`app:"floorplan"`, `walls.rooms[]`, `walls.chain[]`, `symbols.symbols[]`, `view`, `unit`).
The server introduces only two small in-memory types of its own; neither is persisted into
the Plan (they stay server-side, exactly as clearance settings stay session-only in LLD 24).

```ts
// The parsed requirements the agent is trying to satisfy (mcp/src/brief.js).
type Brief = {
  room?: { w: number; h: number };          // target room dims, metres (optional)
  furniture?: { type: SymbolType; count: number }[]; // required pieces (count default 1)
  minWalkwayM: number;                       // default DEFAULT_THRESHOLD (0.60)
};

// The convergence payload returned by check_clearance (mcp/src/feedback.js).
type ClearanceReport = {
  thresholdM: number;
  satisfied: boolean;                        // no sub-threshold gap across all subjects
  worstStatus: "ok" | "tight" | "bad";
  items: {
    id: string; label: string; worstStatus: "ok" | "tight" | "bad";
    gaps: { to: string; kind: "wall" | "symbol"; neighbourId?: string;
            gapCm: number; gapM: number; status: "ok" | "tight" | "bad" }[];
  }[];
  violations: string[];                      // NL, actionable, only sub-threshold gaps
};

// The brief oracle returned by check_brief.
type BriefReport = { satisfied: boolean; unmet: string[] };
```

`SymbolType` and the clamp bounds are read directly from `symbols.js` `CATALOG` — the server
does not redeclare them (single source of truth). `gapCm = round(gapM * 100)`; deltas in
`violations` = `round((thresholdM − gapM) * 100)`.

Tool argument/result schemas are declared with the MCP SDK's Zod (or JSON-Schema) input
shapes in `tools.js`; they mirror the tables above. Coordinates are metres, symbol `x,y` are
the **center** (matching `symbols.js`), and `add_room {rect}` uses top-left `x,y` + `w,h` for
agent convenience (converted to 4 center-agnostic verts internally).

## State model

**The core singletons ARE the session's working plan.** `walls.model`, `symbols.model`, and
`clearance.js`'s `threshold` are module-level singletons the core mutates in place (that is
why they expose `hydrate()`). The server does not fight this — it embraces it: there is
exactly **one live plan per server process**, and it lives in those singletons.

**Load / edit / dump cycle:**
- **Load:** `new_plan` hydrates the singletons to empty (`applyPlan` of a fresh
  `buildPlan()`-shaped empty doc); `load_plan` validates then `applyPlan`s a supplied doc.
- **Edit:** mutator tools call `walls.*` / `symbols.*` directly against the singletons. No
  copy is made; the mutation *is* the state change.
- **Dump:** `get_plan` / `save_plan` / `get_share_url` call `buildPlan()` to snapshot the
  singletons into a JSON-safe document on demand. Evaluators read live from
  `walls.model.rooms` / `symbols.model.symbols` (or a fresh `buildPlan()`).

**Concurrency contract (the hazard, addressed explicitly).** The core mutating shared
singletons is a real hazard *if* two logical plans were ever edited at once. It is safe here
because: (a) stdio MCP is **one process serving one client**; (b) every tool handler is
**synchronous around its core mutation** — the only `await`s are at the I/O edges
(`save_plan` file write, `get_share_url` compression), and by then the mutation has already
committed to the singletons, so no two handlers interleave a half-applied `hydrate`/edit.
The Node event loop gives us run-to-completion per handler for free. To make the invariant
explicit and future-proof against someone spawning a second logical session, `session.js`
holds a **single-session guard**: an `active` flag set on `new_plan`/`load_plan`; there is no
API to open a second concurrent plan in one process. If the server is ever made to serve
multiple plans, it MUST move to a real session store keyed by session id, each doing its own
`hydrate → edit → buildPlan` around a mutex — recorded here as the migration path, not built.

**Persistence.** Nothing new is persisted. The plan lives in memory for the session; it
reaches disk only when the agent calls `save_plan` (a `serializePlan()` file in the sandboxed
plans dir) or the URL when it calls `get_share_url`. No `localStorage` (that is `store.js`,
browser-only and not imported). The brief and clearance threshold are **server-session state
only**, never written into the Plan JSON — so `save_plan` / `get_share_url` output stays
byte-identical to what the web app would produce for the same geometry (a regression assert
in Test requirements).

**Reset semantics.** Because the singletons persist for the process lifetime, `new_plan`
MUST fully reset them (empty rooms/chain/symbols, threshold back to default) so a second
brief in the same process doesn't inherit stale geometry. `load_plan` likewise fully
replaces (not merges) via `applyPlan`.

## Resources & prompts

MCP has three server-side primitives; the loop is carried by **Tools**, but Resources and a
Prompt add cheap context. All are optional to the loop and small.

**Resources (app-controlled context the client attaches):**
- `floorplan://plan/current` — the live Plan document (`buildPlan()` serialized). Lets the
  client show/attach the current state without a tool round-trip.
- `floorplan://catalog` — the `symbols.js` `CATALOG` (types, default w/h, and **`min`/`max`
  clamp bounds**), so the agent knows the legal size range before it calls `resize_symbol`
  and doesn't waste turns hitting clamps.
- `floorplan://brief/current` — the active `Brief`, so the requirements are visible as
  context, not just implied by prior tool calls.

**Prompt (user-controlled template):**
- `design_room` — a starter template ("Design a {dims} room with {furniture}, {walkway} cm
  walkways"). Invoked by the *user*, it seeds a `set_brief` + the design loop. This is the
  neal.fun-friendly "just ask it to design my studio" entry point.

**Client primitives the server MAY request — considered:**
- **Elicitation** (server asks the *user* mid-task): genuinely useful for
  requirement-gathering — if a brief is ambiguous ("bed against which wall?", "is 60 cm the
  min or a target?"), the server could elicit before iterating. **Deferred from MVP**: it
  adds a client-capability dependency and the prototype's job is to first learn whether the
  agent even needs it. Noted as a strong fast-follow for briefs that under-specify.
- **Sampling** (server asks the client's LLM to generate): **out of scope** — the agent
  already *is* the LLM driving the tools; server-initiated sampling would invert the loop.
- **Roots** (client-declared filesystem boundaries): relevant to the file-I/O surface. If
  the client provides roots, `io.js` SHOULD confine the plans dir to a declared root; if not,
  it falls back to its own configured plans dir (see Edge cases / security). Honouring Roots
  is the MCP-idiomatic version of the sandbox and is a small, worthwhile MVP inclusion.

## Edge cases

1. **Invalid `load_plan` document.** `validatePlan` returns `null` → tool returns
   `{ ok:false, error:"invalid plan document" }`, singletons untouched. Never throws.
2. **Newer-schema document** (`schema > 1`). `validatePlan` rejects it; server returns a
   distinct message ("made with a newer version of floorplan"), mirroring `importJson`.
3. **Out-of-range symbol dim** in `place_symbol`/`resize_symbol`. Routed through `clampDim`;
   the returned result reports the clamped value and a `clamped:true` flag so the agent knows
   its request was adjusted (avoids it looping trying to exceed a catalog max).
4. **`set_edge_length` with a bad index or degenerate edge.** `rescaleEdge` returns `false`;
   tool returns `{ ok:false, reason:"edge index out of range" | "degenerate edge" }`.
5. **`add_room` with < 3 verts / collinear verts.** `closeRoom` no-ops below 3; tool returns
   `{ ok:false, reason:"a room needs at least 3 corners" }`. Zero-length segments are dropped
   by `placeVertex`'s `MIN_SEG_M` guard, matching the app.
6. **`check_clearance` on a symbol in no closed room.** `computeClearances` yields only
   symbol-to-symbol gaps (wall rows omitted) — inherited from LLD 24 behaviour; the report's
   `violations` simply won't include wall items. If the brief required a room, `check_brief`
   flags the missing room separately.
7. **`check_clearance` subject is an opening (door/window).** `computeClearances` returns
   `[]` for openings (LLD 24); the report lists no gaps for it. The evaluator only iterates
   furniture subjects, so openings are naturally excluded.
8. **Overlapping furniture.** `computeClearances` yields `gap:0`, `status:"bad"`; the
   violation reads "overlapping — separate them"; `satisfied:false`. This is the agent's cue
   to move a piece, and is the common early-iteration state.
9. **Rotated furniture.** Inherited AABB over-estimate → conservative (smaller) gaps. The
   feedback string notes gaps are bounding-box based when any subject is rotated, so the
   agent isn't surprised by a slightly pessimistic number.
10. **Empty plan evaluated.** `get_metrics` → empty rooms list; `check_clearance` → no items,
    `satisfied:true` vacuously *for clearance* — but `check_brief` returns `satisfied:false`
    with `unmet` listing all required furniture/room. The brief oracle is the real gate.
11. **`save_plan` path traversal.** `filename` is sanitised to a basename (`path.basename`),
    forced to `.json`, and joined onto the plans dir; any `..`/absolute path is rejected. The
    resolved path is re-checked to be inside the plans dir (or a client-declared Root) before
    writing. No writes outside the sandbox.
12. **Plans dir missing.** Created on demand (`mkdir -p`) under the configured/Root dir; if
    creation fails, `save_plan` returns `{ ok:false, error }` rather than crashing the server.
13. **`get_share_url` when `CompressionStream` unavailable.** `encodePlanToHash` already falls
    back to the uncompressed `u` codec — the URL is still valid, just longer. No special
    handling needed.
14. **Second concurrent session attempt.** Single-session guard rejects it with a clear
    error; the design has no path to two logical plans sharing the singletons (State model).
15. **Agent supplies non-finite coordinates** (`NaN`/`Infinity`). Mutator arg validation
    rejects with `{ ok:false, reason }`; even if one slipped to the core, `validatePlan` on
    the next dump would catch it — but the guard is at the tool boundary so the singletons
    never hold non-finite values.
16. **Brief never set, agent calls `check_brief`.** Returns `{ satisfied:false, unmet:["no
    brief set — call set_brief first"] }` rather than erroring, keeping the loop self-healing.
17. **`unit` in the loaded document is `ft`.** The core works in metres regardless; feedback
    is always metres+cm. `unit` is preserved through `buildPlan`/`applyPlan` for the human's
    view but does not affect evaluation.

## Dependencies

**Must exist before implementation (all present and verified Node-importable):**
- `src/js/plan.js` — `buildPlan`, `validatePlan`, `applyPlan`, `serializePlan`, `PLAN_SCHEMA`.
  *The document contract.* (present)
- `src/js/walls.js` — `model`, `hydrate`, `placeVertex`, `closeRoom`, `finishChain`,
  `rescaleEdge`, `polygonArea`, `perimeter`, `roomMetrics`, `WALL_M`. (present)
- `src/js/symbols.js` — `model`, `hydrate`, `CATALOG`, `createSymbol`, `addSymbol`,
  `moveSymbol`, `rotateSymbol`, `resizeSymbol`, `clampDim`, `removeSymbol`, `duplicateSymbol`,
  `getSymbol`, `corners`. (present)
- `src/js/clearance.js` — `computeClearances`, `classify`, `worstStatus`, `setThreshold`,
  `DEFAULT_THRESHOLD`, `THRESH_MIN/MAX`. *The requirement-evaluator.* (present; LLD 24)
- `src/js/share.js` — `encodePlanToHash` (pure; Node-safe). (present)
- `src/js/view.js`, `src/js/units.js` — imported transitively by `plan.js`; DOM-free at load.

**New (all under `mcp/`, no `src/` changes):** `mcp/package.json`, `mcp/src/server.js`,
`session.js`, `tools.js`, `feedback.js`, `io.js`, `brief.js`, `mcp/README.md`, and the
`mcp/` test files.

**External dependency:** `@modelcontextprotocol/sdk` (the official MCP TypeScript/JS SDK) for
stdio server + tool/resource/prompt registration. This is the **only** runtime dependency and
lives **solely in `mcp/package.json`** — `src/` gains no dependency and no build step, honouring
the build-less principle. Node ≥ 18 is required for `CompressionStream`/`structuredClone`
(dev box runs Node 22; verified).

**No dependency on** persistence (`store.js`), history, rendering, or any DOM module.

**Roadmap relationship (no duplication).** Because everything funnels through `plan.js`, this
does **not** overlap Phase 3 (Supabase accounts, #4). Phase 3 is human cross-device *sync*;
this is agent *authoring*. They are orthogonal and intersect only at the `plan.js` contract:
when Phase 3 lands, the server could gain a user-scoped Supabase storage adapter using the
*same* contract, with **no format rework**. Security constraints to carry forward *if that
happens* (recorded, not built here): the server would authenticate **as the user**
(user-scoped JWT) so Postgres RLS governs it like the web app, and it must **never** use a
`service_role` key. None of that is in this LLD's scope.

## Open questions (resolved / deferred)

| # | Question | Disposition |
|---|---|---|
| Q1 | **Tool granularity** — fine-grained vs coarse `apply_plan` vs both. | **Resolved (provisional):** fine-grained mutators as the primary surface + one coarse `load_plan(document)` escape hatch; no free-form coarse write. **To be validated empirically** — the prototype exists partly to learn whether the agent converges faster with finer/coarser tools; expect revision after real-agent runs. |
| Q2 | **Stateful vs stateless.** | **Resolved:** stateful single in-memory session; the core singletons *are* the session plan; load/edit/dump discipline + single-session guard. Stateless transforms rejected (kills the iterate-cheaply loop). |
| Q3 | **Headless preview (SVG/PNG).** | **Resolved for MVP: skip.** Rely on text metrics + clearance feedback; add a **standalone SVG serializer** (not jsdom) as a fast-follow only if prototype runs show the agent thrashing for lack of a visual. |
| Q4 | **Validation on read.** | **Resolved:** `validatePlan()` every ingested doc; its bounds are sufficient. Noted gap: it checks finite dims but doesn't re-clamp to catalog range — closed on the mutator side via `clampDim`. No `plan.js` change. |
| Q5 | **Local security surface.** | **Resolved:** sandbox file I/O to a designated plans dir; `path.basename` + inside-dir re-check; honour MCP **Roots** if the client declares them; no `eval`/shell (core is pure data). |
| Q6 | **`../src/js` import + surviving `npm publish`.** | **Deferred (framing recorded).** MVP uses the dev-checkout relative import, which is knowingly **not self-contained** and breaks under `npx`. Before any publish, resolve via one of: bundle the core into the artifact at build time, vendor a synced copy with a drift check, or depend on a separately-published core package. The import-smoke test is the early-warning for `src/` coupling drift. #32's acceptance criteria were corrected to reflect this deferral. |
| Q7 | **One-click install bundle** (`.mcpb` / Desktop Extension). | **Deferred.** Depends on that format being stable; a nice-to-have for non-technical users, orthogonal to the tool-design questions the prototype answers. Revisit in the productionization phase alongside Q6. |
| Q8 | **Room-to-room overlap evaluation** (raised by external feedback on #32). | **Deferred (out of MVP scope, gap acknowledged).** No evaluator — in `src/` or this server — checks whether two room *polygons* intersect; `validatePlan` is purely structural and `clearance.js` is symbol-subject only, so a plan with overlapping rooms passes every check. The MVP's single-room brief cannot generate this case, so it is not a convergence blocker for the prototype. If the brief grows to multi-room layouts, add a polygon-polygon intersection test (new pure fn in `walls.js` or `mcp/`) feeding a `check_brief` `unmet` entry. Recorded as the first evaluator to add when multi-room support is scoped. |

**Escalation to CEO (product call, not a design call):** the MVP is intentionally
*not shippable* — its output is a *validated tool/feedback design*, not a released package.
If the owner wants a publicly installable server sooner, that reprioritises Q6/Q7 (npm
identity, 2FA, bundling) ahead of empirical tool iteration — a scope/timeline tradeoff for
the CEO, not something this LLD decides. No CX doc exists for an agent-facing surface, so
there is no user-flow conflict to flag.

## Test requirements

Tests live under `mcp/` and run in **Node** (no browser needed — the whole subsystem is
headless), via a plain `node --test` runner in `mcp/package.json`'s `test` script. They do
**not** join the app's browser `tests.html` harness (that stays build-less and DOM-based);
`mcp/` owns its own Node test suite. Organised by category:

### Unit — feedback shaping (`feedback.js`, the loop's core)
- `check_clearance` report: given a known two-symbol layout with an 18 cm gap and a 60 cm
  threshold → `satisfied:false`, `worstStatus:"bad"`, a `gaps[]` entry with `gapCm:18`, and a
  `violations[]` string containing the correct deficit ("needs 60 cm", "42 cm further apart").
- Boundary: a gap exactly at threshold → `status:"ok"`, `satisfied:true`, no violation.
- Overlap (`gapM ≤ 0`) → "overlapping — separate them", `satisfied:false`.
- `gapCm`/delta rounding is integer-cm and matches `round(gapM*100)` / `round((thr−gapM)*100)`.
- Rotated subject → report notes bounding-box basis; gap is the conservative (smaller) value.
- `check_brief` oracle: missing furniture, room-size mismatch, and clearance violations each
  appear in `unmet`; a fully-satisfying plan returns `satisfied:true, unmet:[]`.

### Unit — mutators & session (`tools.js`, `session.js`)
- `add_room {rect}` builds a closed 4-vert room whose `roomMetrics.area` matches `w*h`.
- `set_edge_length` produces the exact target length (via `rescaleEdge`); bad index / degenerate
  edge → `{ok:false,reason}` (no throw).
- `place_symbol`/`resize_symbol` clamp out-of-range dims and report `clamped:true`.
- `new_plan` fully resets singletons (no stale geometry from a prior brief in-process).
- `load_plan` with an invalid / newer-schema doc → `{ok:false,error}`, singletons untouched.
- Single-session guard rejects a second concurrent session.

### Unit — I/O sandbox (`io.js`, security)
- `save_plan` writes a `serializePlan()` file into the plans dir.
- Path-traversal filenames (`../evil`, absolute paths, `..%2F`) are rejected; resolved path is
  re-verified inside the plans dir (or declared Root) before any write.
- Missing plans dir is created; creation failure returns `{ok:false}` without crashing.

### Integration — headless import boundary
- Import each depended-on `src/js` module under Node and assert **no throw at load** (the
  Q6 drift early-warning). Assert `share.js`'s `encodePlanToHash` runs headless and its output
  round-trips through `decodeHashToPlan` back to an equal plan.

### Integration — the convergence loop (the headline test)
- A **scripted "agent"** (deterministic, not an LLM) drives the tools to satisfy a fixed
  brief ("4×5 m studio; bed + desk + sofa; 60 cm walkways"): `set_brief` → `add_room` →
  `place_symbol`×3 (deliberately too close) → poll `check_brief` → on each violation, apply
  the exact `move_symbol` deficit from `violations` → re-poll. **Assert the loop terminates**
  (bounded iteration count) with `check_brief.satisfied === true`.
- Assert the final `get_plan` document passes `validatePlan()` and that `check_clearance`
  over all furniture reports `worstStatus:"ok"`.
- This test is the executable proof that the feedback shape actually *closes the loop* — its
  failure means the tool/feedback design, not the code, is wrong (which is the whole reason
  the prototype exists).

### Regression — byte-compatibility with the app
- A plan built via the tools, dumped with `save_plan`/`get_plan`, is **byte-identical** to
  what the web app's `buildPlan`+`serializePlan` produce for the same geometry (brief and
  clearance-threshold session state leak **no** fields into the Plan JSON).
- The emitted document is accepted by the same `validatePlan` the app's `importJson` uses
  (shared function — asserts the handoff contract holds).

### Not tested here (out of scope, deferred with Q6/Q7)
- npm packaging, `npx` self-containment, `.mcpb` bundle — no tests until productionization.
- Live LLM agent behaviour — the scripted agent stands in; real-agent runs are a manual,
  observational step whose findings feed back into Q1/Q3, not an automated assertion.
