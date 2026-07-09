# LLD 47: MCP server hardening — small correctness/spec-alignment nits from LLD 32 review

## Scope

Follow-up hygiene for the MCP server shipped in LLD 32 (PR #47). A catch-all for the four
low-severity nits raised in code review + QA that were consciously deferred for the MVP.
None affects the single-room loop's correctness; each is cheap-if-touched.

Covers exactly four independent items:

1. **Enforce the "no `await` in a mutator handler" invariant** with an automated check
   (`mcp/test/`), replacing the comment/review-only enforcement in `mcp/src/tools.js`.
2. **Reject degenerate/collinear `add_room`** (LLD 32 EC5): a room whose closed polygon has
   `area === 0` is a zero-area sliver and must return `{ ok:false }`.
3. **Align EC11 path-traversal wording** in LLD 32 to the shipped *sanitize-and-write*
   behaviour in `mcp/src/io.js` (documentation change, not a code change).
4. **Remove the redundant `computeClearances` recompute** in `classifyFlank`
   (`mcp/src/feedback.js`) by passing the neighbour's clearances through.

**Explicitly NOT in scope** (tracked elsewhere — do not drift into them):
- Single-session guard / room-to-room overlap gaps → issue #51.
- M6 convergence limit / joint two-piece moves → issue #50.
- Any change to tool granularity, catalog, or the feedback string format beyond item 4's
  internal refactor (item 4 must be behaviour-preserving).

## Approach

### Item 1 — Enforce "no `await` in a mutator handler"

The concurrency contract (LLD 32 State model, "no mutator awaits") currently rests on a
review rule and code comments in `tools.js`. Make it code-checkable with a **static test**
(not a runtime lint dependency — the project has no lint toolchain and "deploy cheap"
discourages adding one). The test reads `mcp/src/tools.js` source text and asserts that no
mutator handler body contains the token `await`.

- **Mutator set = every exported `tool_*` function EXCEPT the two known async handlers**
  `tool_save_plan` and `tool_get_share_url`. These two legitimately `await` after snapshotting
  (the contract's documented exception). Evaluators (`tool_get_metrics`, `tool_check_clearance`,
  `tool_check_brief`, `tool_get_plan`) are synchronous today and read-only, so including them in
  the "no await" set is harmless and keeps the rule simple: *only save_plan/get_share_url may await.*
- **Recommended implementation:** parse the file into per-function source slices and scan each
  non-allowlisted `tool_*` function for a `\bawait\b` match. A regex/brace-scan over the source
  string is sufficient and dependency-free; no need for a real JS parser.
- **Rationale over alternatives:** a runtime reflection check (`fn.constructor.name === "AsyncFunction"`)
  would catch an `async` keyword but NOT a handler that calls an async helper and awaits it, and it
  can't see the source. A source-scan catches the literal `await` token, which is exactly the
  invariant's wording. Recommended.
- Allowlist is defined as an explicit `Set` of the two async handler names so a reviewer can see
  precisely what is exempt; a new async mutator fails the test until its author either makes it sync
  or consciously (and visibly) amends the allowlist.

### Item 2 — Reject degenerate/collinear `add_room` (EC5)

`tool_add_room` currently returns `{ ok:true, metrics:{area:0} }` for 3+ collinear verts because
`closeRoom()` only no-ops below 3 *effective* verts; a collinear ring closes fine but has zero
shoelace area. LLD 32 EC5 groups collinear verts with the reject case, so this is a spec gap.

**One-line guard, after the successful close, before returning `ok:true`:** compute the closed
room's area (via `roomMetrics(room)` / `polygonArea(room.verts)`, already imported) and if it is
`0` (use `=== 0`; `polygonArea` returns an exact `0` for a collinear ring — no epsilon needed since
shoelace of collinear integer-ish coords is exactly zero, and any nonzero area is a real room),
roll back the just-pushed room and return `{ ok:false, reason }`.

- **Rollback:** the room was appended to `wallsModel.rooms`; on the zero-area path `pop()` it so no
  sliver persists, and clear `wallsModel.chain` (already cleared by `closeRoom`, but keep symmetric
  with the existing `< 3` reject path).
- **Reason string:** reuse an EC5-aligned message, e.g. `"a room needs 3+ non-collinear corners"`.
  (Slightly more specific than the existing `"a room needs at least 3 corners"` so the agent
  distinguishes the two failures; either is acceptable.)

### Item 3 — EC11 path-traversal wording (doc fix)

`io.js` **sanitizes** a traversal filename (`../../etc/evil` → `evil.json`) to a safe basename inside
the sandbox and re-verifies the resolved path is a direct child of the plans dir before writing —
verified net-secure (nothing escapes). LLD 32 EC11 currently says traversal is *"rejected"*, which
does not match the shipped, safe behaviour.

**Recommendation: amend the doc, not the code.** Sanitize-and-write is the cheaper, equally-safe
alignment and is friendlier to an agent (a save always succeeds with a sane name rather than erroring
on a cosmetically-odd filename). Only the *absolute-parent* case (a resolved path whose parent is not
the plans dir) is rejected, which is correct and stays. Edit EC11's wording in
`docs/lld/32-mcp-server-agent-driven-floorplan.md` to describe sanitize-and-write, and note that a
target resolving outside the dir is still refused. No `io.js` change.

- If a future reviewer finds silent sanitize genuinely surprising, the alternative is a one-line code
  change to return `{ ok:false, reason }` when `path.basename(name) !== name` (i.e. input contained
  separators). Not recommended — it trades a safe success for a confusing failure. Documented here only
  as the fallback.

### Item 4 — `classifyFlank` efficiency

In the boxed-in branch, `reconcile()` calls `classifyFlank()` for the nearest flank on each side, and
each `classifyFlank` re-runs `computeClearances(nb, world)` for the neighbour. The neighbour's
clearances are recomputed from scratch every time a boxed-in axis is evaluated. Fine at prototype scale;
avoid the recompute so it doesn't get hot if furniture counts grow.

**Approach: memoize per-report.** Introduce a small cache keyed by symbol id, populated lazily, that
wraps `computeClearances(sym, world)` for the duration of one `buildClearanceReport` call. `classifyFlank`
takes the cache (or a `clearancesFor(id)` accessor) instead of calling `computeClearances` directly.
`world` is constant within a report, so caching by neighbour id is sound.

- **Behaviour-preserving:** the cache returns the identical array `computeClearances` would; only the
  number of calls drops. No output changes — item 4 must not alter any feedback string or `suggestedMove`.
- **Scope of the cache:** a plain `Map<string, Clearance[]>` created at the top of `buildClearanceReport`
  and threaded through `reconcile` → `classifyFlank`. The subject's own `raw` clearances (already computed
  per subject) can seed the map so a neighbour that is also a subject reuses its array.
