# LLD 44: CI — run the `mcp/` Node test suite in the validate workflow

## Scope

**Covers:** Adding a step to the existing `validate` job in `.github/workflows/ci.yml` so the
`mcp/` Node test suite (`node --test`, 38 tests) runs on every `pull_request` and `push` to
`main`. This closes the gap identified in LLD 32 note **M4**: the import-boundary drift guard
exists but does not gate the real merge path.

**The gap (verified):**
- LLD 32 M4 (`docs/lld/32-mcp-server-agent-driven-floorplan.md`, lines 754–763) intends the
  `mcp/` import-smoke test to fail the pipeline "the moment a `src/` edit leaks a top-level DOM
  reference into a module the server imports."
- PR #47 implemented M4 only in `.claude/project.json` `commands.test` (line 18):
  `node {dir}/.github/run-tests.mjs && (cd {dir}/mcp && node --test)`. That command is invoked
  by the agent fleet (ship-batch / ship-issue), **not** by CI.
- The real PR gate is `.github/workflows/ci.yml`, job `validate` (the load-bearing required
  check-run per LLD 13). Its "Run unit tests" step (line 72) runs only `node .github/run-tests.mjs`
  (the browser Playwright suite over `src/`). Nothing in `ci.yml` runs `node --test` in `mcp/`.
- Consequence: a `src/` change that breaks the `src/`→`mcp/` import boundary, or any regression
  in the 38 `mcp/` tests, passes CI green today.

**Explicitly does NOT cover:**
- Branch-protection / `required_status_checks` wiring — deferred per LLD 13 (gated on a GitHub-plan
  decision). Adding the mcp suite as a *step* inside `validate` (not a new job) means it reports
  under the existing `validate` check-run name, so no new context needs registering when protection
  is later enabled.
