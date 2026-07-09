# LLD 38: Enable Auto-Merge on Green PR Validation (Full Autonomy)

## Scope

Close the final human checkpoint in the autonomous pipeline: once a PR's **GitHub-side**
CI checks go green, the PR **merges itself** with no human step. This is the end state for
floorplan; the same pattern rolls out to sibling danbing projects later (out of scope here).

**Covers (this LLD):**
1. **Branch protection** on `harennon/floorplan` `main`: add `required_status_checks =
   ["validate"]` **with `strict: false`** so a PR cannot merge while the CI `validate` job
   (LLD 13, `.github/workflows/ci.yml`) is red or absent. This is the trust anchor — auto-merge
   fires only on this GitHub-side check, never on the pipeline's own QA agent self-report.
   `strict: false` is a deliberate choice driven by batch shipping — see Approach §1.
2. **Enable repo auto-merge** (`allow_auto_merge = true`) and a **Ship-phase step** in
   `ship-issue.js` that turns on auto-merge for the PR it just opened
   (`gh pr merge --auto --squash --delete-branch`).
3. **Merge strategy decision:** squash merge (clean linear history on `main`), branch
   auto-deletes on merge (`delete_branch_on_merge = true` + `--delete-branch`).
4. **Visual-regression gating policy** (mandatory, decided here — see Approach §4):
   auto-merge is enabled for logic-only PRs; PRs touching render/layout paths keep a human
   glance until visual-diff coverage exists. This gate is enforced by ship-issue at
   auto-merge-enable time.
5. **A reversible kill switch** so auto-merge can be disabled instantly without code change.