- **Do not** hoist to a module-level/global cache — that would risk staleness across reports (a mutator
  changes geometry between calls). Per-report scope only.

## Interfaces / Types

No public tool signatures change. Internal signatures only:

**Item 2** — `tool_add_room(args)` return type is unchanged in shape; the *set* of inputs that
yield `{ ok:false, reason }` grows to include a closed-but-zero-area polygon.

**Item 4** — `feedback.js` internal helpers gain a per-report clearance cache. Illustrative
(not prescriptive) shape:

```
// within buildClearanceReport(...)
const clearanceCache = new Map();               // id -> Clearance[]
const clearancesFor = (sym) => {
  let c = clearanceCache.get(sym.id);
  if (!c) { c = computeClearances(sym, world); clearanceCache.set(sym.id, c); }
  return c;
};

// signatures thread the accessor through:
reconcile(center, subjectW, subjectH, gaps, thresholdM, world, getSymbolById, clearancesFor)
classifyFlank(gap, openDir, thresholdM, world, getSymbolById, clearancesFor)
//   inside classifyFlank: const nbClear = clearancesFor(nb);   // was computeClearances(nb, world)
```

**Item 1** — no source interface; a new test file (or a new `test(...)` in an existing file) that
imports the raw text of `mcp/src/tools.js` and asserts the invariant. Suggested location:
`mcp/test/mutator-invariant.test.js` (or fold into `mutators.test.js`). Allowlist constant:

```
const ASYNC_ALLOWLIST = new Set(["tool_save_plan", "tool_get_share_url"]);
```

## State Model

No change to what is persisted vs in-memory. The MCP server keeps its single in-memory plan in
the core singletons (`wallsModel` / `symbolsModel`); nothing here adds persistence.

- **Item 2** must leave `wallsModel` unchanged on the reject path — the zero-area room is popped so
  the singleton holds no sliver (same net effect as the existing `< 3` reject). This preserves the
  load/edit/dump discipline: a failed `add_room` is a no-op on state.
- **Item 4** the clearance cache is transient, scoped to a single `buildClearanceReport` invocation,
  and holds no cross-call state (avoids staleness after a mutation). Not persisted, not shared.
- **Items 1 and 3** touch no runtime state (a test and a doc, respectively).

## Edge Cases

Enumerated with specified handling:

1. **`add_room` with 3+ collinear verts** (the target of item 2) → closed polygon `area === 0` →
   pop the room, return `{ ok:false, reason:"a room needs 3+ non-collinear corners" }`. State unchanged.