- Any change to `.claude/project.json` `commands.test` (already correct from PR #47) or to the
  `mcp/` tests themselves.
- Resolving the deferred `../src/js` import self-containment (LLD 32 Q6) — out of scope; this LLD
  only makes its early-warning actually gate.
- Adding a build step to `src/` — the mcp suite is pure Node, no Chromium.

## Approach

**Decision: a step in the existing `validate` job, not a separate job.** (Per selection guidance
and LLD 13.)

- **Shares the check-run name.** LLD 13 makes `validate` the single load-bearing check-run string
  that the deferred branch-protection follow-up will reference as `required_status_checks.contexts
  = ["validate"]`. A step inside `validate` reports under that same name — zero branch-protection
  bookkeeping. A separate job would add a second context that the deferred config would have to be
  told about, contradicting LLD 13's "one entry, `validate`" design.
- **Node 20 is already set up** in `validate` (ci.yml lines 27–30). The new step reuses it; no extra
  `setup-node`.
- **Reproducible install via `npm ci`.** `mcp/package-lock.json` is committed (verified present);
  `mcp/node_modules` is gitignored (repo-root `.gitignore` line 1: `node_modules/`). `npm ci`
  installs exactly the locked tree and is the reproducible install. The only dependency is
  `@modelcontextprotocol/sdk` (pure Node, no Chromium) — negligible cost.
- **Why the install is required, not optional (verified):** running `node --test` in `mcp/` with no
  `node_modules` fails test #17 ("server.js imports without starting the stdio server") with
  `Cannot find package '@modelcontextprotocol/sdk'`. So the install step is load-bearing: without
  it the suite reports 37 pass / 1 fail. With `npm ci` it must report 38 pass / 0 fail.

**Placement of the step.** Add it after the existing "Run unit tests" step (ci.yml line 71–72),
i.e. after the Playwright suite and before the "Check links" step. Ordering rationale: keep the two
`src/`-validating test steps adjacent, and run the cheap mcp suite before the network-dependent
link check. Placement is not correctness-critical (steps run sequentially and any failure fails the
job); this is a readability choice.

**No `cd` into a compound-with-redirect concern in YAML.** The step body uses a plain multi-line
`run:` block; `working-directory: mcp` is the idiomatic alternative to `cd mcp`. Either is fine;
the spec below uses `working-directory` to keep each command on its own line.

**Alternative considered — reuse `.claude/project.json` `commands.test`.** Rejected: that command
also invokes `run-tests.mjs` (already a separate CI step) and assumes the agent-fleet install shape.
CI already has its own explicit steps; duplicating the browser suite via that command would run it
twice. Keep CI steps explicit and mcp-only.

## Interfaces / Types

The only artifact is the new step in `.github/workflows/ci.yml`, inserted after the "Run unit
tests" step (current line 72) and before the "Check links" step (current line 79):

```yaml
      # ── Step 3b: MCP server tests (pure Node, no Chromium) ───────────────────
      # The mcp/ suite (node --test) is the import-boundary drift guard from LLD 32
      # M4: it fails CI the moment a src/ edit leaks a top-level DOM reference into a
      # module mcp/src/server.js imports. Runs in the validate job so it reports under
      # the same load-bearing check-run name (LLD 13) — no branch-protection bookkeeping.
      # npm ci installs the committed lockfile (mcp/package-lock.json); node_modules is
      # gitignored. Only dep is @modelcontextprotocol/sdk — negligible cost, no Chromium.
      - name: MCP server tests
        working-directory: mcp
        run: |
          npm ci
          node --test
```

Notes:
- `working-directory: mcp` scopes both commands to `mcp/`; equivalent to `cd mcp && npm ci &&
  node --test`.
- `node --test` (Node 20 built-in runner) auto-discovers `mcp/test/*.test.js`. Exit code is
  non-zero if any test fails, which fails the step and therefore the `validate` job / check-run.
- No `--prefix` or extra flags needed; the mcp `package.json` already defines `"test": "node
  --test"`, but calling `node --test` directly avoids an `npm run` indirection.

The `validate` job key and the surrounding steps are unchanged. No `permissions:` change (still
`contents: read`); `npm ci` reads the committed lockfile and installs from the public npm registry,
no secrets.

## State Model

No application state. CI-execution state only:

- **Ephemeral runner state.** `npm ci` populates `mcp/node_modules` inside the GitHub Actions
  runner for the job's lifetime; it is discarded when the job ends. Nothing is persisted or
  committed (`node_modules/` is gitignored).
- **Check-run reporting.** The step's pass/fail folds into the single `validate` check-run that
  GitHub reports on the PR. There is no new check-run and no new required-status-check context.
- **No caching (v1).** No `actions/cache` for the npm tree; the install is one small pure-Node
  dependency and caching adds config surface for negligible benefit. Can be revisited if CI time
  becomes a concern.

## Edge Cases

1. **`npm ci` without a lockfile.** `npm ci` fails hard (non-zero) if `mcp/package-lock.json` is
   absent or out of sync with `package.json`. This is desired — a missing/stale lockfile is a real
   defect and should fail the check. Lockfile is committed today (verified).
2. **SDK not installed → test #17 fails.** If the install step were skipped or failed,
   `mcp/src/server.js`'s import of `@modelcontextprotocol/sdk` throws and the import-boundary test
   fails. `npm ci` running before `node --test` prevents this in the normal path; if `npm ci`
   itself fails, the step fails there and `node --test` never runs (correct fail-fast).
3. **The drift guard fires (the intended case).** A `src/` edit that leaks a top-level DOM reference
   into a module `server.js` imports makes `import-boundary.test.js` fail → `node --test` exits
   non-zero → `validate` fails → PR blocked. This is M4 working as designed.
4. **npm registry outage during `npm ci`.** Transient network failure fails the step. Unlike the
   link check (which has retries and `--exclude-all-private`), no retry is added here; an install
   flake is rare and a re-run clears it. Acceptable for v1; revisit only if flaky.
5. **New mcp test files.** `node --test` auto-discovers `mcp/test/*.test.js`, so added test files
   are picked up with no ci.yml change.
6. **mcp dependency count grows.** Approach assumes mcp stays pure-Node (no Chromium/native build).
   If a future dep needs a system toolchain, the install cost/assumption must be revisited — flag at
   that time.
7. **Job timeout.** `validate` has `timeout-minutes: 10`. The mcp install + 38 tests run in seconds;
   well within budget. No change needed.

## Dependencies

All already exist in the repo — this LLD is additive to CI only:

- `.github/workflows/ci.yml` — the `validate` job with Node 20 already set up (the edit target).
- `mcp/package.json` + `mcp/package-lock.json` — committed; `npm ci` reproducible install.
- `mcp/test/*.test.js` — the 38-test suite (5 files: `convergence`, `feedback`,
  `import-boundary`, `io`, `mutators`), including `import-boundary.test.js`, the M4 guard.
- LLD 13 (CI workflow / status checks) — establishes `validate` as the single load-bearing
  check-run name and defers branch protection. This LLD relies on that and must not add a new job.
- LLD 32 M4 — the requirement this LLD fulfills.

No new npm packages, no repo-config changes beyond the single ci.yml step.

## Test Requirements

This change is itself CI plumbing; "tests" here means verifying the step behaves as specified.

**Manual / PR verification (before merge):**
- **Positive:** open the PR; confirm the `validate` check-run runs the "MCP server tests" step and
  that its log shows `npm ci` completing and `node --test` reporting `# tests 38 / # pass 38 /
  # fail 0`. (Locally, without `node_modules`, the suite reports 37/1 — the SDK-import failure —
  so a green 38/38 proves `npm ci` ran and the SDK resolved.)
- **Negative (guard fires):** on a scratch branch, introduce a top-level DOM reference (e.g.
  `document`) into a `src/js` module that `mcp/src/server.js` imports, push, and confirm
  `import-boundary.test.js` fails and the `validate` check-run goes red. Revert. This proves M4
  now gates the merge path — the exact regression class it was written to catch.
- **Negative (generic mcp regression):** temporarily break any one mcp assertion, push, confirm
  `validate` fails; revert.

**Integration:**
- Confirm the failing step actually fails the *job* (non-zero exit propagates to the check-run),
  not just prints an error — i.e. a red mcp suite blocks the PR.
- Confirm the existing `src/` steps (HTML validate, JS syntax, Playwright unit tests, link check)
  still pass unchanged and the check-run name remains `validate`.

No new automated test files are required; the mcp suite and `run-tests.mjs` already exist. The
deliverable is the ci.yml step plus the verification above.

