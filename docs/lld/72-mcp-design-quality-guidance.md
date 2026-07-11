# LLD 72: MCP design-quality guidance — teaching the agent to lay out a *spacious, aesthetic* room, not just a *feasible* one

> **Status: RESEARCH / DESIGN.** This LLD maps each auto-checkable design rule to a
> concrete formula and a concrete MCP surface, weighs options, and recommends a scope +
> phasing. It does **not** authorize implementation; a human picks a phase to build.

## Scope

This LLD addresses a gap in the **dev-only MCP server** (`mcp/`, LLD 32): its evaluators
check whether a plan is *feasible* (room dims, furniture counts, walkway clearances) but
never whether it is *well laid out*. The task is to design how to steer an AI agent toward
a **spacious, aesthetic** single-room layout, keeping the auto-checkable (`[GEO]`) rules
strictly separate from the subjective (`[SOFT]`) ones.

**Primary architectural decision — where the interior-design intelligence lives.** The
recommended default is a **layered split**:

- **A SKILL is the designer "brain."** The interior-design know-how — the workflow, the
  `[GEO]` + `[SOFT]` heuristics, the arrangement priority order, and *how to drive the
  existing MCP tools* to arrange a spacious/aesthetic room — lives as **prose an LLM
  interprets**. Prose degrades gracefully, is trivial to iterate, and is the natural home
  for every `[SOFT]` rule (focal-point choice, balance, "feels open") — as *guidance,
  never a hard gate*.
- **The MCP is the "hands."** Today's geometry mutators/evaluators, **plus an OPTIONAL
  future `check_layout` evaluator** for the precise `[GEO]` measurements that need trig
  against live plan geometry (sofa = 60–75% of the facing wall, TV at 1.5–2.5× diagonal,
  facing seats ≤ 2.4 m, seating oriented at the focal element). An LLM eyeballing
  `get_plan` JSON and doing this arithmetic by hand is unreliable; a deterministic
  evaluator importing the geometry core is robust. But it is **optional for v1** — a skill
  reasoning over `get_plan` + the existing `check_clearance` is a cheaper first cut. Add
  the evaluator later only if the LLM's unaided geometric judgment proves shaky.

The **per-rule `[GEO]`/`[SOFT]` table and formulas below are location-agnostic** — they
define *what* to check; the skill-vs-MCP split only decides *where* each piece lives. Each
rule therefore carries a **"lives in"** disposition (SKILL prose / MCP evaluator / both).

**In scope**
- The skill-vs-MCP layered decision above, argued (not just asserted) against alternatives.
- A `[GEO]`/`[SOFT]` classification of every candidate design rule, each `[GEO]` rule
  reduced to an exact checkable formula in the y-DOWN metric AABB model the core uses, with
  a "lives in" column.
- A concrete **skill shape**: name, when-to-use trigger, workflow steps, and how it
  references the `[GEO]`/`[SOFT]` rules (following `SKILL.md` conventions).
- A **furniture-role grouping** (which `CATALOG` types are seating / tables / focal /
  storage), since the catalog carries no such semantic today (`type` + `category` only).
  The skill needs this to reason; a future evaluator needs it to compute.
- The design of the **optional future `check_layout` evaluator** (signatures, return shape
  modelled on `ClearanceReport`) and how it would coexist with `check_clearance` /
  `check_brief` without conflicting `suggestedMove`s — as a *later phase*, not v1.
- Whether any layout signal is ever a **hard gate** (recommendation: no — advisory only).
- A phase-1 slice: the highest design value at the lowest cost/risk.

**Explicitly NOT in scope**
- **Any implementation.** No `src/` or `mcp/` source changes and no `SKILL.md` file are
  authorized by this LLD. It is a design to be reviewed and phased by a human.
- **Enriching the `design_room` MCP prompt into the full designer brain.** The prompt may
  gain a one-line pointer, but the design knowledge lives in the SKILL, not the prompt (a
  registered MCP prompt is harder to iterate than a skill file and is dev-only surface).
- **Multi-room layout quality and room-to-room relationships** (zoning, adjacency, flow
  between rooms). The MVP brief is single-room (LLD 32 Q8); this LLD stays single-room.
- **`[SOFT]` rules as pass/fail.** Subjective qualities (visual weight, "cozy vs airy",
  style coherence) may appear only as **prompt hints or non-scoring advisories**, never as
  a `satisfied:false` gate. Making taste a hard gate would produce a livelocking oracle.
- **New geometry the model cannot express without a data-model change** is *analyzed* here
  and dispositioned (INCLUDE / ADAPT / DEFER) but **not built**. Specifically: rug objects,
  focal-element designation, and furniture facing/orientation semantics beyond `rot`.
- **3-D / height-dependent rules** (TV mount height 42 in, sightline over a sofa back).
  The model is 2-D plan-view (`x,y,w,h,rot`); anything needing a z-axis is DEFERRED.
- **Widening the shared `clearance.js` threshold clamp** (`[0.30, 1.20] m`) or the shared
  editor's runtime behaviour. All new checks are MCP-side or shared *pure additive*
  helpers; `src/js/*` must stay Node-clean (LLD 32 import boundary).
- **Room sizing / proportion checks** (golden-ratio aspect, IRC minimums) — see the Scope
  recommendation below; these are analyzed and **DEFERRED** with rationale, not built.

## Problem statement

The MCP validates **feasibility, not design quality.** An agent's incentive, as currently
shaped, is to place the required pieces and shove them apart until no walkway is
sub-threshold, then stop — reliably producing a plan that *passes* but is un-spacious and
un-aesthetic (a sofa marooned mid-room, no focal point, a TV nowhere near viewing distance,
furniture floating off the walls, no symmetry). Grounded in the code:

- **The prompt teaches a place-and-declutter loop with zero design vocabulary.** The
  `design_room` prompt (`mcp/src/server.js:232-245`) says only: *"First call set_brief,
  then add_room at the exact dims, then place each piece, then poll check_brief and apply
  each violation's suggestedMove until satisfied."* (the loop clause is `server.js:240-242`.)
  Nothing about focal points, seating groups, TV distance, pulling seating off walls, or
  symmetry — and its explicit *"apply each violation's suggestedMove until satisfied"* is a
  **direct driver** of the marooned-sofa anti-pattern (see the fourth bullet, and the
  phase-1 prompt edit that neutralizes it).

- **The goal oracle rewards only three things.** `tool_check_brief` (`mcp/src/tools.js:538`)
  reports `satisfied` iff (1) the room bbox matches the target `±0.025 m`
  (`tools.js:562`), (2) the required furniture **count** is present (`tools.js:578-593`),
  and (3) `buildClearanceReport` yields no violations, whose every entry is pushed verbatim
  into `unmet` (`tools.js:596-597`). `check_clearance` / `feedback.js` is purely geometric
  gap-checking (walkway deficits, boxed-in, `suggestedMove`).

- **The brief cannot even *express* a design goal.** `Brief` (`mcp/src/brief.js:32-35`) is
  `{ room?:{w,h}, furniture:[{type,count}], minWalkwayM }` — no notion of a focal element,
  a seating group, an intended TV, or an arrangement style.

- **The one quality signal it *does* have is pointed the wrong way.** The walkway default
  is `0.915 m` (`brief.js:25`, ADA/IRC-grounded) and `check_brief` flags *any* gap below
  it as a violation to widen. But the design research says furniture *within one seating
  group* should sit **0.46–0.61 m** apart, and **>0.76 m "feels disconnected."** So the
  current hard gate actively pushes grouped seating **past** the disconnection threshold —
  a concrete mechanism for the "marooned sofa." Walkway clearance and intra-group
  closeness are *different measurements on the same pair of pieces*, and the oracle
  currently applies the walkway rule to both. This is the single most important interaction
  the design must resolve (see Interaction).

