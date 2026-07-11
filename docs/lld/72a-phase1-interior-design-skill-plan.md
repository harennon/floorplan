# LLD 72a: Phase 1 implementation plan — the `floorplan-interior-design` skill (multi-room-type)

> **Status: IMPLEMENTATION PLAN.** This is the concrete, mechanical plan the implementer
> follows to ship **Phase 1 of LLD 72** (GitHub issue #104). It is *not* the skill itself
> and *not* production code — it specifies exactly which files to create, their per-file
> content outline, the one code edit (`design_room` prompt), the testing/validation plan,
> and the follow-up issues to file. LLD 72
> (`docs/lld/72-mcp-design-quality-guidance.md`, merged in PR #103) is the parent spec; this
> plan **modularises and expands** its Phase-1 skill deliverable. Where this plan and LLD 72
> disagree on *structure*, this plan's Scope-reconciliation section states the supersession
> explicitly.

## Scope

**What this plan covers.** The two Phase-1 deliverables of LLD 72, with the user's
expansion baked in:

1. **Author the `floorplan-interior-design` skill** as a directory under
   `.claude/skills/` — a `SKILL.md` (common core: workflow, role map, walkway-vs-closeness
   guidance, room-type router) plus **four `references/*.md` sub-files**, one per supported
   design context: **living room, kitchen, bedroom, gaming room**. Each room type carries
   its own aesthetic and its own `[GEO]`/`[SOFT]` rules; they share the SKILL.md core.
2. **Edit the `design_room` prompt** (`mcp/src/server.js` ~L232-245) to neutralise the
   "apply each violation's suggestedMove until satisfied" clause and point at the skill.
   This is ~one string change and is the **only** code touched in Phase 1.

**What this plan explicitly does NOT cover** (kept out so the implementer does not drift —
see the closing *Explicitly NOT in scope* section for the full list with rationale):
- Any `check_layout` evaluator (LLD 72 Phase 3), any `mcp/src/roles.js` code constant or
  group-aware `feedback.js` (LLD 72 Phase 2), any data-model change (front-vector, focal
  designation, rug, monitor, counter/island, lighting, z-axis), and any room
  sizing/proportion logic. The skill is prose; the role map lives *only* as a markdown
  table inside SKILL.md in Phase 1.
- The skill does not attempt bathroom, dining-room-as-its-own-context, or multi-room
  layout. Bathroom pieces exist in the catalog but are out of the four requested contexts.

The deliverable is additive: **new markdown files + one prompt-string edit.** No `src/js/*`
change, no new MCP tool, no schema change.

## Scope reconciliation with LLD 72 (own it)

LLD 72's Phase-1 deliverable is a **single, flat `SKILL.md`** whose worked examples are
**living-room- and bedroom-centric** (its Workflow steps 3–8 are a living-room script;
its per-rule table covers A/B/C = living, D = bedroom). This plan changes two things and
must own both decisions:

**(a) The modular structure supersedes LLD 72's flat-`SKILL.md` recommendation — stated.**
The user requires four *distinct* design contexts (living / kitchen / bedroom / gaming),
each with its own aesthetic. Cramming four room-type rule sets into one flat SKILL.md body
would blow the ~1500-2000-word budget skills target for the always-loaded body and force
the agent to read kitchen rules while designing a bedroom. The **progressive-disclosure**
pattern that the skill-creator guide documents for multi-domain skills
(`SKILL.md` = workflow + selection; `references/<variant>.md` = the per-variant detail,
read on demand) is the correct fit. So: **SKILL.md holds the common core + a room-type
router; each room type's rules live in `references/<room>.md`, read only when that room is
being designed.** This is a structural supersession of LLD 72's "flat file," not a
contradiction of any LLD 72 *decision* — the content (rules, formulas, role map,
walkway-vs-closeness guidance) is carried over verbatim; only its packaging changes. LLD 72
itself anticipated this: its skill-shape section says it "specifies its *content*, not its
install path," and the skill-creator guide it references explicitly recommends the
`references/aws.md | gcp.md | azure.md` variant layout for multi-domain skills.

**(b) How to record the kitchen/gaming expansion — recommendation.** LLD 72 scoped
living + bedroom; kitchen and gaming are a genuine *scope expansion* the user added on top
of issue #104. Two ways to record it:

- **Option 1 — amend LLD 72.** *Rejected as infeasible:* PR #103 is **already MERGED**
  (verified: `gh pr view 103` → `MERGED`; the doc is in `main`). LLD 72 is no longer an
  open, amendable PR. Re-opening a merged design doc to fold in a downstream expansion
  would rewrite history on a doc other issues already cite by section.
- **Option 2 — record the expansion in THIS plan as the addendum (recommended).** This
  LLD 72a *is* the amendment vehicle: a sibling `72a-` doc that references LLD 72 as its
  parent and documents the modular structure + the kitchen/gaming addition. This matches
  the repo's existing convention of numbered sibling LLDs that extend a predecessor
  (e.g. LLD 78 supersedes an LLD 32 decision in its own doc rather than editing LLD 32).

  **Recommendation: Option 2.** Rationale: LLD 72 is merged and immutable-by-convention;
  a sibling addendum is the lighter, honest record; and issue #104's own text already
  points implementers at "LLD 72" for the *design* while leaving *this* plan to carry the
  concrete file manifest. **Flag for the human (Neil):** if you would rather the canonical
  design doc reflect four room types directly, the alternative is to open a small follow-up
  PR that adds a one-paragraph "Superseded by LLD 72a (multi-room-type skill structure)"
  note to the top of LLD 72 — a pointer, not a rewrite. This plan does not assume that PR;
  it stands alone if it is never opened.

**One factual correction to the research brief this plan was handed.** The brief said PR
#103 was "open … amendable"; it is in fact **merged**. That is *why* Option 2 (addendum),
not Option 1 (amend), is recommended. Everything else in the brief re-verified against
source.

## Approach

**Progressive disclosure across a common core + four room-type references.** The agent
always sees the SKILL.md `description` (the trigger). When the skill fires, it reads the
SKILL.md body (the common core: workflow, role map, walkway-vs-closeness rule, stopping
condition, and a **room-type router**). The router tells it: *"Identify the room type from
the brief/user ask, then read `references/<that-room>.md` before placing furniture."* Only
the one relevant reference is loaded. This keeps SKILL.md within budget and each room's
aesthetic self-contained.

**What is "common core" vs "per-room."** The split is the load-bearing design choice:

- **Common core (SKILL.md, applies to every room):** the workflow skeleton; the
  feasibility-vs-layout ordering (feasibility move first via `check_clearance`, layout
  adjust second, re-run `check_clearance` last); the **walkway-vs-closeness** rule (the
  anti-marooned-sofa bit); circulation ≥ threshold; anchor-against-wall vs pull-off-wall;
  focal-point-orientation as a *concept*; leave negative space / do not overfill; the
  y-DOWN metric reminder + "cite catalog presets for real sizes"; the MCP-prerequisite
  note; the static `type → role[]` map; and the stopping condition
  (`check_brief.satisfied` + a *reasonable* layout, never a perfect score).
- **Per-room references:** the room-type-specific `[GEO]`/`[SOFT]` rules and the aesthetic.
  Living = conversation-group geometry (A/B/C rules). Kitchen = NKBA work-triangle + aisles
  + landing zones. Bedroom = bed clearances + nightstand symmetry (D rules + C4). Gaming =
  ergonomic viewing distance + battlestation vs console sub-modes ([SOFT]-heavy).

**Voice and framing.** Imperative ("Pick the focal element", "Place the sofa on the
focal-facing wall"), explaining the *why* briefly. Every rule framed as `[ROT]` guidance
(good default, occasionally overridden by user intent), never as a hard gate — only
`check_brief.satisfied` and hard feasibility (fit/containment/walkway-on-traffic) gate.
Each rule tagged `[GEO]` (has a formula) or `[SOFT]` (judgment) exactly as LLD 72 tags them,
so a later `check_layout` evaluator phase can lift the `[GEO]` ones without re-derivation.

**Real dimensions come from the catalog, not from prose constants.** The skill must tell
the agent to read `floorplan://catalog` (per-axis `min_w/max_w/min_h/max_h` + named
presets) for real sizes rather than inventing them — e.g. bed-size band from
`CATALOG.bed.presets`, TV stand widths from `CATALOG.tv.presets`. Bands *for gaps and
ratios* (e.g. "0.46-0.76 m intra-group", "sofa = 60-75% of wall") are stated in the
references as the design-research numbers; **object sizes** defer to the catalog resource.

**Zero code except the prompt string.** Every rule is expressed as prose the agent
interprets over `get_plan` + the existing evaluators. No new tool, no `roles.js`, no schema
change — those are Phases 2/3.

## File manifest

Create the directory `.claude/skills/floorplan-interior-design/` (the whole `.claude/skills/`
tree is **new** — it does not exist in this repo yet; this establishes it). Five new files,
no edits to any existing file except the one prompt string.

| # | File (all under `.claude/skills/floorplan-interior-design/`) | New? | Purpose |
|---|---|---|---|
| 1 | `SKILL.md` | new | Frontmatter (`name` + trigger `description`) + common core: workflow, role map, walkway-vs-closeness, focal/anchor concepts, stopping condition, room-type router. ~1500-2000 words. |
| 2 | `references/living-room.md` | new | Living-room rules A1-A5, B1-B4, C1-C5 (conversation group, sofa placement, focal/TV/symmetry). LLD 72 groups A/B/C. |
| 3 | `references/kitchen.md` | new | NKBA work-triangle, work-aisle widths, landing zones. Prose-heavy (catalog lacks counter/island). |
| 4 | `references/bedroom.md` | new | Bed clearances D1-D3, nightstand symmetry (C4), dresser/wardrobe clearance. LLD 72 group D. |
| 5 | `references/gaming-room.md` | new | Battlestation vs console/couch sub-modes; ergonomic viewing distance; [SOFT]-heavy aesthetics. |

| File (existing) | Edit |
|---|---|
| `mcp/src/server.js` (~L232-245) | Reword the `design_room` prompt string (see *The `design_room` prompt edit*). The only code change in Phase 1. |

**Notes on placement.**
- `.claude/skills/` is a **new in-repo artifact class**, separate from the committed
  `.claude/workflows/*` symlinks (those point into `danbing-automation`). This skill is a
  real directory of files that ships with the floorplan checkout, per issue #104's "Skill
  home (decided)".
- No manifest/registration file is needed — a skill is discovered by its directory +
  `SKILL.md` frontmatter. Do not add any wiring to `project.json` or `settings.json`.

## SKILL.md — content outline

The implementer writes SKILL.md to this outline. Section headings are prescriptive; prose
is the implementer's to phrase (imperative voice). Keep the body ~1500-2000 words
(hard cap <5000). Numbers below are load-bearing — copy them exactly.

### Frontmatter (YAML)

```yaml
---
name: floorplan-interior-design
description: >-
  Arrange a spacious, aesthetic room — with a real focal point, a proper
  seating/work group, and pieces on the right walls — using the floorplan MCP
  tools. Use this whenever a user asks to "design", "lay out", "furnish",
  "arrange", or "decorate" a room (living room, kitchen, bedroom, or gaming
  room) via the floorplan MCP, not just to make furniture fit. Covers focal-point
  choice, conversation groups, work-triangle kitchens, bed clearances, and
  battlestation/console gaming setups. Requires the floorplan MCP (LLD 32) to be
  connected. Do NOT use for pure geometry drawing with no furniture-arrangement intent.
---
```
(The `description` is the sole trigger; make it slightly "pushy" and name the four room
types + the verbs, per skill-creator guidance on under-triggering. ~90 words.)

### Body sections (in order)

1. **`# Floorplan Interior Design`** — one-line what-it-is.

2. **`## When to use / prerequisites`** — designing *layout quality* (spacious, balanced,
   a real focal point), not just fitting pieces. **Prerequisite:** the floorplan MCP is
   connected; if its tools are absent, say so rather than hallucinating geometry
   (Edge case 9, LLD 72). Names the four supported room types.

3. **`## Coordinate & sizing conventions`** (common core) — y-DOWN metres: "up/toward the
   top of the screen" = **decreasing y**; `rot` is degrees **clockwise**; a symbol's
   footprint is `w` (across the front) × `h` (front-to-back). **Read `floorplan://catalog`
   for real object sizes** (per-axis `min_w/max_w/min_h/max_h` + presets); resize within
   those bounds. `place_symbol` clamps dims to the catalog range and returns clearance;
   openings (`door`/`window`) must sit on a wall or the mutator rejects them (LLD 71).

4. **`## Furniture-role map`** (common core) — the static `type → role[]` table (below).
   State plainly: this map lists *every plausible* role for a type; which role applies to a
   given instance is resolved by **context** (size, proximity), not by the map — e.g. a
   `table` is a coffee table when it sits ~0.3-0.5 m off a sofa front, a dining table when
   chairs surround it. When ambiguous, prefer the room type's dominant reading (living →
   coffee; kitchen/dining context → dining).

   | Role | Types (`CATALOG` keys) |
   |---|---|
   | `seating` | `sofa`, `armchair`, `chair`, `patio-chair` |
   | `coffee-table` | `coffee-table`, `table` |
   | `dining-table` | `table`, `dining-table-round`, `patio-table` |
   | `bed` | `bed` |
   | `focal-candidate` | `tv`, plus a window/opening or blank wall designated by intent |
   | `work-center` (kitchen triangle vertex) | `fridge`, `stove`, `sink` |
   | `anchorable` (wants a wall at its back) | `sofa`, `bed`, `tv`, `bookshelf`, `dresser`, `wardrobe`, `desk`, `cabinet`, `washer` |
   | `storage` | `bookshelf`, `wardrobe`, `dresser`, `cabinet`, `nightstand` |

   (This is LLD 72's role table + the research brief's additions: `work-center` for the
   kitchen triangle, `washer` as anchorable, and the `outdoor` types folded in — see
   *The `outdoor` category decision*. `table` deliberately carries both coffee- and
   dining-table roles.)

5. **`## Workflow`** (common core — the room-type-agnostic skeleton). Numbered:
   1. Establish requirements: `set_brief` (room dims, required furniture, walkway).
   2. Build the room to exact dims: `add_room {rect}` FIRST, before any furniture
      (LLD 32 M2). If a room is already mis-sized, use `resize_room` (rectangular,
      non-destructive) rather than rebuilding.
   3. **Identify the room type** (living / kitchen / bedroom / gaming) from the brief +
      user ask, and **read `references/<room>.md` now** before placing furniture. If the
      brief mixes types (e.g. studio = bed + sofa), read the dominant one and borrow the
      other's placement rules for its pieces.
   4. Pick the **FOCAL element** `[SOFT]` (room-type reference refines the priority order).
      Remember it; you will orient the primary group at it.
   5. Place **anchored** pieces against walls first (storage, bed headboard, appliances) —
      role `anchorable`/`storage`, back-face-to-wall gap ≈ 0.
   6. Place the **primary group** per the room-type reference (living: conversation group;
      kitchen: work triangle; bedroom: bed + nightstands; gaming: desk+screen or sofa+TV).
   7. Verify **FEASIBILITY** with `check_clearance` / `check_brief`; fix **real** violations
      only — overlaps, containment, boxed-in, and walkway deficits **on traffic paths**.
   8. Verify **LAYOUT QUALITY** by reasoning over `get_plan` against the room-type rules;
      adjust toward bands only where it does not reintroduce a feasibility violation
      (re-run `check_clearance` after any adjustment — feasibility is authoritative and
      always re-run last).
   9. **Stop** when `check_brief.satisfied` is true (or its only `unmet` entries are the
      expected intra-group closeness gaps — see next section) **and** the layout is
      *reasonable*. Do not chase a perfect score; layout advice is guidance, not a gate.

6. **`## Critical: walkway vs closeness`** (common core — THE load-bearing rule). Verbatim
   intent: the MCP walkway gate (default **0.915 m**, clamp `[0.76, 1.20] m`) governs
   **traffic paths between zones**, NOT gaps between members of one seating group or one
   work zone. Seats in a conversation group belong **0.46-0.76 m** apart; > 0.76 m "feels
   disconnected." **Do NOT spread a group to satisfy the walkway number** — keep members
   close and route the ≥ 0.915 m path *around* the group. Treat an intra-group
   `check_clearance` "tight" as **expected, not a defect**. Caveat (state it): with today's
   code `check_brief` will still *report* those sub-walkway intra-group gaps in `unmet`, so
   it may never read `satisfied:true` for a well-grouped layout — that is acceptable; do not
   chase those specific entries. (This is LLD 72 Interaction #2, skill-level.)

7. **`## Anchor vs pull-off-wall`** (common core) — storage/appliances/bookshelves sit
   *against* a wall (gap ≈ 0). A **sofa** and a **bed** are anchorable but are pulled
   slightly off the wall behind them where space allows (living/bedroom references give the
   exact bands). In a tight room the pull may not fit — that is acceptable (`[ROT]`, not a
   gate).

8. **`## Focal point (concept)`** (common core) — every room has one visual anchor the
   primary group addresses; the room-type reference gives the priority order (living:
   fireplace > TV > picture window > longest blank wall; bedroom: the bed's headboard wall;
   kitchen: the work triangle is its own logic — no single focal; gaming: the screen wall).
   Orient the primary seating's *front* toward it. Front direction is **intentional** (you
   place the piece facing the focal element), not read back from `rot`.

9. **`## Room-type router`** (common core) — a short table mapping the identified room type
   to its reference file, restating "read the reference before placing furniture":

   | Room type | Read | Primary group | Focal |
   |---|---|---|---|
   | Living room | `references/living-room.md` | conversation group | fireplace/TV/window |
   | Kitchen | `references/kitchen.md` | work triangle | (triangle, no single focal) |
   | Bedroom | `references/bedroom.md` | bed + nightstands | headboard wall |
   | Gaming room | `references/gaming-room.md` | battlestation or console | screen wall |

10. **`## Stopping condition & degradation`** (common core) — restate: feasible + reasonable,
    not perfect. If a `[ROT]` band cannot be met in the given room, best-effort and move on.
    `[SOFT]` rules are never failures. (Edge case 8, LLD 72.)

## references/*.md — content outlines

Each reference opens with a one-line **aesthetic statement** (the room's "feel"), then its
rules as prose + formulas, each tagged `[GEO]`/`[SOFT]` and framed as `[ROT]` guidance. Rule
IDs (A1, B2, D1…) are carried from LLD 72's per-rule table so they stay traceable to a
future evaluator. Keep each reference focused; > 300 lines gets a table of contents (none
should approach that).

### `references/living-room.md`

*Aesthetic:* a warm, conversation-first room with one clear focal point and seating pulled
into a real group — not furniture lining the walls.

- **Focal priority `[SOFT]` (C1):** fireplace > TV > picture window/view > longest blank
  wall. Designate one; orient the primary seating's front at it (within ~25°, B4 `[GEO]`
  orientation).
- **Conversation group:**
  - A1 `[GEO]` facing seats ≤ **2.4 m** apart (center-to-center or nearest-face); > **3.05 m**
    stops conversation.
  - A2 `[GEO]` intra-group spacing **0.46-0.76 m** (target band). *Cross-reference the
    walkway-vs-closeness rule: these gaps are expected to be below 0.915 m — do not widen
    them to the walkway number.*
  - A3 `[GEO]` (ADAPT) coffee table **0.36-0.46 m** off the sofa front.
  - A4 `[GEO]` coffee-table width ≈ 2/3 sofa width: `ct.w / sofa.w ∈ [0.5, 0.75]`.
  - A5 `[SOFT]` seats form *one* group, not scattered (judgment).
- **Sofa placement:**
  - B1 `[GEO]` sofa = **60-75%** of its facing wall length (`sofa.w / segLen ∈ [0.60, 0.75]`).
  - B2 `[GEO]` (ADAPT) sofa pulled **0.15-0.30 m** off the wall behind it (space permitting).
  - B3 `[GEO]` storage/anchorable (bookshelf, cabinet) sits *against* a wall (gap ≈ 0).
  - B4 `[GEO]` primary seating front points at the focal element (≤ ~25°).
- **TV / focal geometry:**
  - C2 `[GEO]` TV opposite primary seating at **1.0-2.5× its diagonal**; estimate diagonal
    from width: `diag ≈ hypot(w, w·9/16)` (16:9). Union band since resolution isn't modelled.
  - C4 `[GEO]`/`[SOFT]` symmetry: matched pairs (two armchairs) mirror the focal axis;
    seating centered on it. Judge visual weight; don't force.
- **Types in play:** `sofa`, `armchair`, `chair`, `coffee-table`, `table`, `tv`, `bookshelf`.
- **Real sizes:** cite `CATALOG.sofa.presets` (Loveseat/3-seat/Sectional), `CATALOG.tv.presets`
  (43"-85" stands), `CATALOG.coffee-table` bounds.

### `references/kitchen.md`

*Aesthetic:* an efficient galley/L/U work core built around the **NKBA work triangle** —
appliances placed for a short, unobstructed cook path, not spread for looks.

- **Work triangle `[GEO]` (ROT):** vertices are the three `work-center` pieces — `sink`,
  `fridge`, `stove`. Each leg (center-to-center) **1.22-2.74 m**; the three legs **sum
  3.96-7.92 m**; no obstacle should protrude > **0.30 m** into the triangle. Place the sink
  on the window/plumbing wall if a window exists, fridge near the entry end, stove on a run
  with landing space.
- **Work aisle `[GEO]`/prose:** clear floor between opposing runs (or a run and an island)
  **≥ 1.07 m** for one cook, **≥ 1.22 m** for two. **Note (state explicitly):** 1.22 m is
  *above* the MCP walkway clamp ceiling of 1.20 m, so a `set_brief` `minWalkwayM` cannot
  encode the two-cook aisle — advise it as **prose only**, and use `minWalkwayM: 1.07`
  (in-band) as the checkable floor. Do not tell the agent to set 1.22 (it would be clamped).
- **Landing zones `[SOFT]`/prose:** counter beside each appliance — fridge **≥ 0.38 m** on
  the handle side, stove **0.30-0.38 m** each side, sink **0.46-0.61 m** each side.
  **The catalog has no `counter`/`island` type**, so landing zones are **prose guidance
  only** (the agent reserves the empty floor span; it cannot place a counter). Do not invent
  a counter by mis-using another type.
- **Anchoring:** all appliances are `anchorable` — place them flush against a wall run;
  `washer` (if present) is `anchorable` but is **not** a triangle vertex.
- **Explicitly deferred here:** counter/island landing surfaces, upper cabinets, and any
  **height/clearance-above-counter** rule (not modelled — 2-D plan). See *Catalog gaps*.
- **Types in play:** `fridge`, `stove`, `sink`, `washer`.

### `references/bedroom.md`

*Aesthetic:* a restful room with the bed as the anchor, symmetric nightstands, and clear
walking room on the used sides.

- **Bed placement:**
  - D3 `[GEO]` headboard against a wall (one short side, gap ≈ 0).
  - D1 `[GEO]` bedside clearance **scales with bed size** (read `bed.w` against
    `CATALOG.bed.presets`): Twin/Full **0.61-0.76 m**; Queen **0.76-0.91 m**; King/Cal King
    **0.91-1.07 m** on each used long side.
  - D2 `[GEO]` (ADAPT) foot-of-bed clearance **≥ 0.91 m** to the nearest obstruction (foot =
    the short side opposite the headboard).
- **Nightstands & storage:**
  - C4 `[GEO]`/`[SOFT]` two nightstands mirror the bed's centerline (matched pair, equal
    offsets) — the clearest symmetry win in a bedroom.
  - Dresser/wardrobe are `storage`/`anchorable`: against a wall, with **~0.91 m** drawer/door
    clearance in front to open.
- **Types in play:** `bed`, `nightstand`, `dresser`, `wardrobe`, `cabinet`.
- **Real sizes:** cite `CATALOG.bed.presets` (Twin…Cal King) for the size band that drives D1,
  and `CATALOG.nightstand` / `CATALOG.dresser` / `CATALOG.wardrobe` bounds.

### `references/gaming-room.md`

*Aesthetic:* an immersive, screen-centric room — a focused battlestation or a lean-back
console lounge. `[SOFT]`-heavy by nature; the catalog is thin here, so this reference is
prose-first and `[GEO]`-light.

- **Two sub-modes — pick one from the brief/user ask:**
  - **Battlestation** (desk + chair + screen, close): a `desk` against the **screen wall**
    (the focal wall `[SOFT]`), the seat (`chair`/`armchair`) pulled to the desk. Eye-to-screen
    viewing distance ~**0.5-0.75 m** for a desk monitor. **Catalog gap:** there is no
    `monitor` type and `tv` (min_w 0.90 m) is too large to stand in for a desk monitor —
    approximate the screen by the **desk depth + a shallow strip on the desk**, and treat the
    monitor as implied. **Defer** a `monitor`/`gaming-chair` catalog type (see *Catalog gaps*).
  - **Console / couch** (sofa + TV, lean-back): identical to the living-room TV geometry —
    a `sofa` on a wall, `tv` opposite at **1.0-2.5× diagonal** (C2). Reuse the living-room
    rules for this sub-mode (reference it, don't duplicate the formula).
- **Focal `[SOFT]`:** the screen wall. Orient the seat/desk front at it.
- **Ambience `[SOFT]` / prose only:** bias/ambient lighting behind the screen, cable-managed
  desk, a clear zone around the chair. **No lighting concept exists in the model**, so this is
  narrative guidance only — never a checkable rule. See *Catalog gaps*.
- **Circulation:** still keep the ≥ 0.915 m path to the seat clear (common-core walkway rule).
- **Types in play:** `desk`, `chair`, `armchair`, `sofa`, `tv`, `bookshelf` (for storage).

## The `design_room` prompt edit (exact)

**File:** `mcp/src/server.js`, inside `buildServer()`, the `registerPrompt("design_room", …)`
call. **Current** string (verified at L235-245; a template literal):

```js
  }, ({ dims, furniture, walkwayCm }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Design a ${dims} room with ${furniture}, keeping ${walkwayCm} cm walkways. ` +
          `First call set_brief, then add_room at the exact dims, then place each piece, ` +
          `then poll check_brief and apply each violation's suggestedMove until satisfied.`,
      },
    }],
  }));
