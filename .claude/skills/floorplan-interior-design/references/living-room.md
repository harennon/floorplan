# Living room

*Aesthetic:* a warm, conversation-first room with one clear focal point and seating pulled into a real group — not furniture lining the walls.

Every rule is `[ROT]` guidance (a good default, not a gate), tagged `[GEO]` (has a formula) or `[SOFT]` (judgment). Rule IDs (A/B/C) are carried from LLD 72 so they stay traceable. All lengths are metres in the y-DOWN frame.

## Focal point

- **C1 `[SOFT]` — focal priority:** fireplace > TV > picture window / view > longest blank wall. There is no `fireplace` catalog type, so if the brief implies one, designate a wall (or a window/`tv`) as the focal instead. Designate exactly **one** focal element and remember it.
- **B4 `[GEO]` — addressing the focal:** orient the primary seating's *front* at the focal element, within ~**25°**. Front is intentional (you place the sofa facing the focal), never read back from `rot`.

## Conversation group

- **A1 `[GEO]` — facing distance:** facing seats sit **≤ 2.4 m** apart (center-to-center or nearest-face); beyond **3.05 m** conversation stops. Keep the two facing sides of the group inside 2.4 m.
- **A2 `[GEO]` — intra-group spacing:** members **0.46–0.76 m** apart (target band). *Cross-reference the SKILL.md walkway-vs-closeness rule:* these gaps are **expected to read below 0.915 m** — do NOT widen them to the walkway number. An intra-group `check_clearance` "tight" here is expected, not a defect.
- **A3 `[GEO]` (ADAPT) — coffee-table distance:** coffee table **0.36–0.46 m** off the sofa front (measured from the sofa's front face to the table's near face).
- **A4 `[GEO]` — coffee-table width:** ≈ 2/3 the sofa's width: `ct.w / sofa.w ∈ [0.5, 0.75]`.
- **A5 `[SOFT]` — one group:** seats form *one* conversation group facing the focal, not a scatter around the walls. Judgment; don't fabricate a group from a single sofa.

## Sofa & anchoring

- **B1 `[GEO]` — sofa vs wall length:** the sofa spans **60–75%** of its facing wall segment: `sofa.w / segLen ∈ [0.60, 0.75]`. On a wall much longer than the sofa, that means a bigger sofa (or accept a lower ratio); on a short wall, a smaller preset.
- **B2 `[GEO]` (ADAPT) — off-wall pull:** pull the sofa **0.15–0.30 m** off the wall behind it, space permitting. Feasibility wins — apply only if `check_clearance` stays clean; a tiny room may not afford it, and that is fine.
- **B3 `[GEO]` — storage against the wall:** `anchorable`/`storage` pieces (bookshelf, cabinet) sit **against** a wall (back-face-to-wall gap ≈ 0), *not* pulled off like the sofa.

## TV / focal geometry & symmetry

- **C2 `[GEO]` — TV viewing distance:** place the TV opposite the primary seating at **1.0–2.5× its diagonal**. Estimate the diagonal from the stand width (16:9): `diag ≈ hypot(w, w·9/16)`. The band is the union across resolutions (resolution is not modelled), so 1.0–2.5× the estimated diagonal is the target gap from the seat front to the TV face.
- **C4 `[GEO]`/`[SOFT]` — symmetry:** matched pairs (e.g. two armchairs) mirror the focal axis with equal offsets; primary seating is centered on that axis. Judge visual weight — don't force perfect symmetry over a workable layout.

## Types in play

`sofa`, `armchair`, `chair`, `coffee-table`, `table`, `tv`, `bookshelf`.

## Real sizes (read `floorplan://catalog`)

- `sofa` presets: Loveseat 1.65 m / 3-seat 2.10 m / Sectional 2.60 m (bounds 1.50–3.50 m wide).
- `tv` presets: 43" 1.20 m … 85" 2.00 m stands — use the stand width to estimate the diagonal for C2.
- `coffee-table` bounds: 0.90–1.50 m wide; drive A4 off the actual sofa width you placed.
- `armchair` 0.65–1.10 m; `table` 0.40–2.40 m (its "Side"/"Utility" presets read as a coffee table near a sofa; "Dining N" presets read as a dining table).
