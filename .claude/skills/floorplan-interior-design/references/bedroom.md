# Bedroom

*Aesthetic:* a restful room with the bed as the anchor, symmetric nightstands, and clear walking room on the used sides.

Every rule is `[ROT]` guidance, tagged `[GEO]` (formula) or `[SOFT]` (judgment). Rule IDs (D, C4) carried from LLD 72. All lengths metres, y-DOWN frame. The focal element is the **headboard wall**; orient the bed's head against it.

## Bed placement

- **D3 `[GEO]` — headboard against a wall:** the head short side of the bed sits against a wall (gap ≈ 0). This defines the head/foot orientation for the rules below.
- **D1 `[GEO]` — bedside clearance scales with bed size:** read `bed.w` against `CATALOG.bed.presets` to identify the size, then keep this clearance on each **used long side**:
  - Twin / Full (`w` ≈ 0.97–1.37 m): **0.61–0.76 m**
  - Queen (`w` ≈ 1.52 m): **0.76–0.91 m**
  - King / Cal King (`w` ≈ 1.83–1.93 m): **0.91–1.07 m**
- **D2 `[GEO]` (ADAPT) — foot-of-bed clearance:** **≥ 0.91 m** from the foot (the short side opposite the headboard) to the nearest obstruction.

## Nightstands & storage

- **C4 `[GEO]`/`[SOFT]` — nightstand symmetry:** two nightstands mirror the bed's centerline (a matched pair with equal offsets, flanking the headboard). This is the clearest symmetry win in a bedroom. With one nightstand, place it on the primary-access side; don't fabricate a second just for symmetry.
- **Dresser / wardrobe:** `storage`/`anchorable` — place against a wall (back-face-to-wall gap ≈ 0), with **~0.91 m** of clear floor in front to open drawers / doors.

## Types in play

`bed`, `nightstand`, `dresser`, `wardrobe`, `cabinet`.

## Real sizes (read `floorplan://catalog`)

- `bed` presets drive D1: Twin 0.97 m / Twin XL 0.97 m / Full 1.37 m / Queen 1.52 m / King 1.93 m / Cal King 1.83 m (bounds 0.97–1.93 m wide, 1.91–2.13 m deep).
- `nightstand` 0.40–0.60 m; `dresser` 0.78–1.60 m (3-drawer / 6-drawer); `wardrobe` 0.50–1.50 m (1/2/3-door).
