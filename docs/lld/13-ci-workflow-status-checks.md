# LLD 13: CI Workflow + (Deferred) Required Status Checks

## Scope

**Covers (this LLD / this PR):**
- A single GitHub Actions workflow `.github/workflows/ci.yml` in the **floorplan repo only**,
  running on pull requests to `main` (and on `push` to `main` so the default branch always has
  a status baseline).
- Static-asset validation over `src/`, dependency-light and fast:
  1. **HTML validation** of `src/*.html`.
  2. **JavaScript lint / syntax check** of `src/js/*.js` (ES modules).
  3. **Dead-link check** of internal/external links in `src/*.html`.
- The workflow **only lints/validates**. It publishes GitHub check runs that CI reporting can
  later gate on.

**Explicitly does NOT cover (out of scope / deferred):**
- **No build step and no deploy step.** Cloudflare Pages deploys `src/` directly; the
  static/no-build invariant is a hard constraint (CLAUDE.md "Deploy cheap"). The workflow must
  never emit build artifacts or a `dist/`, and must not touch deployment.
- **No branch-protection / `required_status_checks` change.** Wiring the new check names into
  branch protection is gated on an external GitHub-plan decision (Pro upgrade or making the repo
  public) and is deferred to the follow-up. This PR only makes CI *begin reporting* checks.
- **No cross-repo rollout.** `weeks`, `danbing.app`, and `danbing-automation` are untouched.
  Parity work for those repos is tracked separately.
- No new runtime dependency, no `package.json` committed to the repo root as a project manifest
  (the workflow may create an ephemeral one at CI time only — see Approach), no framework, no
  bundler.

## Approach

**One workflow, one job, one check name.** Add `.github/workflows/ci.yml` with a single job
`validate` running on `ubuntu-latest`. A single check keeps the deferred branch-protection
wiring trivial (one entry, `validate`) and the run fast (no cross-job scheduling). *Alternative:*
three jobs mirroring cardgamesimulator's `unit-tests`/`integration-tests`/`e2e-tests` naming —
**rejected**: those names describe test tiers floorplan does not have, and requiring three
non-applicable checks reintroduces exactly the "requiring non-existent checks blocks merges"
problem this issue exists to fix. floorplan reports its own honest check name.

**Triggers.** `pull_request` targeting `main` (the check the deferred protection will require) and
`push` to `main` (so the default branch always carries a green baseline and reruns after
squash-merge). No schedule, no other branches.

**Tooling — dependency-light, no committed manifest.** The runner already has Node and the GitHub
CLI; we lean on `npx` (ephemeral installs) and a pinned action, so nothing is added to the repo
root. Concretely:

1. **HTML validation** — `npx --yes html-validate@<pinned> "src/**/*.html"`. Config lives at
   `.github/html-validate.json` (a *lint config*, not a build artifact) so `index.html` and
   `tests.html` — which legitimately use inline `<script type="module">`, template literals, and
   `innerHTML` in the test harness — validate cleanly. Rules focus on structural correctness
   (unclosed tags, duplicate ids, invalid nesting, missing required attrs), not style.
2. **JS syntax check** — for each `src/js/*.js`, run `node --check --input-type=module` over the
   file via stdin. This parses each ES module for syntax errors with **zero dependencies** and no
   execution (safe: no `src/` code runs in CI). Using `--input-type=module` avoids adding a
   `{"type":"module"}` manifest to the repo. *Alternative:* full ESLint — richer, but needs a
   committed flat config and a heavier install for marginal value on a small vanilla codebase;
   deferred as a possible future enhancement.
3. **Dead-link check** — `lycheeverse/lychee-action@<pinned SHA>` over `src/**/*.html`. lychee is
   a fast single-binary Rust checker (no npm tree). It checks relative asset links and external
   URLs (e.g. the Google Fonts `<link>`), with a short timeout and retry. External failures are
   handled per Edge Cases (they must not flap the required check).

**No build, no deploy — enforced by omission and by review.** The workflow contains no
compile/bundle/minify step and no deploy step; it never writes to `src/` or produces a `dist/`.
Cloudflare Pages continues to deploy `src/` verbatim on push to `main`, entirely independent of
this workflow. This preserves the "static files only, no build step" principle.