Net: the agent is optimizing a proxy (no sub-threshold gaps) that is not just *silent* on
spaciousness/aesthetics but, for seating groups, **anti-correlated** with them. User
framing: *"an AI won't know how to plan a spacious/aesthetic room by itself"* — correct,
and worse, the current oracle nudges it away from good grouping.

## Architecture decision: skill (brain) vs MCP (hands)

This is the doc's primary decision. Three ways to deliver design intelligence:

| Option | Where knowledge lives | Iterate cost | Geometric rigor | Portability |
|---|---|---|---|---|
| **A. All in MCP** (rich prompt + evaluator tools; brief extension) | Registered prompt + JS | High (code change + restart) | High | Only where the dev MCP is wired |
| **B. All in skill** (prose reasons over `get_plan`/`check_clearance`) | `SKILL.md` prose | Low (edit a file) | Low (LLM does trig by eye) | Any Claude agent with the skill |
| **C. Layered: skill brain + MCP hands (+ optional evaluator)** ← **recommended** | Prose for know-how; JS only for hard trig | Low for know-how, high for evaluator (rare) | High where it matters | Skill anywhere; evaluator where MCP is wired |

**Recommendation: C, and start as B (skill-only), promoting specific rules to a
`check_layout` evaluator only when the LLM's unaided geometry proves shaky.**

Rationale, grounded in this project's realities:

1. **The MCP is dev-only (LLD 32 Scope; not shippable, not `npx`-installable).** The usual
   "put it in the MCP so it's portable / reusable" argument is therefore **weak** — the MCP
   is not a distributed artifact. The realistic consumer of this guidance is *a Claude
   agent that can load skills* (the ship-batch/propose fleet, or a human running Claude
   against the checkout). A skill is portable to exactly that consumer; the MCP is not.

2. **Design know-how is prose, not code.** Rules like "pick a focal element," "pull seating
   6–12 in off the wall," "seats should face each other within 2.4 m" are *judgment an LLM
   already has priors for* and that we want to **tune weekly by editing text**. Encoding
   them as JS (Option A) makes every wording tweak a code change + server restart, and the
   `[SOFT]` ones cannot be encoded as pass/fail at all without producing a livelocking
   oracle. Prose degrades gracefully: a rule the agent can't fully satisfy becomes a
   best-effort, not a hard failure.

3. **But some `[GEO]` rules genuinely need deterministic trig against live geometry.** "Is
   the sofa 60–75% of its facing wall?" requires identifying the facing wall segment,
   projecting the sofa footprint, and dividing — over rotated AABBs, in a y-down frame with
   the same sign traps that bit LLD 59. An LLM reading `get_plan` JSON and doing this by
   hand is unreliable and non-reproducible. These specific rules are the case for a
   `check_layout` evaluator that imports the geometry core (exactly the leverage LLD 32's
   evaluators already exploit for clearance). **This is the "hands" the skill can't
   replace by reasoning.**

4. **Cheapest correct first cut is skill-only.** A skill that (a) sets the brief, (b) drives
   the existing mutators, (c) polls the existing `check_clearance` for feasibility, and
   (d) reasons about layout quality over `get_plan` + the `[GEO]` formulas below, needs
   **zero code**. It captures most of the value (a focal point, seating pulled off walls,
   a real conversation group, TV roughly at distance) immediately. We add the evaluator
   only for the rules where step (d)'s by-eye arithmetic measurably fails in real runs —
   an empirical trigger, mirroring LLD 32's own "add a preview only if the agent thrashes"
   discipline (Q3).

**What this means for the rest of the doc.** The `[GEO]`/`[SOFT]` table is the core
deliverable regardless of option — it is *what* to check. Every rule gets a **"lives in"**
disposition. The skill shape is specified concretely (it is the phase-1 deliverable). The
`check_layout` evaluator is fully designed but explicitly a *later phase*.

## Scope recommendation: single-room layout only (defer room sizing/proportion)

The task defers the layout-vs-also-sizing scope to this LLD. **Recommendation: cover
single-room *layout* only; DEFER room sizing / proportion.**

Rationale (the surviving grounds — see the note below on why "no actuator" is *not* one):
- **The room already comes from the brief.** The agent builds the room to the brief's exact
  `{w,h}` as step 1 (`check_brief` room-size gate, `tools.js:547-575`; LLD 32 M2/M3). By
  the time layout matters, the room's dimensions are a given, not a free variable — a
  proportion check would either duplicate the brief or fight the dimension the user asked
  for. Improving proportion means *overriding a stated requirement*, which is a product
  decision, not a layout one.
- **The wedge is "does my couch fit," not "size my addition."** Room-shape advice is a
  different product (a space-planning / renovation tool). Layout quality inside a *given*
  room is the direct extension of the existing clearance feature.
- **A non-destructive resize actuator now EXISTS — and room sizing is still deferred as a
  deliberate scope/product choice, not a tooling gap.** `resize_room` (`tools.js:313`) calls
  `rescaleRectEdge` (`walls.js:496`) to resize a rectangle in place, leaving all placed
  furniture untouched; `check_brief` itself now steers the agent to it
  (`tools.js:564-567`). This **supersedes LLD 32 M2's "deliberately no `resize_room`, and
  `set_edge_length`→`rescaleEdge` only deforms"** (LLD 78 / PR #90). So the old "the only
  path is `new_plan` + rebuild, which throws away furniture" argument is **obsolete** — a
  proportion change is now cleanly actuatable mid-layout. Room sizing is deferred anyway on
  the two grounds above (it fights a brief-given dimension; it is a different product), not
  because the tooling can't do it.
- **IRC minimums and golden-ratio aspect are still catalogued below** (as DEFERRED rules)
  so the analysis is complete and a future room-sizing phase can pick them up. **Forward
  note:** because `resize_room` already exists, that future phase is *cheaper than this
  deferral implies* — the actuator is built, so a room-sizing feature is mostly the
  *guidance* (skill prose: golden-ratio, avoid-square, avoid-bowling-alley) plus letting the
  brief *propose* dims rather than only match them. If a future brief lets the agent propose
  room dims, revisit — those rules become live, and they belong in the SKILL as prose (they
  are proportion heuristics, not live-geometry trig).

**Explicitly deferred by this scope choice:** room aspect-ratio / golden-ratio guidance,
avoid-perfect-square / avoid->2:1-bowling-alley, IRC habitable-room minimums
(`[CODE]` ≥ 70 sq ft & ≥ 7 ft min dimension), and any multi-room zoning/adjacency/flow.

## Furniture-role groupings (a prerequisite the catalog lacks)

Nearly every design rule is stated in terms of *roles* ("seating," "the coffee table,"
"the focal element"), but `CATALOG` (`src/js/symbols.js:58-231`) carries only `type` +
`category ∈ {openings, living, kitchen, bedroom, bath}`. `category` is a *room-zone* tag,
not a functional role — `sofa`, `tv`, `desk`, `bookshelf`, and `coffee-table` are all
`living`. So the rules need a **role mapping** over `type`. This is derived data, needed by
both the skill (to reason) and any evaluator (to compute); it should be defined **once**.