2. **`add_room` where verts are near-collinear but not exactly** (tiny nonzero area, e.g. a 1 mm sliver
   from float noise) → `polygonArea > 0`, so it is accepted. This is intentional: the guard rejects only
   *exact* zero (true degeneracy). A near-degenerate room is a real, if silly, room and the single-room
   brief tolerance (M3, ±0.025 m on bbox) governs whether it satisfies a brief. Do not add an area epsilon
   here — it would risk rejecting a legitimately thin room.
3. **`add_room` with < 3 verts** → unchanged; still caught by the existing `verts.length < 3` /
   `closeRoom` no-op path before the area check. The area guard runs only after a successful close.
4. **Item 1 test false-positive risk:** an evaluator or the word "await" appearing in a comment/string
   inside a mutator. Mitigation: the scan targets the mutator function bodies; if comment/string
   stripping is not done, keep mutator handlers free of the literal token in comments (they are today).
   Simplest robust form: match `\bawait\b` in code; accept that a comment containing "await" in a
   mutator would trip the test — that is acceptable (and arguably desirable: keep the word out of those
   bodies). Document this in the test.
5. **Item 1 — a genuinely-needed future async mutator:** the test fails; the implementer must either make
   it synchronous or add its name to `ASYNC_ALLOWLIST` *and* re-satisfy the concurrency contract
   (snapshot-before-await, or a mutex). The test's failure message should point at the contract in LLD 32.
6. **Item 4 — neighbour that is an opening** (`CATALOG[type].openings`): `computeClearances` returns `[]`
   for openings; the cache stores `[]` and `classifyFlank` behaves identically to today. No change.
7. **Item 4 — subject appears as its own neighbour's neighbour:** cache keyed by id makes this idempotent;
   the array is computed once regardless of how many flanks reference it.
8. **Item 3 — filename that resolves outside the plans dir** (e.g. an absolute-parent trick): still refused
   by the existing `path.dirname(target) !== dir` check. The doc amendment must preserve this: sanitize the
   basename, but refuse a target whose parent is not the plans dir.

## Dependencies

- **LLD 32** (`docs/lld/32-mcp-server-agent-driven-floorplan.md`) — the parent design; item 3 edits its
  EC11 text. All four items build on shipped code from PR #47.
- Existing source: `mcp/src/tools.js` (items 1, 2), `mcp/src/feedback.js` (item 4),
  `mcp/src/io.js` (item 3 — read-only reference), `mcp/src/core.js` re-exports (`roomMetrics`,
  `polygonArea`, `computeClearances` — all already imported where needed).
- Existing tests: `mcp/test/mutators.test.js`, `mcp/test/io.test.js` — extend, don't rewrite.
- Test runner: `node --test` over `mcp/`, already wired into the validate workflow by LLD 44
  (`project.json.commands.test`). No new tooling or dependency is added — consistent with the
  "deploy cheap / no build step" principle.
- No dependency on #50 or #51; all four items are independent of each other and can land in any order
  within one PR.

## Test Requirements

Organized by category. Specify what must be tested, not how.

### Unit — `tools.js`
- **add_room collinear reject (item 2):** `add_room({verts:[{0,0},{1,0},{2,0}]})` (3 collinear) →
  `{ ok:false }`, and `wallsModel.rooms` length is unchanged (no sliver persisted).
- **add_room still accepts a valid room:** existing rect/quad tests continue to pass (regression guard
  that the area check doesn't reject real rooms). Include a non-rectangular but nonzero-area polygon.
- **add_room < 3 verts** → still `{ ok:false }` (unchanged path).

### Unit — `feedback.js` (item 4)
- **Behaviour-preservation:** a boxed-in scenario (subject pinned between a movable piece and a wall)
  produces the *same* `ClearanceReport` (violations strings, `suggestedMove`, `boxedInAxes`) before and
  after the refactor. Assert on a known fixture, or snapshot the report for an identical world.
- **Movable-flank path still classifies correctly** — the `roomBehindM` / `moveNeighbours` output is
  unchanged (the cache returns identical clearances).

### Structural / invariant — `tools.js` (item 1)
- **No-await invariant test:** asserts every exported `tool_*` function except the two allowlisted async
  handlers contains no `await` token. Test must FAIL if a mutator gains an `await`, and PASS on the
  current source. Include a self-check that the allowlist names actually exist as exports (guards against
  a rename silently disabling the rule).

### Docs (item 3)
- Not a test; verify by review that EC11 in LLD 32 reads "sanitize-and-write" and still states that a
  target resolving outside the plans dir is refused. Existing `io.test.js` traversal tests remain the
  behavioural guard and must keep passing (they already assert the sanitized path is a direct child).

### Security
- Existing `io.test.js` path-traversal cases (`../evil`, absolute paths, `..%2F`) must continue to pass
  unchanged — item 3 does not weaken the sandbox; it only re-words the doc to match verified-safe behaviour.