**Browser test suite (`src/tests.html`) is intentionally not run in CI (this phase).** Executing
the in-page harness needs a headless browser (Playwright/Puppeteer download), which conflicts with
"fast and dependency-light." Noted as a candidate follow-up; not part of this check. (Flag for
reviewer: confirm lint-only CI is acceptable v1 given tests.html exists.)

**Pinning & permissions.** Third-party actions are pinned to a full commit SHA; `npx` tools pinned
to an exact version. The job declares least privilege `permissions: contents: read` (it only reads
the tree to lint it). No secrets are used.

## Interfaces / Types

Not a code module — the "interface" is the workflow contract: file paths, the trigger surface,
and the check name that downstream branch protection will reference.

**New files:**
- `.github/workflows/ci.yml` — the workflow.
- `.github/html-validate.json` — html-validate lint config (rule set + inline-script/template
  allowances so both HTML files pass). This is CI config, not a deploy artifact.

**Workflow contract (skeleton — implementer fills exact pinned versions/SHAs):**

```yaml
name: CI
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  validate:                 # <-- the single check-run name reported to GitHub
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
      - uses: actions/setup-node@<sha>        # provides node + npx
        with: { node-version: "20" }
      # 1. HTML validation
      - run: npx --yes html-validate@<ver> --config .github/html-validate.json "src/**/*.html"
      # 2. JS syntax check (ES modules, no execution, no deps)
      - run: |
          for f in src/js/*.js; do
            node --check --input-type=module < "$f" || exit 1
          done
      # 3. Dead-link check (single binary, pinned)
      - uses: lycheeverse/lychee-action@<sha>
        with:
          args: --no-progress --max-retries 2 --timeout 20 "src/**/*.html"
          fail: true
```

**Check name (the load-bearing string):** `validate`. When the deferred branch-protection follow-up
runs, `required_status_checks.contexts` (or `checks[].context`) for the floorplan repo gets exactly
`["validate"]`, strict/up-to-date enabled — mirroring how cardgamesimulator lists its own workflow's
check names.

## State Model

No application state — CI is stateless per run. Relevant "state" is the GitHub-side status the
workflow produces and how it relates to branch protection:

- **Per-run:** each PR/push spawns a `validate` check run. Its conclusion (`success`/`failure`)
  attaches to the head commit. This is the artifact the deferred protection change will consume.
- **Not persisted anywhere else:** no caches required (installs are ephemeral; caching `npx`/npm is
  an optional later optimization, not needed for correctness). No secrets, no deployment state.
- **Relationship to branch protection (deferred, documented for the follow-up):**
  - *Now:* protection on floorplan is **not yet applied** (blocked on the GitHub-plan decision for
    private repos). Merging this PR only starts CI reporting the `validate` check.
  - *Later (separate PR/op, gated on plan):* set floorplan branch protection to 1 PR review, no
    force-push, no deletions, Dependabot alerts ON, **and** `required_status_checks = ["validate"]`
    (strict). This closes the parity gap with cardgamesimulator without ever having required a
    non-existent check.
  - The issue stays **open** after this PR merges, tracking that blocked follow-up.

## Edge Cases

1. **External link flakiness (Google Fonts, etc.).** `src/index.html` links external
   `fonts.googleapis.com` / `fonts.gstatic.com`. A transient network failure must not red-flag the
   required check. Mitigate with lychee retries + timeout; if flakiness persists, restrict lychee to
   **internal/relative links only** (exclude external hosts) so the check reflects repo correctness,
   not third-party uptime. Preferred final posture: internal links fail the build; external link
   failures are tolerated/reported but non-fatal.
2. **`tests.html` legitimately uses `innerHTML` and inline module scripts.** html-validate must not
   flag these as errors — the config disables/relaxes the relevant rules (e.g. inline-script,
   `prefer-*` style rules) so both HTML files pass on structural grounds only.
3. **`node --check` and `import` statements.** ES modules with `import`/`export` parse fine under
   `--input-type=module`; `--check` does not resolve or execute imports, so a valid module with
   real imports passes without running any `src/` code. Confirm the loop `exit 1`s on the first
   syntax error (does not swallow failures).