Proposed roles (a **static** `type → role[]` map; a type may hold more than one role). The
map assigns *every plausible* role for a type — it does **not** encode size or context.
`table` therefore carries **both** `coffee-table` and `dining-table`; which one applies to a
given instance is resolved at reasoning time by context (size, proximity — see the ambiguity
note), not by the map:

| Role | Types (`CATALOG` keys) | Used by rules |
|---|---|---|
| `seating` | `sofa`, `armchair`, `chair` | conversation group, off-wall pull, face-the-focal, spacing |
| `coffee-table` | `coffee-table`, `table` | coffee-table distance & length-ratio |
| `dining-table` | `table`, `dining-table-round` | dining-rug, chair clearance (future) |
| `bed` | `bed` | bedside/foot clearance, headboard-against-wall |
| `focal-candidate` | `tv`, (window/opening as focal) | focal-element designation, seating orientation |
| `anchorable` (wants a wall at its back) | `sofa`, `bed`, `tv`, `bookshelf`, `dresser`, `wardrobe`, `desk`, `cabinet` | off-wall vs against-wall reasoning |
| `storage` | `bookshelf`, `wardrobe`, `dresser`, `cabinet`, `nightstand` | against-wall, symmetry pairs (nightstands) |

Note `fireplace` is **not in `CATALOG`** (so it cannot be a `focal-candidate` type today —
see Data-model gaps); `tv` is the only modelled electronic focal element. A window/opening
can serve as focal but is an `opening` type, so the skill designates it by intent rather
than by a role-map entry.

**Where this lives (recommended):** as **prose in the skill** for v1 (a small table the LLM
reads), and — *if and when* the `check_layout` evaluator is built — as a single exported
`ROLES` constant in a shared module the evaluator imports (candidate: a new
`mcp/src/roles.js`, MCP-only, since roles are a design concept the editor UI does not need;
if the editor ever wants them, promote to `src/js/`). Defining it in two places is a drift
hazard, so if both exist, the JS constant is the source of truth and the skill cites it.

**Multi-role ambiguity is real, and the static map deliberately does not resolve it.** A
`table` holds both `coffee-table` and `dining-table`; a `chair` may be dining or accent
seating. Which role applies to a specific instance is *contextual* (size, proximity to a
sofa vs a dining table) — exactly the fuzzy judgment that belongs in **skill prose**, not a
brittle catalog flag or a size threshold baked into the map. A future evaluator would need
an explicit disambiguation heuristic (e.g. a `table` within ~1 m of a sofa front is the
coffee table; a `table` with ≥ 4 chairs around it is the dining table); that heuristic is a
documented follow-up, not v1. Until it exists, an evaluator should treat a dual-role piece
conservatively (skip a role-specific rule rather than mis-apply it — see Edge case 7).

## Per-rule table

Legend: **`[GEO]`** = reducible to a deterministic geometric check; **`[SOFT]`** =
subjective, guidance only (never a pass/fail gate). **Lives in:** *Skill* (prose an LLM
applies), *MCP* (a computed `check_layout` measurement), or *Both* (skill states intent,
evaluator verifies the number). **Disp:** *IN* = checkable now in the current model;
*ADAPT* = checkable with a small modelling adaptation noted; *DEFER* = needs data the model
lacks or is out of scope.

Coordinate reminders for the formulas: a symbol's world AABB is `aabb(sym) = {l,r,t,b}`
(`clearance.js:148`; y-DOWN so `t < b`); `w`=width across front, `h`=depth front-to-back;
`rot` = degrees CW; walls come from `wallSegments()` as `{a,b}` pairs. All lengths metres.
`~in` values are the design-research source; the metric figure is authoritative.

### A. Seating group & conversation