```

**Replacement** (surgical — only the `text:` value changes; the arrow-function signature and
the surrounding object are untouched):

```js
  }, ({ dims, furniture, walkwayCm }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Design a ${dims} room with ${furniture}, keeping ${walkwayCm} cm walkways. ` +
          `First call set_brief, then add_room at the exact dims, then place each piece. ` +
          `Then poll check_brief and check_clearance and fix only REAL violations — ` +
          `overlaps, containment, boxed-in pieces, and walkway deficits on traffic paths. ` +
          `Do NOT spread a seating or work group apart just to clear a sub-walkway gap ` +
          `between its own members. ` +
          `For layout quality (focal point, a real conversation/work group, TV distance, ` +
          `symmetry), follow the floorplan-interior-design skill.`,
      },
    }],
  }));
```

**What changed and why (maps to LLD 72's two-part edit):**
1. The old clause *"apply each violation's suggestedMove until satisfied"* — the direct
   driver of the marooned-sofa anti-pattern — is replaced with *"fix only REAL violations
   (overlaps, containment, boxed-in, walkway deficits on traffic paths)"* + an explicit
   *"do NOT spread a group … to clear a sub-walkway gap between its own members."* This
   removes the contradictory stopping condition at its source.
2. A one-line pointer to the skill for layout quality — the knowledge stays in the skill,
   not the prompt (avoids prose drift).

**Constraints for the implementer:**
- This is a **plain string edit** — no new tool, no `argsSchema` change, no new import. The
  three template args (`dims`, `furniture`, `walkwayCm`) are unchanged.
- Keep it JS-syntactically valid (the CI syntax gate + `cd mcp && node --test` must stay
  green). No test asserts on this prompt's exact text today, but run the suite to confirm no
  regression. If a test *does* pin the old substring, update that expectation in the same PR.
- Match existing style (string concatenation with trailing spaces per line, as the original).

## The `outdoor` category decision

**Context (verified):** the `outdoor` category and its four types — `patio-table`,
`patio-chair`, `parasol`, `planter` — are in `origin/main` (PR #88, LLD 76). They are **not
yet in this branch's checkout** (this branch predates that merge), but the skill will be
merged into a `main` that has them, so the skill must account for them.

**Recommendation: fold outdoor into the existing role map (no new reference file).** Do NOT
create `references/patio.md` in Phase 1 and do NOT defer them into invisibility. Rationale:

- The user asked for **four** design contexts (living/kitchen/bedroom/gaming). A patio is a
  fifth context the user did not request — adding a whole reference file for it is scope
  creep beyond issue #104.
- But the outdoor *types* will exist in the catalog, and the "every catalog type has a role"
  hygiene discipline (LLD 69/70 catalog-drift lesson) means the role map should not silently
  drop them. So map them into the **existing** roles: `patio-chair → seating`,
  `patio-table → dining-table`, and leave `parasol`/`planter` **unroled** (they are a
  shade canopy and a decorative object — neither seating, storage, nor a focal the primary
  group addresses; treat them as free-standing accents).
- The living-room reference's conversation-group and the dining reading of `patio-table`
  transfer directly if an agent ever arranges a patio, without a dedicated file. If patios
  become a first-class requested context later, add `references/patio.md` then (a clean
  additive follow-up), and consider a `parasol`-as-overhead-focal `[SOFT]` note.

**Concrete action for the implementer:** include `patio-chair` under `seating` and
`patio-table` under `dining-table` in the SKILL.md role table (already reflected in the
role-map outline above). Add a one-line note in SKILL.md: *"`parasol` and `planter` are
free-standing accents with no group role; place them without disrupting circulation."* No
new reference file.

## Catalog gaps → follow-up issues

Per the repo's "follow-ups become issues" convention (MEMORY.md), deferred data-model gaps
are **filed as GitHub issues, not left buried in this doc.** None of these block Phase 1 —
the skill handles each with prose (reserve floor space, approximate, or omit). File these as
separate, un-triaged `feature-request` issues (one each, or grouped as noted):

| # | Gap | Blocks which rule | Phase-1 workaround (in the skill) | File as |
|---|---|---|---|---|
| 1 | **No `counter` / `island` type** | kitchen landing zones | prose only — reserve empty floor span beside appliances | issue: "Catalog: kitchen counter + island types" |
| 2 | **No `monitor` type** (and `tv` min_w 0.90 m too big for a desk) | gaming battlestation viewing distance | approximate monitor via desk depth; treat as implied | issue: "Catalog: desk monitor + gaming-chair types" (group 2+3) |
| 3 | **No `gaming-chair` type** | gaming ergonomics | use `chair`/`armchair` | (grouped with #2) |
| 4 | **No lighting concept** | gaming ambient/bias lighting | narrative prose only, never checkable | issue: "Model: lighting / ambience layer (research)" |
| 5 | **No `fireplace` type** | living focal (fireplace is top focal priority) | designate a wall/window/TV as focal instead | issue: "Catalog: fireplace type (focal element)" |
| 6 | **No `rug` type** | LLD 72 rule E1 (rug sizing) | omit rug guidance entirely (LLD 72 already defers) | issue already anticipated by LLD 72 §Data-model gaps #3 — file if not present |
| 7 | **No z-axis / height** | TV mount height (C3), over-back sightline, upper cabinets | omit — 2-D plan only | LLD 72 defers permanently; no new issue needed |

**Guidance:** the implementer should `gh issue create` for #1, #2 (grouped with #3), #4, #5,
and #6 (if not already filed), each linking back to this plan and LLD 72. Keep them
un-triaged (`feature-request`, no `triage:fix`) so they enter the normal proposal/triage
flow rather than auto-shipping. #7 needs no issue (permanently deferred by the 2-D model).

## State Model

Phase 1 introduces **no new state, no persistence, and no data-model change.**

- **The skill is stateless prose.** It holds nothing between calls; it reasons over what the
  MCP tools return each turn. All plan state stays in the core singletons exactly as LLD 32
  defines. The skill only *drives* existing mutators; it changes none of them.
- **The focal element is carried in the agent's own reasoning**, not stored. There is no
  `focalId` field (that is deferred to the Phase-3 evaluator, LLD 72 data-model gap #2).
- **The `design_room` prompt edit changes no state** — it only reshapes the seed instruction
  text. `Brief` gains no fields (no `focal`/`style` — those are Phase 3).
- **The role map is a constant, not state** — a static markdown table in SKILL.md, no
  persistence, no code.
- **Invariant preserved:** nothing here writes to the serialized plan JSON; the "no brief
  field leaks into serialized plan" invariant (LLD 32 State model) is untouched because no
  brief field is added.

## Edge cases

How the **skill prose** must handle each (Phase 1 is prose, so "handling" = an instruction
the skill gives the agent). Carried from LLD 72's edge-case list, plus the multi-room-type
ones this expansion introduces.

1. **No clear focal element** (no TV/fireplace, blank walls only). Skill: fall back to the
   longest uninterrupted wall or a window, and say which was chosen.
2. **Minimal furniture** (just a bed, or one sofa). Skill: group/conversation rules (A1-A5)
   are N/A with < 2 seats; apply only the placement rules that have subjects. Do not
   fabricate a group.
3. **Non-rectangular room** (L-shape). Skill: reason per-wall; "facing wall" / "wall to back
   onto" are individual segments. Note that a naive centroid may fall outside a concave room.
4. **Sofa-off-wall vs clearance conflict (B2).** Feasibility wins: apply the off-wall pull
   only if `check_clearance` stays clean; a tiny room may not afford it, and that's fine
   (`[ROT]`, not a gate).
5. **Rotated furniture.** Formulas use AABBs which over-estimate a rotated footprint, so gaps
   read conservative. Facing/front rules rely on **intentional** placement (front toward
   focal), not reading `rot` back.
6. **y-down sign traps.** Any direction-bearing reasoning (off-wall pull, foot-of-bed,
   focal orientation) uses the y-down frame: "toward the top" = decreasing y, rotation CW.
7. **Ambiguous role** (`table` = coffee vs dining; `chair` = accent vs dining). Skill:
   disambiguate by room type + proximity (table near a sofa front → coffee; table with
   chairs around it → dining); when unsure, prefer the room's dominant reading.
8. **Agent over-trusts advisory as a gate** (loops chasing a `[ROT]` band). Mitigation: the
   stopping-condition section states plainly that layout is guidance; stop at feasible +
   reasonable.
9. **Skill fires without the MCP connected.** Mitigation: the `when-to-use` / prerequisites
   section names the MCP as required; with no tools, say so rather than hallucinate geometry.
10. **`[SOFT]` leaks into a hard check.** Only `check_brief.satisfied` + hard feasibility
    gate. `[SOFT]` rules (focal choice, symmetry visual-weight, gaming ambience) are advice
    only.
11. **(New) Kitchen two-cook aisle vs walkway clamp.** The 1.22 m two-cook aisle exceeds the
    1.20 m `minWalkwayM` clamp — skill must advise it as prose and use ≤ 1.07 m for the
    checkable `set_brief` floor, never instruct `minWalkwayM: 1.22` (silently clamped).
12. **(New) Mixed-type brief** (studio: bed + sofa + desk). Skill: read the dominant room
    type's reference, borrow the other's placement rules for its pieces (e.g. bedroom D-rules
    for the bed + living B-rules for the sofa in one room).
13. **(New) Gaming battlestation with no monitor type.** Skill: approximate the screen via
    desk depth; do not mis-place a `tv` (too wide) as a desk monitor unless the room is a
    console/couch setup where a wall-scale TV is correct.

## Dependencies

**All present in `main`; nothing blocks Phase 1.**

- **LLD 72** (`docs/lld/72-mcp-design-quality-guidance.md`) — the parent design; merged
  (PR #103). Source of the rules, role table, and the walkway-vs-closeness resolution.
- **The existing MCP tool surface** (LLD 32): `set_brief`, `new_plan`, `add_room`,
  `resize_room`, `place_symbol`, `move_symbol`, `resize_symbol`, `rotate_symbol`,
  `remove_symbol`, `duplicate_symbol`, `get_plan`, `get_metrics`, `check_clearance`,
  `check_brief`, and the resources `floorplan://catalog` / `plan/current` / `brief/current`
  (`mcp/src/server.js`, `tools.js`). The skill only *drives* these — no change.
- **The catalog with per-axis bounds + presets** (PR #98, `src/js/symbols.js:58-231`) — the
  skill cites real sizes (bed presets, TV stand widths, appliance widths) from it via the
  `floorplan://catalog` resource.
- **The outdoor category** (PR #88, in `main`) — the role map folds its four types in; the
  implementer should confirm they are present in the checkout the skill merges into (they
  are in `origin/main`; this feature branch predates the merge but will rebase onto it).
- **The walkway constants** (`mcp/src/brief.js:23-25`): `MCP_WALKWAY_MIN=0.76`,
  `MCP_WALKWAY_MAX=1.20`, `MCP_WALKWAY_DEFAULT=0.915` — the numbers the walkway-vs-closeness
  and kitchen-aisle prose must match exactly.
- **A skill-hosting location the consuming agent loads:** decided as in-repo
  `.claude/skills/` (issue #104). The autonomous fleet / a human running Claude against the
  checkout is the consumer.

**No dependency on Phase 2/3 artifacts** (`roles.js`, `check_layout`, `Brief.focal`) — those
do not exist and are not created here.

## Test requirements / validation plan

Per LLD 72's testing strategy: the Phase-1 skill is **prose, so it has no automated unit
tests.** It is validated two ways.

### 1. Automated gate on the one code change (the prompt edit)

- **`cd mcp && node --test` stays green** after the `design_room` prompt edit (run the full
  MCP suite; the edit must not break any test).
- **The JS syntax gate passes** (`.github/run-tests.mjs` per `project.json:20`, then the
  `mcp` node tests). No test currently pins the prompt substring; if one does, update it in
  the same PR.
- **No `src/js/*` or DOM test is affected** — Phase 1 adds only markdown + one MCP-side
  string; the browser test suite (`test/tests.html`) is untouched.

### 2. Scenario walkthroughs (manual/observational — the acceptance bar for QA)

Run the skill against each fixed brief; inspect the produced plan (via `get_plan` + a share
URL). This is how the skill's prose is tuned. Acceptance checks per scenario:

| Scenario | Brief | Acceptance checks |
|---|---|---|
| **Living room** | ~4×5 m; sofa + TV + coffee-table + 2 armchairs; 0.915 m walkway | Focal chosen (TV/window); ONE conversation group (seats 0.46-0.76 m apart, **not** spread to 0.915 m); sofa on a wall AND pulled 0.15-0.30 m off it; coffee table ~0.4 m off sofa front, ~2/3 sofa width; TV opposite at 1.0-2.5× diagonal; armchairs mirrored. |
| **Bedroom** | ~3.5×4 m; Queen bed + 2 nightstands + dresser | Headboard against a wall; bedside clearance in the Queen band (0.76-0.91 m); foot clearance ≥ 0.91 m; nightstands mirrored on the bed centerline; dresser against a wall with ~0.91 m in front. |
| **Kitchen** | ~3×4 m; fridge + stove + sink (+ washer) | Work-triangle legs each 1.22-2.74 m, sum 3.96-7.92 m; appliances flush to wall runs; sink on a window/plumbing wall if present; no obstacle > 0.30 m into the triangle; washer anchored but NOT a triangle vertex. |
| **Gaming (battlestation)** | ~3×3 m; desk + chair (+ bookshelf) | Desk against the screen wall; seat faces the screen wall; monitor approximated (no `tv` mis-placed as a monitor); circulation ≥ 0.915 m to the seat. |
| **Gaming (console)** | ~4×4 m; sofa + TV | Sofa on a wall; TV opposite at 1.0-2.5× diagonal (reuses living-room C2); seat faces screen. |
| **Studio (mixed)** | ~4×6 m; bed + sofa + desk | Bed D-rules AND sofa B-rules both applied in one room; distinct zones; walkway ≥ 0.915 m between zones. |

### 3. Regression against the anti-marooned-sofa pattern (the load-bearing check)

- The skill must **NOT** spread a conversation group (or a kitchen work zone) to satisfy the
  walkway number. A well-grouped result where `check_clearance` reports an **intra-group
  "tight"** that the skill *leaves alone* is a **PASS**, not a fail.
- Corollary: a well-grouped layout where `check_brief` still lists the intra-group gaps in
  `unmet` (because today's code reports them) but the agent correctly does not chase them is
  also a PASS — the skill's stopping-condition prose must produce this behaviour.
- **Cross-check:** confirm the edited `design_room` prompt no longer instructs "apply each
  violation's suggestedMove until satisfied" (the substring is gone) — a grep-level check the
  implementer can eyeball, and the behavioural driver of the anti-pattern.

### Validation recording

Record each walkthrough's outcome (share URL + which acceptance checks passed) as the
evidence for tuning the prose. This mirrors LLD 32's empirical-validation discipline;
findings feed the decision on whether Phase 2/3 (the code-level split, the evaluator) is
warranted.

## Explicitly NOT in scope

Kept additive and minimal — the **only** code touch in Phase 1 is the `design_room` prompt
string; everything else is new markdown. The following are **out of scope** (do not drift):

- **Phase 2 code:** `mcp/src/roles.js` as a code constant, and group-aware `feedback.js` /
  `check_clearance` so `check_brief` stops flagging intra-group closeness. Phase 1 keeps the
  role map as a markdown table only, and mitigates the walkway/closeness conflict purely in
  skill prose + the prompt edit (LLD 72 Interaction #2, skill-level).
- **Phase 3 code:** the `check_layout` evaluator tool, its `LayoutReport` types, the
  `Brief.focal`/`style` fields, and any `set_brief` schema change. Build only if Phase-1 runs
  show the LLM's by-eye `[GEO]` arithmetic drifting (evidence-gated per LLD 72).
- **Any data-model addition:** front-vector / orientation field, stored focal designation,
  rug objects, `counter`/`island`, `monitor`/`gaming-chair`, `fireplace`, lighting layer,
  z-axis. Filed as follow-up issues (see *Catalog gaps*); handled by prose in Phase 1.
- **Room sizing / proportion** (golden-ratio, avoid-square, IRC minimums). Deferred by
  LLD 72's scope decision; the room comes from the brief.
- **Multi-room layout quality** (zoning, adjacency, room-to-room flow). Single-room only.
- **A `references/patio.md`** / patio as a first-class fifth context. Outdoor *types* are
  folded into the role map only (see *The `outdoor` category decision*).
- **Bathroom design context.** Catalog has bath pieces (`toilet`, `bathtub`) but bathroom is
  not one of the four requested contexts.
- **Any change to `src/js/*` runtime, the shared `clearance.js` threshold clamp, or the
  browser editor.** The skill drives the existing MCP surface unchanged.
- **Skill install/registration wiring** beyond creating the directory + files (no
  `project.json` / `settings.json` edits).