**Explicitly does NOT cover:**
- **No changes to `ci.yml` or the test suite itself** (LLD 13 / issues #11, #17 — now closed).
  This LLD consumes the `validate` check; it does not redefine it.
- **No visual-diff / screenshot test harness.** That is the follow-up that would let
  render/layout PRs auto-merge; here we only gate them out. Tracked separately.
- **No cross-repo rollout** (weeks, danbing.app umbrella). floorplan only.
- **No change to the review/QA agent loop.** The in-pipeline reviewers still run; they are
  advisory to the pipeline, not the merge gate.
- **No merge-queue** (GitHub merge queue) — single-maintainer repo, low PR volume; native
  `--auto` is sufficient.

## Approach

### Current state (verified `2026-07-09`, `gh api repos/harennon/floorplan`)
- Repo is **public** (`"private": false`). So branch protection with required checks is
  available on the free plan — no plan-upgrade blocker (LLD 13's deferral no longer applies).
- `main` protection today: `required_pull_request_reviews.required_approving_review_count = 1`,
  **no `required_status_checks`** (404). So the `validate` check does *not* currently gate merge.
- `allow_auto_merge = false`, `delete_branch_on_merge = false`, `allow_squash_merge = true`.
- CI publishes exactly one check: **`validate`** (LLD 13, load-bearing job key).

### §1 Gate on the GitHub-side check, never the pipeline's self-report (the safety core)
Auto-merge is only safe because *GitHub* enforces the gate. We set on `main`:
`required_status_checks = { strict: false, contexts: ["validate"] }`. Because the gate lives
in **branch protection** (server-side), the pipeline's own QA/code-review agents physically
cannot merge a red PR — even if they wanted to. This is what prevents "the agent merging
itself": the agent has no path around GitHub's required check.

**Why `strict: false` (not `true`) — the batch-shipping constraint (resolves review BLOCKER).**
`strict: true` means "the PR branch must be up to date with `main` before the green check
counts." That directly breaks the primary entry point. `ship-batch.js` ships 2–3 issues
**sequentially** (`workflows/ship-batch.js` Phase 4 loop), and `ship-issue.js` **hands off
after arming `--auto` without waiting for the merge** (Phase 9). So a batch arms PR1, then arms
PR2. When PR1 squash-merges, `main` advances; under `strict: true` PR2 is now "not up to date,"
GitHub refuses to auto-merge it, and nothing in this design updates the branch — so N−1 of
every batch's PRs would stall open forever, requiring a human "Update branch" click. That
contradicts the issue's core "merges with no human action" criterion. `strict: false` lets
each armed PR merge on its own green check regardless of intervening merges to `main`.

**The staleness risk this accepts, and why it's acceptable here.** With `strict: false` a PR's
green `validate` reflects the tree *at its branch point*, not the post-merge `main`. Two PRs
that pass independently but conflict *semantically* (not textually) could both merge and break
`main`. This is bounded and tolerable for floorplan because: (a) it is a low-volume,
single-maintainer repo with a small module surface, so concurrent PRs touching interdependent
logic are rare; (b) textual conflicts are still caught — GitHub blocks a mergeable-state
conflict regardless of `strict`; (c) `main` is not release-critical (Cloudflare Pages
redeploys on every push and is trivially revertable); and (d) the kill switch (§5) plus a red
post-merge `validate` on `main` surface any breakage immediately. We explicitly prefer this
small, self-healing risk over the guaranteed batch-stall that `strict: true` produces. If the
repo ever becomes high-volume, the correct fix is GitHub's **merge queue** (out of scope,
noted in §Scope), not `strict: true` with a bespoke auto-update step.

**Remove the human review requirement.** Full autonomy means no required human PR review.
Set `required_pull_request_reviews = null` (drop the `required_approving_review_count: 1`).
Rationale: with a human approval still required, auto-merge could never fire unattended, which
defeats the issue's acceptance criterion ("merges with no human action"). The trust shifts
entirely onto the `validate` check plus the visual-gating policy in §4. **Tradeoff noted:**
this is the point of no return for logic PRs; the kill switch (§5) and the render-path gate
(§4) are the compensating controls. `enforce_admins` stays **false** so the maintainer retains
a manual break-glass merge/override path.

### §2 Native GitHub auto-merge, enabled per-PR by ship-issue
Two parts:
- **Repo setting:** `allow_auto_merge = true` (one-time, via `gh api ... -f allow_auto_merge=true`).
- **Per-PR trigger:** after `gh pr create` in the Ship phase of `ship-issue.js`, run
  `gh pr merge <pr> --auto --squash --delete-branch`. `--auto` tells GitHub to merge the PR
  automatically *once all required checks pass and no other protection blocks it*; if checks
  are already green it merges immediately, otherwise it waits. GitHub itself does the merge —
  the pipeline does not poll or re-merge.

*Alternative considered — a separate polling "merge-when-green" step in the workflow:*
rejected. It would re-implement what `--auto` does natively, add a long-lived poll that
conflicts with the cron bg-wait ceiling, and (worse) put merge authority back in the agent
instead of GitHub. Native `--auto` keeps GitHub as the sole merge actor.

### §3 Merge strategy: squash + auto-delete branch
- **Squash** (`--squash`): each shipped issue → one clean commit on `main`, matching the
  existing history style (recent commits are squash-style feature commits). Keeps `main`
  linear and bisectable. Disable merge-commit/rebase is *not* required, but squash is the
  default the pipeline requests explicitly.
- **Branch auto-delete:** set `delete_branch_on_merge = true` (repo) and pass
  `--delete-branch` (PR) so `lld-N-*` feature branches don't accumulate. ship-issue already
  removes the local worktree; this removes the remote branch on merge.

### §4 Visual-regression gating policy (decided here — NOT deferred)
Auto-merge removes the last human eye. Logic regressions (area/perimeter math, unit
conversion, snapping geometry) are covered by the headless `validate` suite (#17). **Visual /
layout regressions are not** — a unit test won't catch overlapping toolbars, a broken grid, or
a clipped HUD. floorplan is a visual tool, so this gap is material.

**Policy: auto-merge logic-only PRs; keep a human glance on render/layout PRs.**
Implemented as a decision in ship-issue's Ship phase, keyed off the PR's changed file set:

- **Render/layout paths (human-gated — do NOT enable auto-merge):** any changed file matching
  the render/layout surface. For floorplan this is:
  - `src/js/*Render.js` (`wallRender.js`, `symbolRender.js`, `clearanceRender.js`),
  - `src/js/grid.js`, `src/js/view.js`, `src/js/surface.js`, `src/js/hud.js`,
    `src/js/clearancePanel.js`, `src/js/help.js`,
  - **`src/js/exportImg.js`** — the standalone SVG/PNG rasteriser. It has its own palette,
    fonts, scale and layout (verified) and produces floorplan's **stated product wedge** (the
    shareable PNG/SVG export, per CLAUDE.md). The headless `validate` suite checks geometry,
    not appearance, so a visual regression here would auto-merge unseen. It is render-critical
    and MUST be human-gated.
  - **`src/js/dimEntry.js`** and **`src/js/symbolDimEntry.js`** — these position floating
    `<input>` overlays on the stage (screen-space layout via `worldToScreen`); a mispositioned
    or clipped inline editor is a visual/layout defect a unit test won't catch. Gated.
  - any `src/*.html`, and any `src/**/*.css`.

  These files draw or lay out UI; a green suite does not prove they look right.
- **Logic-only PRs (auto-merge eligible):** every changed file is outside the render/layout
  set above (e.g. `walls.js`, `measure.js`, `units.js`, `store.js`, `plan.js`, `share.js`,
  `exportJson.js`, `history.js`, `prefs.js`, docs, `.github/`, tests).

  **Accepted residual (behavioral-visual, not gated):** `src/js/interactions.js` owns
  pan/zoom/cursor state. It is behavioral-visual — a regression there degrades *feel*
  (e.g. jumpy zoom) but not correctness, and it draws nothing. It is intentionally left
  logic-classified (auto-merge eligible); this is accepted residual risk, consistent with
  Edge Case 5. Reversible via the kill switch if it bites.

When a PR is render-touching, ship-issue **skips** `gh pr merge --auto` and instead comments
on the PR that it needs a human visual check before merge, leaving it open. When it is
logic-only, ship-issue enables auto-merge. The classification is computed from
`git diff --name-only <base>...<head>` against the path list above.

*This gate is a policy stopgap, not a permanent design.* The exit criterion for lifting it is
a visual-diff/screenshot test wired into `validate` (separate issue); once that exists, the
render-path list can be emptied and all PRs auto-merge. Documented so the follow-up is explicit.

*Sequencing note (from selection guidance):* this LLD ships **after** the render-touching
feature currently in the batch (#31), so that feature goes through the existing human-gated
flow before the checkpoint is removed.

### §5 Reversibility (kill switch)
Auto-merge must be trivially disableable if it ever merges something bad:
- **Instant, no deploy:** `gh api -X PUT .../branches/main/protection ...` is reversible, but
  the fastest kill is `gh repo edit harennon/floorplan --enable-auto-merge=false` (flips
  `allow_auto_merge`), which stops *all* future auto-merges immediately; PRs with auto-merge
  already armed can be disarmed with `gh pr merge <pr> --disable-auto`.
- **Pipeline-level:** the ship-issue auto-merge step is gated behind a single config flag
  `autoMerge.enabled` in `.claude/project.json` (default consideration below). Setting it
  false makes ship-issue open PRs exactly as it does today (no `--auto`), with zero other
  behavioral change. This is the preferred day-to-day switch because it is in-repo, reviewable,
  and reverts cleanly.

Both the repo setting and the config flag are independent kill switches; either one off
disables auto-merge.

## Interfaces / Types

This is infra + workflow config, not an app module. The "interfaces" are: the GitHub API
calls that set protection/merge policy, the ship-issue Ship-phase contract, and the
`project.json` flag.

### A. One-time GitHub configuration (run once, by a human/maintainer with admin token)
Not committed code — an operational runbook. Exact calls:

```sh
# 1. Enable repo-level auto-merge + squash-only clean history + branch auto-delete
gh api -X PATCH repos/harennon/floorplan \
  -F allow_auto_merge=true \
  -F delete_branch_on_merge=true \
  -F allow_squash_merge=true

# 2. Make `validate` a required (non-strict) status check on main, and drop the
#    human-review requirement (full autonomy). Uses the full protection PUT.
gh api -X PUT repos/harennon/floorplan/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": false, "contexts": ["validate"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

The **load-bearing string** is `"validate"` — it must exactly match the job key in
`.github/workflows/ci.yml` (LLD 13). If CI's job is ever renamed, this context must change in
lockstep or every PR blocks forever (see Edge Cases).

### B. ship-issue Ship-phase contract (`danbing-automation/workflows/ship-issue.js`)
Reached via the symlink `.claude/workflows/ship-issue.js`. **This file lives in the
`danbing-automation` repo, not under floorplan's `.claude/` gated tree** — edited as a
separate commit in that repo. Additions to the existing Ship phase (Phase 9), after the
`gh pr create` succeeds:

1. Read `autoMerge` from the resolved `config` (project.json). If `autoMerge.enabled !== true`,
   behave exactly as today (open PR, stop). No `--auto`.
2. Classify the PR: compute changed files
   `git -C <wt> diff --name-only origin/<base>...HEAD`. If **any** path matches the
   render/layout list (`config.autoMerge.renderPaths`, default in §C), the PR is
   render-touching.
3. **Logic-only PR:** enable auto-merge —
   `gh pr merge <prUrl> --auto --squash --delete-branch`.
4. **Render-touching PR:** do NOT enable auto-merge. Comment on the PR:
   "Auto-merge withheld: this PR changes render/layout paths (`<matched files>`) which unit
   tests do not cover. A human should visually verify before merging." Leave PR open.

The Ship agent's `SHIP_SCHEMA` gains two fields so the workflow can log the outcome:

```js
autoMergeEnabled: { type: "boolean" },   // true if --auto was set
autoMergeWithheldReason: { type: ["string","null"] } // set for render-touching PRs
```

### C. project.json flag (`floorplan/.claude/project.json`)
New optional block (kill switch + policy data):

```jsonc
"autoMerge": {
  "enabled": true,                 // master switch; false → ship-issue opens PR as before
  "mergeMethod": "squash",         // passed to gh pr merge
  "deleteBranch": true,
  "renderPaths": [                 // render/layout surface → human-gated (see §4)
    "src/**/*.html", "src/**/*.css",
    "src/js/*Render.js",
    "src/js/grid.js", "src/js/view.js", "src/js/surface.js",
    "src/js/hud.js", "src/js/clearancePanel.js", "src/js/help.js",
    "src/js/exportImg.js",           // SVG/PNG export rasteriser (product wedge)
    "src/js/dimEntry.js", "src/js/symbolDimEntry.js"  // floating-input layout
  ]
}
```

Absent `autoMerge` block → treated as `enabled: false` (safe default; existing projects
unaffected). Editing `project.json` is a floorplan-repo change; it lives under `.claude/`,
which is a gated path — so this specific edit must be made by a human, not the autonomous
agent (the workflow's own `requiresHuman` gate covers this).

**Two human edits, one paired step (the pipeline cannot enable its own merge gate — by
design).** Turning auto-merge on requires *two* human-made changes that the autonomous
pipeline cannot make itself: (i) the gated `project.json` `autoMerge.enabled` flag here, and
(ii) the GitHub-side branch protection + repo settings in §A (the `ship-issue.js` step itself
lives in the `danbing-automation` repo, also outside floorplan's autonomy). These MUST be
applied as a **paired step, GitHub-side first**: enable the strict `validate` required check
and repo `allow_auto_merge` (§A) *before* flipping `autoMerge.enabled: true`. Flipping the
flag first would let ship-issue arm `--auto` on PRs with no server-side gate in place — the
exact "agent merges itself" failure this LLD exists to prevent. This mirrors the (b)-before-(c)
ordering warning in Dependencies.

## State Model

No application state. The relevant state is GitHub-side configuration and per-PR merge state:

- **Repo/branch config (persistent, GitHub-side):** `allow_auto_merge`,
  `delete_branch_on_merge`, and `main` branch-protection (`required_status_checks`, reviews).
  Set once; the source of truth is GitHub, mirrored/documented in this LLD's runbook. Changing
  it is a deliberate admin action (or the kill switch).
- **Per-PR merge state (transient, GitHub-managed):** once ship-issue calls
  `gh pr merge --auto`, GitHub holds the PR in an "auto-merge armed" state. GitHub watches the
  `validate` check on the head commit; on `success` + up-to-date + no blocking condition,
  GitHub performs the squash merge and deletes the branch. On `failure`, it stays armed and
  open (no merge). The pipeline does **not** persist or poll this — it hands off and exits.
- **project.json `autoMerge` flag (persistent, in-repo):** read at Ship time; never written by
  the pipeline. The one piece of merge policy the team controls in version control.
- **No new persisted state in the app, localStorage, or the URL hash.** floorplan's
  client-side-only invariant is untouched — this is purely CI/merge infra.

## Edge Cases

1. **CI check absent (never reported).** If a PR head commit produces no `validate` check at
   all (e.g. workflow file broken on that branch, Actions disabled), a required-status gate
   treats "missing" as not-satisfied → auto-merge does **not** fire, PR
   stays open. This is the desired fail-closed behavior and directly satisfies the acceptance
   criterion "a PR with a failing/absent check does NOT merge."
2. **CI red.** `validate` concludes `failure` → GitHub keeps the PR armed but unmerged. When a
   later push turns it green, GitHub merges then. Correct.
3. **Job rename drift.** If `ci.yml`'s job key changes from `validate`, the required context
   `["validate"]` will never be satisfied and **every** PR blocks forever. Mitigation: the LLD
   13 comment already marks `validate` load-bearing; add the same warning to the protection
   runbook. Detection: a PR that stays open with "Expected — Waiting for status to be reported"
   indefinitely is the signature.
4. **Non-required checks are irrelevant.** Only `validate` gates. If other checks are added
   later they must be explicitly added to `contexts` to gate; otherwise auto-merge ignores them.
5. **Render/layout PR misclassification (false negative).** A PR that visually regresses but
   touches only logic-classified files (e.g. a data change that alters what renders) could
   auto-merge. Accepted residual risk — the render-path list is conservative (includes all
   `*Render.js`, HTML, CSS, view/grid/hud/surface). The permanent fix is visual-diff tests
   (follow-up). Reversible via kill switch if it bites.
6. **Mixed PR (logic + render).** Any render-path match → treat the whole PR as
   render-touching (human-gated). Fail-safe toward a human glance.
7. **Auto-merge armed but branch protection later tightened.** If a human re-adds a required
   review after arming, GitHub simply won't merge until that condition is met too. No
   corruption; the PR waits.
8. **Branch behind `main` after a batch merge (the batch-concurrency case).** `ship-batch.js`
   arms 2–3 PRs, then earlier PRs merge and advance `main`, leaving later PRs behind. We use
   **`strict: false`** precisely so this does NOT block auto-merge: a behind-but-mergeable PR
   still merges on its own green `validate`, with no human "Update branch" click. See Approach
   §1 for the full rationale and the accepted semantic-staleness risk. The one case still
   blocked is a **textual merge conflict** — GitHub reports the PR "dirty"/not mergeable
   regardless of `strict`, so it stays open and armed until someone rebases; this is correct
   fail-safe behavior and expected to be rare on a low-volume repo.
9. **Kill switch mid-flight.** Disabling `allow_auto_merge` at the repo level does **not**
   auto-disarm already-armed PRs on all GitHub plans; to be certain, also run
   `gh pr merge <pr> --disable-auto` on any in-flight PR. Documented in the runbook.
10. **Squash message.** `--squash` uses the PR title/body as the squash commit message; ship-
    issue already writes a clean imperative PR title, so `main` history stays readable.
11. **Non-autonomous / human PRs.** A human-opened PR simply won't have `--auto` set by ship-
    issue; it merges the normal way once green (or the human arms auto-merge manually). The
    policy does not force auto-merge on PRs the pipeline didn't open.

## Dependencies

**Must already exist (all now satisfied):**
- **#17 — headless test suite as the PR gate.** CLOSED. `ci.yml` runs `run-tests.mjs` in
  headless Chromium as part of the `validate` job, including the "broken change fails the
  suite" property. Auto-merge's safety rests on this.
- **#11 — CI workflow + required status checks (LLD 13).** The `validate` job exists and
  reports on every PR/push. The one piece LLD 13 *deferred* — actually wiring
  `required_status_checks` into branch protection — is **done as part of this LLD** (§1), now
  unblocked because the repo is public (verified) so the plan-upgrade concern is moot.
- **Repo admin access** to set branch protection and repo merge settings (maintainer token).
- **`danbing-automation` repo write access** to add the Ship-phase auto-merge step to
  `ship-issue.js`.

**Ordering / sequencing:**
- Ship this LLD **after** the in-flight render-touching feature (#31) merges through the
  current human-gated flow (selection guidance), so the checkpoint is removed only after that
  change is verified.
- Configuration order at rollout: (a) enable `allow_auto_merge` + `delete_branch_on_merge`,
  (b) add the strict `validate` required check + drop required reviews, (c) add the ship-issue
  step + `project.json` flag. Doing (b) before (c) is safe (PRs just merge on green with no
  auto-arm yet); doing (c) before (b) is **not** (agent could arm auto-merge with no gate).

**Not blocked by / independent of:** the app code, localStorage/URL-hash design, Cloudflare
Pages deploy path (unchanged — Pages still deploys `src/` on push to `main` after merge).

**Follow-up this unblocks / requires later:** visual-diff/screenshot tests wired into
`validate`, which is the exit criterion for emptying `renderPaths` and auto-merging all PRs.

## Test Requirements

No unit tests (this is config + workflow wiring). "Testing" = proving the gate behaves on real
and deliberately-broken PRs, validated on scratch/throwaway PRs before trusting it.

**Acceptance-criteria verification (do these on real PRs):**
1. **Green PR auto-merges with no human action.** Open a logic-only PR whose `validate` passes;
   confirm ship-issue armed `--auto`, and GitHub squash-merges it and deletes the branch
   without any manual click.
2. **Red PR does NOT merge, stays open.** Push a change that fails the suite (e.g. break an
   assertion / introduce a JS syntax error). Confirm the PR arms auto-merge but stays open and
   unmerged while `validate` is red; confirm it merges once fixed to green.
3. **Absent-check PR does NOT merge.** Simulate a PR with no `validate` result reported; confirm
   the strict gate blocks merge (fail-closed).
4. **Merge fires only on the GitHub-side check, not pipeline self-report.** Confirm that even
   with the pipeline's own QA/code-review agents reporting APPROVED, a red/absent `validate`
   still blocks merge — the branch-protection gate is authoritative.

**Policy / classification:**
5. **Render-touching PR is human-gated.** A PR changing `src/js/wallRender.js`,
   **`src/js/exportImg.js`**, `src/js/dimEntry.js` (or any HTML/CSS or a `renderPaths` entry)
   → ship-issue withholds `--auto` and comments the visual-check notice; PR stays open.
   Include an explicit `exportImg.js`-only case, since the export image is the product wedge
   and the headless suite tests geometry, not appearance.
6. **Logic-only PR is auto-merge eligible.** A PR touching only `measure.js`/`units.js` → auto-
   merge armed. Confirm the classifier reads `git diff --name-only origin/base...HEAD` and the
   glob match is correct (including mixed-PR → treated as render-touching).

**Reversibility:**
7. **Config kill switch.** With `autoMerge.enabled: false`, ship-issue opens PRs exactly as
   before (no `--auto`), verified by inspecting the Ship-phase behavior.
8. **Repo kill switch.** `allow_auto_merge=false` stops new auto-merges; `--disable-auto`
   disarms an in-flight PR.

**Guardrails / invariants (by inspection):**
9. Only `validate` is in `required_status_checks.contexts`; `strict: false` (batch-safe, §1).
10. `enforce_admins: false` (maintainer break-glass preserved).
11. No change to `ci.yml`, the app, or the Cloudflare deploy path.
12. Squash is the merge method; branch auto-deletes on merge.