4. **No files match a glob.** If `src/js/*.js` or `src/**/*.html` matched nothing (e.g. a future
   restructure), the step should fail loudly rather than pass vacuously — guard the JS loop so an
   empty glob is treated as an error, and confirm html-validate/lychee error on no-input.
5. **Fork PRs.** With `permissions: contents: read` and no secrets, fork PRs run safely; the check
   still reports. No write-scoped tokens are exposed.
6. **Workflow must not deploy or mutate `src/`.** Any step that writes into `src/`, produces a
   build artifact, or invokes a deploy is a hard violation of the no-build invariant — reviewer must
   reject. The spec contains none.
7. **Version drift in `npx --yes`.** Unpinned `latest` could change lint behavior across runs and
   cause spurious reds. Pin exact versions (html-validate) and full SHAs (actions) so results are
   reproducible.
8. **Check name stability.** The job key `validate` is the contract string for the deferred
   protection change. Renaming it later would silently break a future required-check config —
   document that the name is load-bearing.
9. **Long-running / hung link check.** lychee `--timeout` bounds per-link waits; add a job-level
   `timeout-minutes` (e.g. 10) so a hang can't block the queue indefinitely.

## Dependencies

- **Must exist first:** the floorplan repo with `src/*.html` and `src/js/*.js` (present). GitHub
  Actions enabled on the repo (default for GitHub repos).
- **External (CI-time only, not committed to repo as project deps):**
  - `actions/checkout`, `actions/setup-node` (pinned SHAs).
  - `html-validate` via `npx` (pinned version).
  - `lycheeverse/lychee-action` (pinned SHA).
  - Node 20 (runner-provided via setup-node).
- **Blocks the follow-up (out of scope here):** the GitHub-plan decision (Pro upgrade or make
  floorplan public) is a prerequisite for applying branch protection + `required_status_checks` to
  this private repo. That decision is tracked separately; do not attempt the protection change in
  this PR.
- **Reference for parity:** cardgamesimulator's `.github/workflows/ci.yml` and its branch-protection
  `required_status_checks` (the target shape to mirror, adapted to floorplan's single honest check).
- **Platform invariants preserved:** static `src/`, no build, no npm project manifest at repo root,
  no backend, Cloudflare Pages deploy path unchanged.

## Test Requirements

CI config has no unit tests of its own; "testing" means proving the workflow behaves correctly on
real and broken inputs. Verify before/at PR:

**Functional (the workflow does its job):**
- On the current clean `main`, the `validate` check runs and **passes** all three steps
  (HTML valid, JS parses, links resolve). This is the required-green baseline.
- Introducing a **malformed HTML** file (e.g. unclosed tag / duplicate id) under `src/` makes the
  HTML step **fail** the check.
- Introducing a **JS syntax error** in a `src/js/*.js` file makes the `node --check` step **fail**
  (and the loop exits non-zero on the first bad file).
- A **broken internal link** (e.g. `href` to a non-existent local asset) makes the link step
  **fail**.
- These negative cases are validated locally/in a scratch branch, not committed to `main`.

**Invariant / guardrail:**
- The workflow contains **no build step and no deploy step**, writes nothing into `src/`, and
  produces no artifacts — confirm by inspection.
- No `package.json` / lockfile is added to the repo root; no framework or bundler introduced.
- Actions pinned to SHAs and `npx` tools pinned to exact versions (reproducibility).
- Job declares `permissions: contents: read` only; uses no secrets.

**Robustness:**
- External-link flakiness does not fail the required check (retries/timeout, or external links
  excluded per Edge Case 1).
- `job.timeout-minutes` bounds total runtime; a hung link check cannot block indefinitely.
- Workflow completes fast (target: well under a couple of minutes) so it is a lightweight gate.

**Deferred follow-up (documented, not executed here):**
- When the GitHub-plan decision unblocks it, apply floorplan branch protection with
  `required_status_checks = ["validate"]` (strict) plus 1 review / no force-push / no deletions /
  Dependabot alerts ON, then confirm a PR cannot merge while `validate` is failing. Keep the issue
  open until then.
