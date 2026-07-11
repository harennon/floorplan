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

# Floorplan Interior Design

Drive the floorplan MCP tools to arrange a room that is **spacious and aesthetic**, not merely feasible — a real focal point, a proper seating/work group, and pieces on the right walls.

## When to use / prerequisites

Use this when the goal is **layout quality** — a room that feels open and balanced with one clear focal point — and not just fitting the required pieces. Supported room types: **living room, kitchen, bedroom, gaming room**.

**Prerequisite:** the floorplan MCP (LLD 32) must be connected. If its tools (`set_brief`, `add_room`, `place_symbol`, `check_clearance`, `check_brief`, `get_plan`, the `floorplan://catalog` resource, …) are absent, say so and stop — do **not** hallucinate geometry or describe a layout you cannot build.

## Coordinate & sizing conventions

The plan is in **metres, y-DOWN screen space**: `+x` = right, `+y` = DOWN, origin top-left. "Up / toward the top of the screen" means **decreasing y**. `rot` is degrees **clockwise**. A symbol's footprint is `w` (across its front) × `h` (front-to-back).

**Read `floorplan://catalog` for real object sizes** — every type carries per-axis bounds (`min_w/max_w/min_h/max_h`) plus named real-product presets (bed sizes, TV-stand widths, appliance widths, door leaves). Size within those bounds; do not invent dimensions. `place_symbol` clamps `w/h` to the catalog range and returns clearance. Openings (`door`/`window`) must sit **on a wall** or the mutator rejects them (LLD 71).

## Furniture-role map

Design rules talk about *roles* (seating, the focal element, storage), but the catalog only carries `type` + `category`. This static map lists **every plausible role** for a type. Which role applies to a given instance is resolved by **context** (size, proximity), not by the map — a `table` is a coffee table when it sits ~0.3–0.5 m off a sofa front, a dining table when chairs surround it. When ambiguous, prefer the room type's dominant reading (living → coffee; kitchen/dining context → dining).

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

`parasol` and `planter` are **free-standing accents** with no group role; place them without disrupting circulation.

**Role names are NOT placeable types.** `seating`, `dining-table`, `coffee-table`, `work-center`, `anchorable`, `storage`, `focal-candidate` are *roles for reasoning* about a placed piece — they are **not** valid `place_symbol` `type` values. There is no bare `dining-table` (or `seating`, or `work-center`) catalog type: `place_symbol {type:"dining-table"}` is rejected as an unknown type. Place a dining surface as `table` (rectangular) or `dining-table-round` / `patio-table`; place seating as `sofa` / `armchair` / `chair`. The role map is for deciding *how a piece behaves*, never for choosing the `type` argument.

## Workflow

1. **Establish requirements:** `set_brief` (room dims, required furniture, walkway).
2. **Build the room to exact dims:** `add_room {rect}` FIRST, before any furniture (LLD 32 M2). If a room is already mis-sized, use `resize_room` (rectangular, non-destructive) — do not rebuild and lose placed furniture.
3. **Identify the room type** (living / kitchen / bedroom / gaming) from the brief + user ask, and **read `references/<room>.md` now**, before placing furniture. If the brief mixes types (e.g. a studio = bed + sofa), read the dominant type's reference and borrow the other's placement rules for its pieces.
4. **Pick the FOCAL element** `[SOFT]` (the room-type reference refines the priority order). Remember it — you will orient the primary group at it.
5. **Place anchored pieces against walls first** (storage, bed headboard, appliances) — roles `anchorable` / `storage`, back-face-to-wall gap ≈ 0.
6. **Place the primary group** per the room-type reference (living: conversation group; kitchen: work triangle; bedroom: bed + nightstands; gaming: desk+screen or sofa+TV).
7. **Verify FEASIBILITY** with `check_clearance` / `check_brief`; fix **real** violations only — overlaps, containment, boxed-in pieces, and walkway deficits **on traffic paths**.
8. **Verify LAYOUT QUALITY** by reasoning over `get_plan` against the room-type rules; adjust toward the bands only where it does not reintroduce a feasibility violation. Re-run `check_clearance` after any adjustment — feasibility is authoritative and always re-run last.
9. **Stop** when `check_brief.satisfied` is true (or its only `unmet` entries are the expected intra-group closeness gaps — see next section) **and** the layout is *reasonable*. Do not chase a perfect score; layout advice is guidance, not a gate.

## Critical: walkway vs closeness

This is the load-bearing rule. The MCP walkway gate (default **0.915 m**, clamped to `[0.76, 1.20] m`) governs **traffic paths between zones** — it is **not** a rule about gaps between members of one seating group or one work zone.

Seats in a conversation group belong **0.46–0.76 m** apart; beyond 0.76 m the group "feels disconnected." **Do NOT spread a group to satisfy the walkway number.** Keep members close and route the ≥ 0.915 m path *around* the group. Treat an intra-group `check_clearance` "tight" as **expected, not a defect** to fix.

Caveat (know this so you don't chase it): with today's code, `check_brief` still *reports* those sub-walkway intra-group gaps in `unmet`, so it may never read `satisfied:true` for a well-grouped layout. That is acceptable — recognise those specific entries as the expected closeness gaps and leave them alone. A well-grouped layout that leaves an intra-group "tight" untouched is correct, not a failure.

## Anchor vs pull-off-wall

Storage, appliances, and bookshelves (`storage` / `anchorable`) sit **against** a wall — back-face-to-wall gap ≈ 0. A **sofa** and a **bed** are also anchorable, but are pulled *slightly* off the wall behind them where space allows (the living-room and bedroom references give the exact bands). In a tight room the pull may not fit — that is acceptable (`[ROT]`, not a gate). Feasibility wins: apply the pull only if `check_clearance` stays clean.

## Focal point (concept)

Every room has **one visual anchor** the primary group addresses. The room-type reference gives the priority order (living: fireplace > TV > picture window > longest blank wall; bedroom: the headboard wall; kitchen: the work triangle is its own logic — no single focal; gaming: the screen wall).

Orient the primary seating's **front** toward the focal element. Front direction is **intentional** — you place the piece facing the focal element; you never read "front" back from `rot` (which is only an orientation). If there is no obvious focal element, fall back to the longest uninterrupted wall or a window, and say which you chose.

## Room-type router

Once you have identified the room type, read its reference before placing furniture:

| Room type | Read | Primary group | Focal |
|---|---|---|---|
| Living room | `references/living-room.md` | conversation group | fireplace / TV / window |
| Kitchen | `references/kitchen.md` | work triangle | (triangle — no single focal) |
| Bedroom | `references/bedroom.md` | bed + nightstands | headboard wall |
| Gaming room | `references/gaming-room.md` | battlestation or console | screen wall |

For a **mixed-type** brief (e.g. a studio), read the dominant room's reference and borrow the other's placement rules for its pieces (bedroom D-rules for the bed, living B-rules for the sofa, in one room), keeping distinct zones with a ≥ 0.915 m path between them.

## Stopping condition & degradation

Aim for **feasible + reasonable, not perfect.** Every layout rule below is `[ROT]` guidance — a good default, occasionally overridden by user intent — tagged `[GEO]` (has a formula) or `[SOFT]` (judgment). Only `check_brief.satisfied` and hard feasibility (fit, containment, walkway on traffic paths) ever gate. If a `[ROT]` band cannot be met in the given room (a tiny room, minimal furniture), do the best-effort placement and move on — a `[SOFT]` rule is never a failure. With fewer than two seats, the conversation-group rules simply have no subjects; apply only the placement rules that do. Do not loop chasing an advisory band.
