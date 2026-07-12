# Kitchen

*Aesthetic:* an efficient galley / L / U work core built around the **NKBA work triangle** — appliances placed for a short, unobstructed cook path, not spread for looks.

Every rule is `[ROT]` guidance, tagged `[GEO]` (formula) or `[SOFT]`/prose (judgment). All lengths metres, y-DOWN frame. A kitchen has **no single focal element** — the work triangle is its own organizing logic.

## Work triangle `[GEO]`

The triangle's three vertices are the `work-center` pieces: **`sink`, `fridge`, `stove`**.

- Each **leg** (center-to-center) is **1.22–2.74 m**.
- The three legs **sum to 3.96–7.92 m**.
- No obstacle should protrude more than **0.30 m** into the triangle.

Placement intent: put the **sink** on the window / plumbing wall if a window exists; the **fridge** near the entry end (so someone grabbing a drink doesn't cross the cook path); the **stove** on a run with landing space either side.

## Work aisle

Clear floor between opposing runs (or a run and an island): **≥ 1.07 m** for one cook, **≥ 1.22 m** for two cooks.

**Important walkway note (state it, and respect the code):** the two-cook figure **1.22 m is above the MCP walkway ceiling of 1.20 m**, so a `set_brief` / `check_clearance` `minWalkwayM` **cannot** encode it. Advise the two-cook aisle as **prose only**, and use `minWalkwayM: 1.07` (in-band) as the checkable floor. Do **NOT** pass `minWalkwayM: 1.22` (or anything outside `[0.76, 1.20]`): `set_brief` / `check_clearance` **reject** an out-of-range walkway with `{ok:false}` — the call fails and the brief is left unset/stale; it is **not** silently clamped to 1.20. So: for two cooks, keep ~1.22 m of clear floor by placement and describe it in prose; set the brief floor to 1.07.

## Landing zones `[SOFT]` / prose

Reserve counter space beside each appliance:

- **Fridge:** ≥ **0.38 m** on the handle side.
- **Stove:** **0.30–0.38 m** each side.
- **Sink:** **0.46–0.61 m** each side.

**The catalog has no `counter` / `island` type**, so landing zones are **prose guidance only** — the agent reserves the empty floor span beside the appliance; it cannot place a counter. Do **not** invent a counter by mis-using another type.

## Anchoring

All appliances are `anchorable` — place them **flush against a wall run** (back-face-to-wall gap ≈ 0). A `washer`, if present, is `anchorable` but is **NOT** a triangle vertex — anchor it on a run without counting it as sink/fridge/stove.

## Explicitly deferred here

Counter/island landing surfaces, upper cabinets, and any height / clearance-above-counter rule are **not modelled** (this is a 2-D plan) — handled by prose only, never a checkable rule.

## Types in play

`fridge`, `stove`, `sink`, `washer`.

## Real sizes (read `floorplan://catalog`)

- `fridge` 0.55–0.91 m (presets 24"/30"/33"/36").
- `stove` 0.61–0.91 m (24"/30"/36").
- `sink` 0.61–0.91 m (24"/30"/33" double).
- `washer` 0.60–0.70 m (24" compact / 27" standard).