| # | Rule | GEO/SOFT | Formula (y-down metric box model) | Data needed | Lives in | Disp |
|---|---|---|---|---|---|---|
| A1 | Facing seats for conversation ≤ 2.4 m (8 ft); >3.05 m (10 ft) stops conversation | `[GEO]` | For a seating pair, center-to-center distance `d = hypot(Δx,Δy)` (or nearest-face gap). Flag `d > 2.4`; hard-warn `d > 3.05`. | seating role; which pieces form a group (see A5) | Both | IN |
| A2 | Intra-group spacing 0.46–0.61 m (18–24 in); >0.76 m "feels disconnected" | `[GEO]` | Nearest-face AABB gap between two same-group seats (the `dx`/`dy` separation `computeClearances` already yields, `clearance.js:434`). Target band `[0.46, 0.76]`. | seating role + grouping | Both | IN (⚠ conflicts with walkway gate — see Interaction) |
| A3 | Coffee table 0.36–0.46 m (14–18 in) from sofa front | `[GEO]` | Gap from sofa **front face** to coffee-table near face along the sofa's front normal. Front face needs a front-vector (see A-note). | seating role, coffee-table role, front-vector | Both | ADAPT (front-vector) |
| A4 | Coffee-table length ≈ 2/3 sofa length | `[GEO]` | `ct.w / sofa.w ∈ [0.5, 0.75]` using the width axis of each (post-rotation, project onto sofa's front-parallel axis). | sofa & coffee-table role + widths | MCP | IN |
| A5 | Seats form *a* conversation group (not scattered) | `[SOFT]` | — (clustering is a judgment; a naive "all seats within R" mis-fires for two intentional zones) | seating role | Skill | DEFER as check; Skill guidance |

**A-note (front-vector / facing).** Rules A3, A6, B4, and symmetry need a piece's *front
direction*, which the model does **not** store — only `rot` (an orientation, ambiguous as
to which side is the "front"). Two dispositions: **(ADAPT, recommended for skill)** the
skill establishes the convention that a piece's front faces the focal element and places it
accordingly, so "front" is *intentional* rather than derived; **(DEFER for evaluator)** a
`check_layout` evaluator cannot know the front without either a per-type front-offset
constant (e.g. "sofa front = local +y half-face") added to `CATALOG`/roles, or inferring it
from context (the seat's front is the side facing the focal element). Recommended evaluator
path: a `frontFaceLocal` per seating type (a small role-data addition), deferred until the
evaluator is built. Until then A3 is skill-only prose.

### B. Sofa / seating placement

| # | Rule | GEO/SOFT | Formula | Data needed | Lives in | Disp |
|---|---|---|---|---|---|---|
| B1 | Sofa = 60–75% of its facing wall length | `[GEO]` | Identify the wall segment the sofa backs onto (nearest parallel `wallSegments()` seg, as `openingOnWall` does, `tools.js:73-129`); `sofa.w / segLen ∈ [0.60, 0.75]`. | sofa role, facing wall | MCP | IN (needs facing-wall pick) |
| B2 | Sofa pulled 0.15–0.30 m (6–12 in) off the wall | `[GEO]` | Gap from sofa back face to its backing wall inner face ∈ `[0.15, 0.30]`. Reuse wall-face gap math (`clearance.js` wall rays). | sofa role, backing wall, back-face | Both | ADAPT (back-face = opposite front) |
| B3 | Storage/anchorable pieces sit *against* a wall | `[GEO]` | Back-face-to-wall gap `≈ 0` (≤ ~0.10 m) for `anchorable`/`storage` roles that are NOT pulled off (contrast B2 for sofa). | anchorable role, nearest wall | Both | IN |
| B4 | Primary seating front-vector points at the focal element | `[GEO]` orientation / `[SOFT]` which-element | Given a designated focal center `F` and seat center `C`, the seat's front-vector `f` should satisfy `angle(f, F−C) ≤ ~25°`. Orientation is GEO; *which* element is focal is SOFT. | focal designation, front-vector | Both | ADAPT (focal + front-vector) |

### C. Focal point, TV, balance, symmetry

| # | Rule | GEO/SOFT | Formula | Data needed | Lives in | Disp |
|---|---|---|---|---|---|---|
| C1 | A focal element exists and seating addresses it | `[SOFT]` (choice) + `[GEO]` (addressing) | Choosing the focal element (fireplace/TV/window/view) is judgment. Once chosen, B4 verifies addressing. | focal designation | Skill (choice), MCP (addressing) | ADAPT |
| C2 | TV viewing distance, resolution-dependent (encode as range) | `[GEO]` | Distance from primary seat front face to TV face `d`. Diagonal from TV width: `diag ≈ hypot(w, w·9/16)` (16:9). 4K: `d ∈ [1.0,1.6]·diag`; 1080p: `d ∈ [1.5,2.5]·diag`. Default to the union `[1.0, 2.5]·diag` since resolution isn't modelled. | tv role, seating role, diagonal-from-width | Both | IN (diagonal estimated from width) |
| C3 | TV center height ~42 in | `[GEO]` but needs z | Height not modelled (2-D plan). | z-axis | — | DEFER (no z) |
| C4 | Symmetry: matched pairs flank a focal axis; seating centered on axis | `[GEO]` (matched geometry) / `[SOFT]` (visual weight) | Focal axis = line through focal center along its facing normal. For a candidate pair (same type, e.g. two `nightstand`/`armchair`), check mirror symmetry: equal perpendicular offsets, equal along-axis positions, within tol. Seating "centered": seat center within tol of the axis. | focal axis, type-pairs | Both | ADAPT (focal axis) |
| C5 | Visual-weight balance (asymmetric balance) | `[SOFT]` | — (requires a visual-mass model; do NOT hard-check) | — | Skill | DEFER |

### D. Bed / bedroom

| # | Rule | GEO/SOFT | Formula | Data needed | Lives in | Disp |
|---|---|---|---|---|---|---|
| D1 | Bedside clearance scales with bed size (Twin/Full 0.61–0.76 m; Queen 0.76–0.91; King 0.91–1.07) | `[GEO]` | Bed size from `bed.w` band (matches `CATALOG.bed.presets`, `symbols.js:183-190`). Gap from each long side of the bed AABB to nearest wall/piece ≥ size-dependent min. | bed role, bed-size band, side identification | Both | IN |
| D2 | Foot-of-bed clearance ≥ 0.91 m (36 in) | `[GEO]` | Gap from bed foot face to nearest obstruction ≥ 0.91. Foot = far short side from headboard (headboard = the side against a wall). | bed role, head/foot orientation | Both | ADAPT (head/foot) |
| D3 | Headboard against a wall | `[GEO]` | One short side of the bed AABB has wall-gap `≈ 0` (reuse B3). | bed role, nearest wall | Both | IN |

### E. Rugs, traffic paths

| # | Rule | GEO/SOFT | Formula | Data needed | Lives in | Disp |
|---|---|---|---|---|---|---|
| E1 | Rug sizing: LR front legs on rug + 12–18 in border; dining rug ≥ 24 in past table; bedroom rug 18–24 in past bed | `[GEO]` if rugs modelled | Would compare a rug AABB to seating/table/bed AABBs. | **rug object (NOT in `CATALOG`)** | — | DEFER (data-model gap) |
| E2 | Traffic path must not cross the conversation zone; maintain 0.76–0.91 m (30–36 in) paths | `[GEO]` (partial) | Path-clearance ≥ band is the existing walkway check (`check_clearance`). "Path must not intersect conversation-zone polygon" needs a designated zone polygon + path polygon — neither modelled. | zone polygons, path routing | Skill (intent) + MCP (walkway only) | PARTIAL: walkway IN via existing check; zone-vs-path DEFER |

### F. Room proportion (deferred by scope)

| # | Rule | GEO/SOFT | Formula | Data needed | Lives in | Disp |
|---|---|---|---|---|---|---|
| F1 | Aspect ≈ 1.6:1 golden-ish; avoid perfect square & >2:1 bowling alley | `[GEO]` | `ratio = max(w,h)/min(w,h)`; ideal ~1.3–1.6, warn `≈1.0` or `>2.0`. | room bbox | Skill | DEFER (scope: room sizing) |
| F2 | IRC habitable-room minimums: ≥ 70 sq ft (6.5 m²), ≥ 7 ft (2.13 m) min dimension | `[GEO]` `[CODE]` | `area ≥ 6.5` and `min(w,h) ≥ 2.13`. | room bbox | Skill | DEFER (scope: room sizing) |

**`[CODE]` vs `[ROT]` (rules of thumb) note.** F2 is building code (IRC R304), a hard
legal floor; F1, and all of A/B/C/D/E, are `[ROT]` design conventions — good defaults, not
laws. The skill must *frame them as such* (guidance, tunable, occasionally overridden by a
user's stated intent) so the agent doesn't treat "sofa is 78% of the wall" as an error the
way it treats a walkway violation. Only `[CODE]` and hard feasibility (fit, containment,
walkway) are ever gate-worthy — and F2 is deferred anyway.

## Data-model gaps (called out per rule)

Four concepts the design rules assume but the model lacks. Each is dispositioned; the
skill-first strategy lets us **defer all four** for v1 because skill prose can *establish*
intent rather than *derive* it from stored data.

1. **Front-vector / facing (rules A3, B2, B4, C1, D2).** A symbol stores `rot` but no
   "which side is the front." *Disposition:* **ADAPT via skill (v1)** — the skill places
   each seat/bed with its front toward the focal element and its back toward a wall, so
   orientation is intentional and doesn't need to be read back. **DEFER the derived form**
   (a `frontFaceLocal` per-type constant on the role map) until a `check_layout` evaluator
   needs to *verify* facing without trusting the placement. Low risk to add later (pure
   additive constant); not needed to start.

2. **Focal-element designation (rules B4, C1, C4).** No field marks a piece (or a wall /
   window) as "the focal point." *Disposition:* **ADAPT via skill (v1)** — the skill picks
   the focal element (a `[SOFT]` choice: fireplace > TV > picture window > view) and
   remembers it within its own reasoning. **DEFER a stored `focalId`** (e.g. a brief field,
   see brief-extension option) to the phase that builds the evaluator, since the evaluator
   needs to know the focal element to compute "seating addresses it." A brief field is the
   cleanest home (it is a *goal*, session-only, never serialized — mirrors `Brief`).

3. **Rug objects (rule E1).** Rugs are **not in `CATALOG`** and have no symbol type.
   *Disposition:* **DEFER (needs a data-model addition).** A rug is unlike other symbols: it
   is a floor layer that furniture sits *on top of* (overlap is desired, not a collision),
   so it can't be a normal clearance subject — it would read as constant overlap "bad." Two
   future paths: (a) a new `rug` `CATALOG` type flagged to be *excluded* from
   `computeClearances` as both subject and neighbour (like openings are, `clearance.js:248`,
   `424`), rendered as a backdrop; or (b) a non-symbol "layers" concept. Either is a real
   feature with editor + render + export implications, well beyond this LLD. For now, rug
   guidance is **omitted** (not even skill prose beyond "rugs are out of scope in v1"),
   because advising a rug the tool can't place is a dead end. File as a separate issue.

4. **Facing-wall / backing-wall attribution (rules B1, B2, B3, D3).** Determining *which*
   wall a piece backs onto is computable (nearest parallel segment within tolerance, as
   `openingOnWall` does, `tools.js:73-129`), but there is no stored association.
   *Disposition:* **IN (computed on demand).** No data-model change — the evaluator (or the
   skill, roughly) recomputes it. This is the one gap that needs no adaptation, only trig;
   it is a strong argument for the `check_layout` evaluator when B1/B2 prove hard by eye.

Also note **height / z-axis (rule C3)** — a plan-view model cannot express TV mount height
or over-back sightlines. **DEFER permanently for v1** (would require a 3-D model). C2 (TV
*distance*) is fully checkable in 2-D and stays.

## MCP surface design (options + recommendation)

Given the architecture decision (skill brain + MCP hands), the surfaces break into
**the skill** (primary, v1) and **MCP-side pieces** (a light prompt pointer now; an
optional evaluator + optional brief field later). Below evaluates each.

### The SKILL (recommended primary surface — phase 1)

A directory `<skill-root>/floorplan-interior-design/SKILL.md` (skill = a directory with a
`SKILL.md`; see `layout-engine`/`dream` examples on this host). **Where the skill lives is
a deployment choice for the human** — the natural home for the autonomous fleet is a
committed skill the ship/propose workflows can load, or a repo-local `.claude/skills/`
(none exist in this repo yet). This LLD specifies its *content*, not its install path.

Concrete shape:

```markdown
---
name: floorplan-interior-design
description: Arrange a spacious, aesthetic single room in the floorplan MCP.
  Use when a user asks to "design"/"lay out"/"furnish"/"arrange" a room (not just
  fit pieces) via the floorplan MCP tools. Assumes the floorplan MCP is connected.
---

# Floorplan Interior Design

## When to use
Designing or arranging a room's *layout quality* (spacious, balanced, a real focal
point) — beyond making pieces merely fit. Requires the floorplan MCP (LLD 32) tools.

## Workflow
1. Establish requirements: call `set_brief` (room dims, required furniture, walkway).
2. Build the room to exact dims: `add_room {rect}` FIRST (before any furniture; LLD 32 M2).
3. Pick the FOCAL element [SOFT]: fireplace > TV > picture window > longest blank wall.
   Remember it; you will orient seating at it.
4. Place anchored pieces against walls: bed headboard, storage, bookshelves (rule B3, D3).
5. Place the sofa on its focal-facing wall: 60–75% of that wall's length (B1), pulled
   0.15–0.30 m off the wall (B2), front toward the focal element (B4).
6. Build ONE conversation group: facing seats ≤ 2.4 m apart (A1), members 0.46–0.76 m
   apart (A2) — NOT pushed to the walkway distance. Coffee table 0.36–0.46 m off the
   sofa front (A3), ~2/3 the sofa's length (A4).
7. Place the TV opposite primary seating at 1.0–2.5× its diagonal (C2).
8. Symmetry where natural: matched pairs (nightstands, armchairs) mirrored on the focal
   axis; seating centered on it (C4). [SOFT] balance — judge, don't force.
9. Verify FEASIBILITY with `check_clearance` / `check_brief`; fix real violations
   (overlaps, boxed-in, containment, walkway on TRAFFIC paths only).
10. Verify LAYOUT QUALITY: reason over `get_plan` using the rules below; if a
    `check_layout` tool is available, call it and treat its report as advisory.

## Rules reference
[the [GEO]/[SOFT] table from this LLD, as prose + formulas]

## Critical: walkway vs closeness
The MCP walkway gate (default 0.915 m) is for TRAFFIC PATHS, not for gaps between seats in
one group. Do NOT spread a conversation group to satisfy the walkway number — keep group
members 0.46–0.76 m apart and route the ≥0.915 m path AROUND the group. (See LLD 72.)
```

Tradeoffs: **+** zero code, edit-to-iterate, graceful degradation, portable to any Claude
agent, natural home for `[SOFT]` rules. **−** the LLM does `[GEO]` arithmetic by eye
(mitigated by explicit formulas + the existing `check_clearance` for the feasibility
subset; escalate specific rules to the evaluator if runs show drift).

### MCP prompt edit (small, LOAD-BEARING, folded into phase 1)

`design_room` (`server.js:232-245`) must change in phase 1 — this is **not** an optional
nicety, because the prompt's own loop clause (`server.js:240-242`, *"poll check_brief and
apply each violation's suggestedMove until satisfied"*) is a direct driver of the
marooned-sofa anti-pattern (Problem statement). If the skill's grouping guidance and the
prompt's "apply every violation until satisfied" clause both reach the agent unchanged, it
has **two contradictory stopping conditions** — the prompt says spread until no violation
remains; the skill says keep the group tight. That contradiction must be removed at the
source, not merely papered over by skill prose. Two parts, both ~zero code:

1. **Neutralize the clause for intra-group gaps.** Reword the loop line to *"…poll
   check_brief and fix real violations (overlaps, containment, boxed-in, and walkways on
   traffic paths); do NOT spread a seating group apart just to clear a sub-walkway gap
   between its own members."* This stops the prompt from *instructing* the anti-pattern.
2. **Point at the skill for quality.** Add one line: *"For layout quality (focal point,
   spacious seating group, TV distance, symmetry), follow the floorplan-interior-design
   skill."* — a pointer, not the knowledge (keeps the dev prompt minimal, avoids duplicating
   prose that will drift).

Both are edits to the prompt string in `buildServer()` (`server.js:240-242`) — no new tool,
no schema change. The skill still owns the design knowledge; the prompt edit only removes
the contradiction and hands off. (Alternative considered — leave the prompt and have the
skill prose explicitly override the clause — rejected: it leaves the contradictory
instruction live for any agent that reads the prompt but under-weights the skill, and the
fix is trivial. Fold it into phase 1.)

### `check_layout` evaluator tool (fully designed; LATER phase, optional)

A new evaluator `check_layout`, registered exactly like `check_clearance`
(`server.js:200-204`), returning a report **modelled on `ClearanceReport`** (LLD 32) so the
agent consumes it with the same mental model: a top-level advisory verdict, per-item
findings, and concrete suggested fixes. **Crucially it is NOT a `satisfied` gate** — it
returns a *score + advisories*, because layout quality is graded, not pass/fail (see
Interaction).

```
check_layout { focal?: {id?:string, wall?:"top"|"bottom"|"left"|"right"},
               groups?: string[][] }   // optional hints; else inferred
  -> LayoutReport (see Interfaces/Types)
```

- `focal` optionally names the focal symbol id or a wall; if omitted the evaluator picks a
  heuristic focal (a `tv`, else the longest blank wall) and echoes its choice so the agent
  can correct it. `groups` optionally declares seating groups; else inferred by proximity.
- It imports the geometry core (`aabb`, `corners`, `wallSegments`, roles) — the same
  boundary `core.js` already governs — and computes A1–A4, B1–B4, C2, C4, D1–D3 as
  `findings` with `status ∈ {good, minor, advise}` (never `bad`), a measured value, the
  target band, and a natural-language suggestion. Reuses `WALL_OPEN_DIR`-style y-down
  care (LLD 59/containment fix) for every sign.

Tradeoffs: **+** deterministic, reproducible, robust trig; reuses the LLD 32 evaluator
pattern the agent already trusts. **−** real code + tests + maintenance; dev-only reach
(no portability win, since the MCP isn't distributed); premature if the skill alone suffices.
**Verdict: design it, don't build it yet.** Trigger to build: observed, repeated failures
of the skill's by-eye `[GEO]` judgment in real runs (empirical, per LLD 32 Q3 discipline).

### Brief extension to *state* layout goals (optional, pairs with the evaluator)

Extend `Brief` (`brief.js:32-35`) with **optional, session-only** goal fields — never
serialized (invariant preserved, LLD 32 State model):

```
Brief += {
  focal?: { id?: string, type?: SymbolType, wall?: "top"|"bottom"|"left"|"right" },
  style?: "conversation" | "tv-focused" | "open",   // [SOFT] hint, prompt/skill only
}
```

Tradeoffs: **+** makes the focal element a first-class, agent-visible goal the evaluator can
score against (closes data-model gap #2 cleanly). **−** only useful *with* the evaluator;
by itself it changes nothing. **Verdict: defer to the evaluator phase**; until then the
skill carries the focal choice in its own reasoning.

### Recommendation summary

| Surface | Phase | Effort | Verdict |
|---|---|---|---|
| **Skill** (`floorplan-interior-design`) | **1** | Prose only | **Build first — captures most value** |
| **`design_room` prompt edit** (neutralize the loop clause + point at skill) | **1** | ~2 lines, no code | **Load-bearing — removes the contradictory stopping condition** |
| `check_layout` evaluator | Later | Code + tests | Design now; build only if by-eye GEO drifts |
| `Brief.focal`/`style` | With evaluator | Small | Defer; pairs with evaluator |

## Interfaces / Types

Types for the *optional later* `check_layout` evaluator. The v1 skill introduces **no
types** (it is prose). Shapes deliberately parallel `feedback.js`'s `ClearanceReport` /
`Gap` (LLD 32) so the agent reuses the same reading discipline.

```ts
// Role map (source of truth if the evaluator is built; else prose in the skill).
// mcp/src/roles.js — MCP-only; the editor UI does not need roles.
type Role = "seating" | "coffee-table" | "dining-table" | "bed"
          | "focal-candidate" | "anchorable" | "storage";
const ROLES: Record<SymbolType, Role[]>;   // see Furniture-role groupings

// One graded design finding. NOTE the status enum is NOT clearance's ok/tight/bad —
// layout quality is graded advice, never a hard fail.
type LayoutFinding = {
  rule: string;              // "A1", "B1", … (traceable to this LLD's table)
  label: string;            // human rule name, e.g. "sofa vs facing-wall length"
  status: "good" | "minor" | "advise";  // good=in band; minor=slightly off; advise=well off
  subjects: string[];       // symbol ids the finding concerns
  measuredM?: number;       // the measured value (metres or ratio); omitted if N/A
  targetBand?: [number, number];        // the recommended band, for context
  suggestion: string;       // NL, actionable — "sofa is 82% of the wall; a 60–75%
                            //   sofa (~1.8–2.3 m on this 3.0 m wall) sits better"
};

// The whole advisory report. NO top-level `satisfied` — that word is reserved for
// check_brief's feasibility gate. A caller wanting a scalar reads `score`.
type LayoutReport = {
  axisConvention: string;   // same "+x=right, +y=down (screen coords); metres" as clearance
  focal: { id?: string; wall?: string; source: "given" | "inferred" }; // echoed choice
  score: number;            // 0..1 fraction of applicable [GEO] rules in-band (advisory)
  findings: LayoutFinding[];
  advisories: string[];     // NL summary lines (the "violations" analogue, but advisory)
};
```

Key contract differences from `ClearanceReport`, stated so they are not conflated:
- **No `satisfied`, no `suggestedMove`.** Layout advice does not resolve to a single
  translation the way a clearance deficit does (moving a sofa to hit the 60–75% band may
  require *resizing* it, not moving it). Suggestions are NL; the agent decides the action.
- **`status` is `good/minor/advise`, never `bad`.** A layout that scores low is still a
  valid, feasible plan — the agent (and user) may accept it. Only `check_clearance` /
  `check_brief` own `bad`/`satisfied`.
- **`focal` is echoed** so the agent can re-call with a corrected `focal` hint — the same
  self-healing pattern as clearance's `boxedInAxes` structural feedback.

No changes to existing tool signatures. If `Brief.focal`/`style` are added, `set_brief`'s
`inputSchema` (`server.js:97-101`) gains matching optional fields; that is the only existing
signature that would change, and only in the evaluator phase.

## Interaction with the existing evaluators

Three evaluators must have a clear division of authority, or they will emit contradictory
guidance (the exact failure mode the problem statement identifies).

**1. Feasibility is the gate; layout is advice.** `check_brief` stays the sole
`satisfied` oracle and keeps owning: room dims, furniture counts, containment, overlaps,
and walkway on **traffic paths**. `check_layout` (if built) is **advisory only** — it never
sets `satisfied` and its findings never enter `check_brief.unmet`. This keeps the loop
terminating on a *feasible* plan while layout guidance shapes quality without livelocking.
A user can knowingly ship a feasible plan that scores 0.6 on layout; they can never ship
one where a sofa overlaps a wall.

**2. Resolve the walkway-vs-closeness conflict (the central hazard).** As the problem
statement shows, `check_brief` today flags *every* sub-0.915 m gap as a violation — including
the desired 0.46–0.76 m gaps *inside* a seating group — which pushes the agent to spread the
group until it "feels disconnected" (rule A2). The resolution has two parts and is **the most
important behavioural change this LLD recommends**, regardless of which surface ships:

- **Skill-level + prompt edit (v1, ~no code):** the skill instructs the agent that the
  walkway threshold governs **traffic paths between zones**, not gaps **within** a seating
  group, and to route the ≥0.915 m path *around* the group. The skill treats an intra-group
  `check_clearance` "tight" between two seats as *expected*, not a defect to fix. Critically,
  the **phase-1 `design_room` prompt edit** removes the contradiction at its source: the
  prompt's *"apply each violation's suggestedMove until satisfied"* clause is reworded so the
  agent is no longer *instructed* to spread grouped seating (see *MCP prompt edit*). Without
  that edit the agent gets two opposing stopping conditions (prompt: keep applying every
  move; skill: keep the group tight) — which is why the prompt edit is folded into phase 1,
  not deferred. This resolution works because `check_brief`'s `satisfied` is not the agent's
  only stopping condition — the skill's own layout reasoning is. **Caveat:** with today's
  code, `check_brief` will still *report* those intra-group gaps in `unmet`, so it may never
  read `satisfied:true` for a well-grouped layout. The skill (and the edited prompt) must
  frame this as acceptable and not chase those specific entries.
- **Code-level (a real fix, worth filing even under skill-first):** `check_clearance` should
  distinguish **traffic clearance** (piece-to-wall, piece-to-piece *across* a walkway) from
  **intra-group closeness** (two members of one seating group). The cleanest form: only apply
  the walkway threshold to pairs **not** in the same declared/inferred group; report
  in-group gaps under a separate non-gating "grouping" status. This is a `feedback.js`
  change (group-awareness in `buildClearanceReport`) and depends on the role/group concept —
  so it belongs to the **evaluator phase**, but it is the change that makes `check_brief`
  stop fighting good grouping. Until then, the skill-level caveat above is the mitigation.

**3. Avoid conflicting `suggestedMove`s.** `check_clearance` emits a concrete
`suggestedMove` (a resolved translation, `feedback.js:332`). `check_layout` deliberately
emits **no** `suggestedMove` (only NL suggestions) — so the two can never return opposing
coordinates for the same piece. When both have something to say about one piece, the
**precedence is explicit and encoded in the skill workflow:** feasibility first
(apply `check_clearance`'s move to kill an overlap / boxed-in / containment problem), then
layout advice second (adjust toward a band only if it doesn't reintroduce a feasibility
violation — re-run `check_clearance` after). This ordering prevents the classic oscillation
(layout says "pull sofa off the wall +0.2 m," clearance says "you're now 0.1 m from the
coffee table"): the feasibility check is authoritative and always re-run last.

**4. Shared threshold hygiene.** `check_layout` must **not** call `setThreshold`
(`clearance.js:78`) — that is clearance's session state (M1, LLD 32). Layout bands are its
own constants. If it needs a clearance number it reads the report, not the mutable core
threshold, so it can't desync the walkway objective.

## State Model

- **The skill is stateless prose.** It holds no state; it reasons over what the MCP tools
  return each call. All plan state stays in the core singletons exactly as LLD 32 defines
  (the mutators the skill drives are unchanged).
- **`check_layout` (if built) is a pure read.** Like `get_metrics`/`check_clearance`, it
  reads `world()` (`tools.js:131`) and computes; it persists nothing and — per interaction
  rule #4 — does not touch `clearance.js`'s `threshold`. It is a synchronous, no-`await`
  handler, honouring LLD 32's "no mutator awaits" concurrency invariant (it isn't a mutator,
  but staying synchronous keeps it trivially safe).
- **`Brief.focal`/`style` (if added) are session-only**, exactly like the rest of `Brief`
  (`brief.js`): held in `_brief`, cleared by `clearBrief()`, and **never** written into the
  Plan JSON. The regression invariant "no brief field leaks into serialized plan"
  (LLD 32 State model / handoff test) must be extended to cover the new fields.
- **Roles are a constant, not state** — a static `type → role[]` map, no persistence.

## Edge cases & failure modes

Each notes how the **skill** handles it (v1) and, where relevant, the **evaluator**.

1. **No clear focal element** (no TV, no fireplace, blank walls only). *Skill:* fall back to
   the longest uninterrupted wall or a window as focal, and say so. *Evaluator:* `focal.source
   = "inferred"`, echo the pick; if truly none, skip B4/C-rules and note it in `advisories`.
2. **Minimal furniture** (e.g. just a bed, or one sofa). *Skill:* group/conversation rules
   (A1–A5) are N/A with < 2 seats; apply only the placement rules that have subjects.
   *Evaluator:* a rule with no applicable subjects is **omitted** from `findings` (not scored
   as a failure) so `score` isn't diluted by inapplicable rules — score = in-band ÷
   *applicable*.
3. **Non-rectangular room** (L-shape, triangle — `add_room` accepts any ≥3-vert nonzero
   polygon, `tools.js`). *Skill:* reason per-wall; "facing wall" and "wall to back onto" are
   still individual segments. *Evaluator:* B1's `segLen` uses the actual `wallSegments()`
   segment; "which wall" picks by nearest-parallel as `openingOnWall` does. The room centroid
   may fall **outside** a concave room (the exact hazard `interiorPointNear` handles,
   `feedback.js:89`) — any focal-axis or centering math must reuse that guaranteed-interior
   helper, not a naive centroid.
4. **Conflicting rules — clearance vs sofa-off-wall (B2).** Pulling the sofa 0.15–0.30 m off
   the wall reduces the walkway *behind* it and the gap *in front*. *Resolution:* feasibility
   wins (interaction rule #3) — the skill applies B2 only if `check_clearance` stays clean; a
   tiny room may not afford the pull, and that's acceptable (B2 is `[ROT]`, not a gate).
5. **Rotated furniture.** All formulas use `aabb()`/`corners()` which already handle `rot`
   (`symbols.js:922`), but the AABB **over-estimates** a rotated footprint (`clearance.js`
   header) — so any gap/length the evaluator computes is *conservative*, and the report must
   note it (mirroring `feedback.js:445` rotated-subject note). Facing/front-vector rules on a
   rotated seat need the true front direction, not the AABB — hence the front-vector
   adaptation; until then the skill relies on intentional placement.
6. **y-down sign traps.** Every direction-bearing formula (off-wall pull direction, focal
   axis, "front toward focal," foot-of-bed) must be derived in the y-down screen frame where
   "up/toward top" = **decreasing y** and rotation is CW — the precise class of bug LLD 59
   fixed (FP sign-flip at gap=0) and the containment fix re-derived (`WALL_OPEN_DIR`,
   `feedback.js:45-50`). The evaluator must reuse the interior-normal approach, not raw
   leader-endpoint signs, for anything wall-relative. This is called out as the #1 correctness
   risk for the evaluator phase.
7. **Ambiguous role** (a `table` that could be coffee or dining; a `chair` accent vs dining).
   *Skill:* disambiguate by context (proximity to sofa vs dining table, size). *Evaluator:*
   needs an explicit heuristic (deferred, see roles section) — until then treat ambiguous
   pieces conservatively (skip the rule rather than mis-apply it).
8. **Agent over-trusts advisory as a gate.** Risk that the agent loops forever trying to hit
   a `[ROT]` band. *Mitigation:* `LayoutReport` has no `satisfied`; the skill states plainly
   that layout findings are guidance and the stopping condition is `check_brief.satisfied` +
   a *reasonable* layout, not a perfect score.
9. **Skill fires without the MCP connected.** *Mitigation:* the skill's `when-to-use` names
   the floorplan MCP as a prerequisite; with no tools it should say it needs the MCP rather
   than hallucinating geometry.
10. **`[SOFT]` rule leaks into a hard check.** Guard: the table marks each rule; only `[GEO]`
    rules may ever become evaluator `findings`, and even those are advisory. `[SOFT]` rules
    (A5, C1-choice, C5) appear **only** as skill prose. A reviewer should reject any evaluator
    that scores a `[SOFT]` rule.

## Testing strategy

Follows the repo split: pure Node geometry tests under `mcp/test/` (`node --test`, wired
into `commands.test`, `project.json:20`); browser DOM tests in `test/tests.html`. The v1
skill is prose, so it has **no automated unit tests** — it is validated by observed agent
runs (as LLD 32 validates tool ergonomics empirically). Testing below is mostly for the
*later* evaluator phase, with a v1 skill-validation plan.

### Skill (phase 1) — validation, not unit tests
- **Scenario walkthroughs (manual/observational).** Run the skill against 2–3 fixed briefs
  (studio: bed+sofa+desk; living room: sofa+TV+coffee-table+2 armchairs; bedroom:
  bed+2 nightstands+dresser) and inspect the produced plan: focal chosen, seating grouped
  (not spread to walkway distance), sofa on a wall and pulled off it, TV roughly at distance,
  nightstands mirrored. This is the acceptance bar; record findings to tune the prose.
- **Regression against the anti-pattern:** confirm the skill does **not** spread a
  conversation group to satisfy the walkway number (the problem-statement failure). A
  well-grouped result with an intra-group `check_clearance` "tight" that the skill leaves
  alone is a *pass*, not a fail.

### `check_layout` evaluator (later phase) — unit tests (`mcp/test/`)
Each `[GEO]` rule gets a pure-geometry unit test built against the **real core** (the
`feedback.test.js` pattern, `mcp/test/feedback.test.js:1-20` — construct a plan via the real
tools, run the evaluator, assert on findings), Node-clean, no DOM:
- **A1/A2 spacing:** two seats at a known separation → correct `measuredM`, `status`
  `good`/`minor`/`advise` against the band; an in-group 0.5 m gap is `good` (NOT flagged as a
  walkway deficit — the cross-check with `check_clearance` proves they disagree by design).
- **B1 sofa/wall ratio:** sofa of known `w` on a wall of known `segLen` → correct ratio and
  band verdict; test on a **non-rectangular** room wall and a **rotated** sofa (conservative
  AABB note present).
- **B2 off-wall pull:** sofa back face 0.2 m off its wall → `good`; flush (0 m) → `advise`
  "pull it off the wall"; sign correct in y-down for all four walls (the LLD 59 trap) —
  parametrize over top/bottom/left/right.
- **C2 TV distance:** seat↔TV distance vs diagonal-from-width bands, at 4K/1080p union.
- **C4 symmetry:** two nightstands mirrored about a focal axis → `good`; offset one → `advise`.
- **D1–D3 bed:** bedside gap scales with bed-size band; foot clearance; headboard-against-wall
  sign in y-down.
- **Advisory-not-gate invariants:** `LayoutReport` never contains `satisfied`; no finding has
  `status:"bad"`; `check_layout` does not mutate `clearance.threshold` (assert
  `effectiveThreshold()` unchanged across a call).
- **Roles map:** every `CATALOG` key has a role entry (guard against a new catalog type,
  e.g. after a PR like #98, silently dropping out of the role map — mirrors the catalog-drift
  discipline of LLD 69/70).
- **Import-boundary:** if `roles.js`/evaluator import anything from `src/js`, the
  `import-boundary.test.js` smoke test (`mcp/test/`) must stay green (no DOM leak).

### Integration
- **No conflicting moves:** a scripted run where `check_clearance` and `check_layout` both
  concern one sofa asserts the agent-order (feasibility move applied; layout suggestion is NL
  only; a final `check_clearance` is clean) — the anti-oscillation contract (interaction #3).

## Phasing

**Phase 1 — the skill + the `design_room` prompt edit (highest value, lowest cost/risk).
RECOMMENDED FIRST.** Two deliverables, both essentially zero-code:
1. Author `floorplan-interior-design/SKILL.md`: the workflow, the `[GEO]`/`[SOFT]` rules as
   prose + formulas, the furniture-role table, and — most importantly — the **walkway-vs-
   closeness guidance** (interaction #2, skill-level) that stops the marooned-sofa
   anti-pattern.
2. **Edit the `design_room` prompt** (`server.js:240-242`) to neutralize its
   "apply each violation's suggestedMove until satisfied" clause for intra-group gaps and
   point at the skill (see *MCP prompt edit* above). This is **load-bearing, not optional**:
   without it the prompt keeps *instructing* the anti-pattern the skill is trying to
   prevent, giving the agent two contradictory stopping conditions. ~2 lines of prompt
   string, no new tool/schema.

**Zero code beyond a two-line prompt-string edit.** Leverages every existing MCP tool +
`check_clearance` + `check_brief`. Validated by scenario walkthroughs. This alone should
move layouts from "passes but sterile" to "has a focal point, a real seating group, and
pieces on walls."

**Phase 2 — role constant + the code-level walkway/closeness split.** Add `mcp/src/roles.js`
(the single source of truth for roles/groups) and make `check_clearance`/`feedback.js`
group-aware so `check_brief` stops flagging intra-group closeness as a walkway violation
(interaction #2, code-level). This is the smallest *code* change with real behavioural
payoff and unblocks the evaluator. Trigger: after phase 1 runs confirm the skill wants it.

**Phase 3 — the `check_layout` evaluator (optional).** Build it only if phase-1 runs show the
LLM's by-eye `[GEO]` arithmetic drifting (B1 wall-ratio, C2 TV distance, C4 symmetry are the
likeliest to need it). Implement the `[GEO]` rules dispositioned IN/ADAPT, add the front-vector
/ focal role-data adaptations then (not before), and pair with `Brief.focal`/`style`. Full
test suite per the testing section.

**Deferred beyond these phases (filed as issues, per the "follow-ups become issues"
convention):** rug objects (data-model addition), z-axis rules (TV height C3), room
sizing/proportion (F1/F2, scope decision), multi-room layout quality, and the
ambiguous-role disambiguation heuristic.

## Phasing rationale (why skill-first is the right sequence)

The skill delivers the *conceptual* wins (focal point, grouping, off-wall placement,
TV-opposite-seating) that account for most of the perceived jump in quality, at prose cost
and with graceful degradation. The precise-trig wins (exact 60–75% wall ratio, exact TV
distance band) are a smaller marginal gain and carry the real cost (code, tests, the y-down
sign-trap risk). Front-loading the cheap conceptual wins and gating the expensive precise
wins on evidence mirrors LLD 32's own empirical discipline (Q1 tool granularity, Q3 preview)
and this project's "deploy cheap / simplicity first" principles.

## Dependencies

**Phase 1 (skill) depends on — all present:**
- The existing MCP tool surface (LLD 32): `set_brief`, `add_room`, `place_symbol`,
  `move_symbol`, `resize_symbol`, `rotate_symbol`, `get_plan`, `check_clearance`,
  `check_brief` (`mcp/src/server.js`, `tools.js`). The skill only *drives* these; no change.
- The catalog with per-axis bounds + presets (PR #98, `src/js/symbols.js:58-231`) — the skill
  cites real sizes (bed presets, TV stand widths) from it.
- The design-research rules in this LLD (the `[GEO]`/`[SOFT]` table) as the skill's content.
- A skill-hosting location the consuming Claude agent loads (deployment choice; none exists in
  this repo's `.claude/` yet — a `.claude/skills/` dir or the automation fleet's skill set).

**Phase 2/3 (roles + evaluator) additionally depend on:**
- New MCP-only `mcp/src/roles.js` (the `ROLES` map) — no `src/` change.
- Reuse of shared pure geometry via `core.js` (`aabb`, `corners`, `wallSegments`,
  `pointInRoom`, `WALL_M`, `PARALLEL_TOL_DEG` — all already re-exported, `mcp/src/core.js`).
  The nearest-parallel-wall math mirrors `openingOnWall` (`tools.js:73-129`, itself mirroring
  `nearestWallFlush`, `symbols.js:475`). **No new `src/js` export is strictly required**; if
  one is added it must keep the import-boundary smoke test green and stay Node-clean.
- `feedback.js` group-awareness for the walkway/closeness split (phase 2).
- Optional `Brief.focal`/`style` fields (`brief.js`) + matching `set_brief` schema
  (`server.js:97`) for phase 3.

**Relationship to prior LLDs:** builds on LLD 32 (the MCP + evaluator pattern), LLD 24
(clearance model this reuses and must not fight), LLD 59 + the 2026-07-10 containment fix
(the y-down sign discipline every new formula must follow), LLD 71 (the reject-at-mutator
hardening pattern, and the opening-on-wall math the facing-wall pick reuses). No overlap with
the Supabase/accounts phase (orthogonal, LLD 32 Dependencies).

## Escalation

- **No CX doc exists for the agent-facing surface** (LLD 32 noted the same), so there is no
  user-flow conflict to flag against a CX spec. If a "design my room" user experience is
  later specified in a CX doc, re-check that the skill's workflow matches it.
- **Product call for the CEO (not a design call):** *how good is good enough, and is layout
  quality worth code?* This LLD recommends skill-first precisely to defer that spend. If the
  owner wants deterministic, reproducible layout scoring sooner (e.g. to gate the autonomous
  fleet's output, or to show a quality score in-product), that reprioritises phase 3 (the
  evaluator + role code) ahead of "author prose and observe" — a scope/timeline tradeoff for
  the CEO. Flagged, not decided here.
- **Rug objects and room-sizing are latent product decisions**, not just deferrals: each is a
  new capability (a floor-layer concept; a room-proposal mode). File as proposal issues for
  CEO prioritisation rather than smuggling into this layout work.
