# LLD 81: Measurements schema + persistence foundation (localStorage, share hash, export round-trip)

## Scope

Phase 1 (of 3) of the point-to-point measure tool (parent #87). This LLD delivers **only
the persisted data foundation** — a new `measurements` collection on the plan — and wires
it through every serialization surface so it survives localStorage, the share hash, and
JSON/PNG/SVG export **without breaking any existing saved plan or share link**. There is
no user-visible UI: the deliverable is verified entirely by round-trip and backward-compat
tests. Sub-issue #92 owns the tool/rail button and the interactive on-canvas renderer;
sub-issue #93 owns object-anchored / live-follow endpoints.

**In scope:**
- A new `measurements` array on the plan model, holding point-to-point distance
  annotations with fixed world-coordinate endpoints: `[{ id, a:{x,y}, b:{x,y} }]`.
- A **new module `src/js/measurements.js`** — an in-memory model + `hydrate()`, mirroring
  the `walls.js` / `symbols.js` shape (`export const model`, id counter, `hydrate`). A new
  module is required because `src/js/measure.js` already exists and is unrelated (it is the
  live area/perimeter *inspector panel*, not point-to-point annotations). Naming the model
  file `measure.js` would collide.
- Wiring the collection through **all** serialization paths in `src/js/plan.js`:
  `buildPlan`, `validatePlan`, `applyPlan`, `serializePlan`, and the compact codec
  `buildCompact` / `parseCompact` (LLD 77).
- Including measurements in the export path (`src/js/exportImg.js`): `contentBounds()` must
  account for their endpoints, and `buildExportSvg()` must render a minimal line + distance
  label so exported output never silently drops saved measurements.
- Re-exporting the new model + `hydrate` through the MCP import boundary
  (`mcp/src/core.js`) only as needed to keep `applyPlan`/round-trip working there; **no new
  MCP tools**.

**Explicitly NOT in scope:**
- Any UI: no tool, no rail button, no on-canvas interactive rendering or hit-testing
  (#92). The export renderer here is a static, non-interactive line+label only.
- Object-anchored or live-follow endpoints (#93). Endpoints are plain fixed world coords.
- Changing `PLAN_SCHEMA` in a way that rejects existing v1 plans (see Approach §1).
- Any change to drawing/snapping/units/clearance logic.

## Approach

### 1. Schema version: optional-additive, do NOT bump `PLAN_SCHEMA` (explicit call)

**Decision: keep `PLAN_SCHEMA = 1` and treat `measurements` as an optional-additive
field within the current schema.** Rationale (hard backward-compat requirement):

- `validatePlan` rejects any plan whose `schema !== PLAN_SCHEMA` (`plan.js:191`). Every
  plan saved to localStorage today, and every live share link, carries `schema:1` and has
  **no** `measurements` key. If we bumped to `PLAN_SCHEMA = 2`, all of those would fail
  the `=== 2` check and be rejected — a regression for every existing user.
- The share-link compact codec drops `schema` on encode and re-adds `PLAN_SCHEMA` on
  decode (`parseCompact`, `plan.js:141`). Compact payloads carry their own `v`
  (COMPACT_VERSION), independent of the plan schema; old `c` payloads have no measurements
  data and must still decode to an empty measurement list.
- The additive field is self-describing (absent = empty). A version bump buys nothing here
  and costs backward compatibility. `importJson` already treats `schema > 1` as a "newer
  version" soft-reject (`exportJson.js:61`); keeping schema at 1 leaves that untouched.

**Consequence:** `validatePlan` MUST treat a missing `measurements` key as valid and
normalise it to `[]` (never a rejection). It MUST still deep-validate a *present*
`measurements` value and reject malformed entries by returning `null` (consistent with all
other field validation). This tolerance is the crux of the whole LLD.

### 2. Entry shape — future-proof for object anchoring (#93) without another break

Endpoints are plain fixed world coordinates now:

```
{ id: "m0", a: { x, y }, b: { x, y } }
```

`a`/`b` are **objects** (`{x,y}`), not tuples, in the canonical Plan form (matches the
room-vertex convention so validation/serialization reuse `_isValidVertex`). This shape
grows to support #93 **additively**: an anchored endpoint later becomes
`a: { x, y, anchor: { symbolId, ... } }` — the `{x,y}` stays as the resolved/cached world
position and an **optional** `anchor` sub-object is added. Because `validatePlan` will only
require `x`/`y` on each endpoint (and ignore/pass-through unknown extra keys the same way
it does not enforce a closed key set elsewhere), a future `anchor` field will not require a
schema break. This LLD does not add `anchor`; it only picks a shape that admits it.

`id` is a string `m<n>` (mirrors `w<n>` rooms / `s<n>` symbols). `hydrate` re-syncs the id
counter past the max loaded id, exactly like `walls.hydrate` (`walls.js:288`).

### 3. `measurements.js` — new model module

Mirror `symbols.js` structure precisely so the wiring is mechanical:

- `export const model = { measurements: [] }` — plain JSON-safe objects, source of truth.
- `let _counter = 0` and `newId()` producing `m${_counter++}` (used by #92 later; here only
  `hydrate` and the model matter).
- `export function hydrate(next)` — splice-replace `model.measurements` in place (preserve
  array identity, like `walls.hydrate`) and re-sync `_counter` past the max `m<n>`.

No DOM, no imports beyond what's needed — keeps the module Node-loadable so `mcp/src/core.js`
can re-export it.

### 4. Wiring through `plan.js` (the five serialization paths)

- **`buildPlan()`** — add `measurements: JSON.parse(JSON.stringify(measurementsModel.measurements))`
  to the snapshot (deep clone, same idiom as walls/symbols).
- **`validatePlan(raw)`** — after the existing checks, validate measurements **tolerantly**:
  - `const rawMeas = raw.measurements === undefined ? [] : raw.measurements;` — **absent ⇒
    empty list, not rejection.**
  - If `rawMeas` is present it must be an array, else `return null`.
  - For each entry: object with `typeof id === "string"`, and `a`/`b` each pass
    `_isValidVertex` (finite `x`,`y`). Any failure ⇒ `return null`.
  - Include `measurements` (deep-cloned, normalised to `[]` when absent) in the returned
    clean copy.
- **`applyPlan(plan)`** — call `hydrateMeasurements(plan.measurements)` (plan always has the
  key post-validate). Import `hydrate as hydrateMeasurements` from `measurements.js`.
- **`serializePlan(plan)`** — add `measurements: plan.measurements` in the **fixed key
  order** after `symbols` (before `view`) so the stable dirty-check string is deterministic.
  Placement is arbitrary but must be fixed; put it after `symbols`.
- **Compact codec** — see §5.

### 5. Compact codec (share-hash, LLD 77)

Add a fourth top-level key `m` to the CompactPlan, tolerant of absence on decode:

- **`buildCompact(plan)`** — append `m: plan.measurements.map(me => [ _mmRound(me.a.x),
  _mmRound(me.a.y), _mmRound(me.b.x), _mmRound(me.b.y) ])`. Each measurement is a **flat
  4-number tuple** `[ax, ay, bx, by]` (mm-rounded, matching the room-vertex rounding in
  §LLD 77 §4). `id` is dropped and regenerated on decode (like room/symbol ids). Emit `m`
  always (even `[]`) for a uniform shape; an empty array costs ~5 bytes deflated.
- **`parseCompact(compact)`** — **tolerate absence** for old payloads:
  `const rawM = Array.isArray(compact.m) ? compact.m : [];` (do NOT `return null` when `m`
  is missing — pre-existing `c` links have no `m`). For each tuple: must be an array with 4
  finite numbers, else `return null` (structural reject, like the room/symbol paths). Map to
  `{ id: "m"+i, a:{x:t[0],y:t[1]}, b:{x:t[2],y:t[3]} }`. Add the `measurements` array to the
  reconstructed plan object handed to `validatePlan`.

The `u`/`d` legacy codecs carry full `serializePlan` JSON, which now includes
`measurements`; they need no codec change — `validatePlan` handles both presence (new
saves) and absence (old links).

### 6. Export (`exportImg.js`)

- **`contentBounds()`** — after the symbol loop, iterate `measurementsModel.measurements`
  and fold each endpoint `a`/`b` into `minX/minY/maxX/maxY`. This ensures export framing
  accounts for measurements even if they extend past walls/symbols.
- **`buildExportSvg()`** — after the symbol loop, render each measurement as a minimal,
  non-interactive **line + distance label**: an SVG `<line>` between `wx/wy(a)` and
  `wx/wy(b)` using an existing palette color (e.g. `p.dim`), plus a `<text>` at the segment
  midpoint showing `` `${fmtLen(dist)} ${unitLabel()}` `` where `dist` is the Euclidean
  world distance (reuse `edgeLength` from `walls.js`, already imported). Escape via
  `_escapeXml`. This is deliberately plain — #92 owns the real on-canvas styling. The
  requirement is only that saved measurements are **not silently dropped** from export.
- PNG path is unchanged: `exportPng()` rasterises whatever `buildExportSvg()` produces, so
  measurements appear in PNG for free.

### 7. MCP import boundary

Re-export the new `measurements.js` `model` (as `measurementsModel`) and `hydrate` (as
`hydrateMeasurements`) from `mcp/src/core.js`, mirroring the walls/symbols re-exports, so
`applyPlan` resolves under Node and round-trip tests can inspect the model. No new tools;
`get_share_url` and JSON import/export benefit automatically through the pure functions.

## Interfaces / Types

### `src/js/measurements.js` (new)

```js
/** @typedef {{ x:number, y:number }} Endpoint  // #93 will add optional `anchor` */
/** @typedef {{ id:string, a:Endpoint, b:Endpoint }} Measurement */

/** In-memory source of truth. Plain JSON-safe objects. */
export const model = { measurements: /** @type {Measurement[]} */ ([]) };

/** Mint the next measurement id ("m<n>"). Used by #92. */
export function newId()            // -> `m${_counter++}`

/**
 * Replace model.measurements IN PLACE (same array identity) and re-sync the id
 * counter past the max "m<n>" so a later newId() cannot collide with a loaded id.
 * @param {{ measurements: Measurement[] }} next
 */
export function hydrate(next)
```

### `src/js/plan.js` (extended)

`Plan` typedef gains `measurements: Measurement[]` (always present after validate/build).

```js
// buildPlan(): + measurements: <deep clone of measurementsModel.measurements>
// applyPlan(): + hydrateMeasurements(plan.measurements)
// serializePlan(): fixed key order { schema, app, walls, symbols, measurements, view, unit }

/**
 * validatePlan tolerance contract:
 *  - raw.measurements === undefined  -> normalise to []   (BACKWARD COMPAT: never reject)
 *  - raw.measurements present         -> must be Array, each entry { id:string,
 *    a:validVertex, b:validVertex }; otherwise return null.
 */
```

### Compact codec additions (`plan.js`)

```
CompactPlan gains:  m: number[][]   // each = [ax, ay, bx, by], mm-rounded; may be []
buildCompact:   m present always (even []).
parseCompact:   Array.isArray(compact.m) ? compact.m : []   // ABSENT tolerated (old links)
                each tuple must have 4 finite numbers, else null.
```

### `src/js/exportImg.js` (extended)

- `contentBounds()` folds each measurement's `a`/`b` into the bounds.
- `buildExportSvg()` emits, per measurement: one `<line>` + one midpoint `<text>` label
  (`fmtLen(edgeLength(a,b)) + " " + unitLabel()`), XML-escaped.

Signatures of all touched exported functions (`buildPlan`, `validatePlan`, `applyPlan`,
`serializePlan`, `buildCompact`, `parseCompact`, `contentBounds`, `buildExportSvg`) are
**unchanged** — only their internals grow.

### `mcp/src/core.js` (extended)

```js
export { model as measurementsModel, hydrate as hydrateMeasurements }
  from "../../src/js/measurements.js";
```

## State Model

- **Source of truth:** `measurements.js` `model.measurements` — an in-memory array of
  plain objects, alongside `walls.model`, `symbols.model`. Not yet mutated by any UI in
  this LLD; #92 will add the tool that pushes/removes entries.
- **Persisted (localStorage):** `store.js` calls `buildPlan()` → `serializePlan()` → writes
  the full JSON under `floorplan:plan:v1`; load calls `validatePlan(JSON.parse(...))`. The
  new `measurements` field rides along automatically once `buildPlan`/`serializePlan`/
  `validatePlan` include it. No `store.js` change, no `STORAGE_KEY` change.
- **Persisted (share hash):** compact `c` codec carries `m`; legacy `d`/`u` carry full JSON.
  All decode to a plan with a `measurements` array (empty for old links).
- **Persisted (JSON export/import):** `exportJson`/`importJson` reuse `serializePlan` /
  `validatePlan` — automatic, no change.
- **Ephemeral across a share/compact round-trip:** measurement `id`s (dropped on encode,
  regenerated `m<n>` on decode; `hydrate` re-syncs the counter). Endpoint coordinates are
  mm-rounded on the compact wire (lossless at snap granularity, per LLD 77 §4); the
  localStorage/JSON path is bit-exact.
- **Export render is read-only:** `exportImg.js` reads `measurementsModel.measurements`;
  it never mutates it.
- **No new persistence surface, no schema bump.** The field is additive within schema 1.

## Edge Cases

1. **Old plan / share link with no `measurements` key (HARD backward-compat).** Every plan
   saved before this change and every live share link lacks the field. `validatePlan`
   normalises absent → `[]` and accepts; compact `parseCompact` treats absent `m` as `[]`.
   Loads successfully as an empty measurement list — never a rejection. Explicit test.
2. **Present but not an array** (`measurements: {}` or a string). `validatePlan` →
   `return null` (structural reject, consistent with `walls.rooms` array check).
3. **Malformed entry — missing coord / non-finite / wrong type.** Any of: entry not an
   object, `id` not a string, `a` or `b` missing, `a.x`/`a.y`/`b.x`/`b.y` non-finite
   (NaN/Infinity/absent/string) ⇒ `validatePlan` returns `null`. Same "reject cleanly,
   never throw" contract as symbols/rooms. Explicit malformed-rejection tests for each.
4. **Empty measurements array.** Round-trips as `[]` through all paths; compact `m:[]`.
   Indistinguishable from the absent-key case after normalisation — both yield `[]`.
5. **Compact tuple wrong arity / non-finite** (`[1,2,3]`, `[1,2,3,"x"]`, `[NaN,..]`).
   `parseCompact` returns `null` on any tuple that isn't 4 finite numbers → `decodeHashToPlan`
   → `null` → existing "couldn't be opened" toast. Never throws.
6. **Old compact `c` link (no `m` key).** `Array.isArray(compact.m)` is false ⇒ treated as
   `[]`. Pre-existing `c` links keep decoding identically. Frozen-fixture test.
7. **Measurement extends beyond walls/symbols in export.** `contentBounds()` folds
   endpoints in, so export framing (and its `MARGIN_M`) includes the full measurement;
   the line is not clipped. Test asserts bounds expand for an out-of-room measurement.
8. **Zero-length measurement (`a === b`).** Allowed by validation (no min-length rule here;
   #92 owns placement guards). Export label uses `fmtLen(0)`; `<line>` is a degenerate
   point — harmless. Not rejected.
9. **Free-placed sub-mm endpoint over the compact wire.** Rounded to 1 mm on encode
   (matches LLD 77 §4). Round-trip is lossless at snap granularity, not bit-exact for the
   sub-mm remainder — accepted tradeoff, identical to room/symbol coords. JSON/localStorage
   path stays bit-exact.
10. **`id` collision after hydrate.** `hydrate` re-syncs `_counter` past the max `m<n>` so a
    later `newId()` (used by #92) cannot collide with a loaded id — mirrors `walls.hydrate`.
11. **Legacy `d`/`u` share link with measurements present** (a link minted after this ships
    but decoded by the `u` fallback, or a hand-crafted full-JSON link). Full JSON carries
    `measurements`; `validatePlan` accepts it. No compact-specific assumption leaks into the
    legacy path.
12. **Schema stays 1; a `schema:2` plan still soft-rejects.** No behavior change to
    `importJson`'s "newer version" message (`exportJson.js:61`) since we did not bump.

## Dependencies

**Must exist (all shipped):**
- `plan.js` — `buildPlan`, `validatePlan`, `applyPlan`, `serializePlan`, `buildCompact`,
  `parseCompact`, `_isValidVertex`, `PLAN_SCHEMA`, `_mmRound` (LLD 16, LLD 77).
- `share.js` — `encodePlanToHash`/`decodeHashToPlan` codec dispatch (LLD 16/77) — **no
  change needed**; it already round-trips whatever `buildCompact`/`serializePlan` emit.
- `store.js` — localStorage autosave via `buildPlan`/`serializePlan`/`validatePlan` — **no
  change**.
- `exportJson.js` — JSON export/import via the same pure functions — **no change**.
- `exportImg.js` — `contentBounds`, `buildExportSvg`; imports `edgeLength`, `fmtLen`,
  `unitLabel`, `palette`, `_escapeXml` (all present) — **extended** (§6).
- `walls.js` — `hydrate` id-resync pattern to mirror; `edgeLength` reused by export.
- `symbols.js` — `hydrate` structure to mirror for `measurements.js`.
- `mcp/src/core.js` — import boundary to extend with the measurements re-export.

**New additions:**
- `src/js/measurements.js` — `model`, `hydrate`, `newId`, `_counter` (new module).
- `plan.js` — import `model as measurementsModel` + `hydrate as hydrateMeasurements`;
  extend the five serialization functions.
- `exportImg.js` — import `measurementsModel`; extend `contentBounds`/`buildExportSvg`.
- `mcp/src/core.js` — re-export `measurementsModel`, `hydrateMeasurements`.

**No new libraries, no build step, no backend** — client-side only, consistent with v1.

**Downstream (not this LLD):** #92 (measure tool + interactive renderer) and #93 (object
anchoring, extends the endpoint shape additively).

## Test Requirements

Frontend tests: extend `test/tests.html` (in-page `describe`/`it`/`expect`, run headless
via `.github/run-tests.mjs`). Reset `walls.model`, `symbols.model`, and the new
`measurements.model`, plus `units.unit`/`view` between suites (existing pattern). MCP
tests: extend `mcp/test/` (`node --test`). Full command: the project `commands.test`
(`node .github/run-tests.mjs && (cd mcp && node --test)`). **All existing tests must still
pass** (measurements is additive; nothing existing should change behavior).

**Unit — `measurements.js`:**
- `hydrate({measurements:[...]})` replaces the model in place (same array identity) and
  re-syncs `_counter` past the max `m<n>` so the next `newId()` doesn't collide.

**Unit — `plan.js` build/validate/serialize/apply:**
- `buildPlan()` snapshots live measurements (deep clone; mutating the model afterward does
  not mutate the snapshot).
- Round-trip: `applyPlan(validatePlan(buildPlan()))` is lossless for a plan with several
  measurements (ids preserved through this path since JSON keeps them; geometry exact).
- `validatePlan` **acceptance:** a plan with a valid `measurements` array validates and
  returns it normalised (deep copy).
- `validatePlan` **backward compat (HARD):** a plan object with **no** `measurements` key
  validates and returns `measurements: []` — NOT null.
- `validatePlan` **rejections (returns null, never throws)** for: `measurements` not an
  array; entry not an object; `id` not a string; missing `a` or `b`; `a`/`b` with
  non-finite or missing `x`/`y`; wrong-type coord.
- `serializePlan` emits `measurements` in the fixed key order; two plans differing only in
  measurements produce different strings (dirty-check works).

**Unit — compact codec (`plan.js`):**
- Round-trip: `validatePlan(parseCompact(buildCompact(p)))` deep-equals `p`'s measurement
  geometry (coords on snap multiples ⇒ lossless; ids regenerated, compare geometry only).
- mm-rounding: a free-placed endpoint `1.23456` becomes `1.235` and round-trips to `1.235`
  (assert to-mm equality, documented as intentional per LLD 77 §4).
- **Absence tolerance (HARD):** `parseCompact` on a compact object with **no** `m` key
  yields a plan whose `measurements` is `[]` (old `c` links keep working).
- `parseCompact` returns `null` for a malformed `m` tuple (arity ≠ 4, non-finite number).
- Empty plan: `buildCompact` yields `m:[]`; round-trips to `measurements:[]`.

**Integration — persistence surfaces (round-trip, HARD acceptance):**
- **localStorage:** `serializePlan` → `JSON.parse` → `validatePlan` round-trips
  measurements losslessly.
- **share hash (compact `c`):** `decodeHashToPlan(await encodePlanToHash(p))` reconstructs
  measurement geometry (via the MCP `decodeHashToPlan` or the in-page share suite).
- **JSON export/import:** `validatePlan(JSON.parse(serializePlan(buildPlan())))` preserves
  measurements.

**Backward-compat (HARD — explicit "old-artifact-still-loads"):**
- A frozen legacy JSON fixture with **no** `measurements` key loads (validates → `[]`).
- A frozen legacy `c`/`u` share-hash fixture (captured pre-change, no measurements) decodes
  to a plan with `measurements: []`, never null. (Extend/reuse the existing frozen-fixture
  backward-compat tests for share codecs.)

**Export (`exportImg.js`):**
- `contentBounds()` includes measurement endpoints: a measurement extending beyond
  walls/symbols expands the returned bounds (Edge Case 7).
- `buildExportSvg()` output contains a `<line>` and a distance-label `<text>` for each
  saved measurement (assert count / substring); with measurements present the SVG does not
  drop them. A plan with measurements but no rooms/symbols still frames (non-null bounds).
- PNG path unchanged (no separate assertion needed beyond SVG, since PNG rasterises the SVG).

**Regression / safety:**
- No `NaN`/`Infinity` endpoint ever reaches the model from a decoded plan (validate
  finite-checks guard this).
- Existing `plan.js`, `share.js`, `exportImg.js`, and MCP suites still pass unchanged.
