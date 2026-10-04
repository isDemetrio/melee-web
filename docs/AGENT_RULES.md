# Working rules for AI agents in this repository

Read this before editing anything. It encodes constraints that have already been
established, so you do not have to rediscover them.

> This file is intentionally named `AGENT_RULES.md` rather than `AGENTS.md`: the
> latter is a protected agent-instruction file that requires explicit operator
> approval to create. Move the content there if you want it auto-loaded by Codex.

## Non-negotiable

1. **Never commit game data.** No `*.iso`, `*.gcm`, `*.dol`, `*.gci`, no
   `upstream/melee-unlocked/port/generated/`, no extracted disc filesystem. The repository is
   public (verified 2026-10-04, `docs/OPEN_QUESTIONS.md` Q11) and game data stays out of it all
   the same. If a task seems to require committing one of these, stop and write it to
   `docs/OPEN_QUESTIONS.md` instead.
2. **Never build on the operator's VPS.** It has 2 vCPU, 3.7 GB RAM, no compiler
   toolchain, no sudo, and no swap. Compiling the recompiled game there would take the
   machine down. All compilation happens in GitHub Actions or a Codespace.
3. **Never run `npm install`, `vite build`, `playwright install` or any bundler on the
   VPS.** Write source, commit, push, and let CI verify. Read CI results with
   `gh run view --log-failed`.
4. **Never modify `upstream/melee-unlocked` in place.** It is a pinned submodule. Port
   changes go in `patches/` as a patch series, or in a separate fork. Record the reason
   for every port change in `docs/PORT_CHANGES.md`.
5. **Do not change Slippi netcode logic or the recompiler to "fix" a desync** before the
   first divergent frame has been identified with the per-frame checksum oracle.

## Engineering rules

- One logical change per branch and per PR. Never mix renderer and networking work.
- Every claim in a document or PR description must name its evidence: a file path, a
  command, a measured number. "Should work" is not evidence.
- The native build is the reference for correctness. The checkpoint comparison
  (2400 CPU/RAM/ARAM hashes) is the oracle for determinism. Never relax it to make a
  test pass.
- Measure before optimising. Record numbers in `docs/PROGRESS.md`.
- Update `docs/PROGRESS.md` at the end of every working session: state, next step, open
  blockers. A new session must be able to resume from that file alone.
- Prefer the smallest dependency that does the job. The UI is TypeScript + Vite, no
  framework.

## Determinism rules (they are easy to violate silently)

- No `-ffast-math`, no `-mrelaxed-simd`.
- Never use host `libm` or JavaScript `Math.*` inside the simulation path.
- PowerPC `fmadd`/`fmsub` must be emulated exactly; never let the host compiler contract
  a multiply-add into an FMA.
- Never use `emscripten_sleep` or Asyncify in the simulation path.

## CI budget

**The repository is public, and this section said the opposite until 2026-10-04.** Verified that
day two ways: `gh api repos/isDemetrio/melee-web --jq .visibility` answers `public`, and the same
request **without a token** answers `200`, so the repository is readable anonymously. GitHub's own
billing documentation states the consequence — "The use of standard GitHub-hosted runners is free:
... In public repositories" (`docs.github.com/en/billing/concepts/product-billing/github-actions`,
"Free use of GitHub Actions", read that day) — and the runners this repository uses are standard
(`ubuntu-latest`, `ubuntu-24.04`, `ubuntu-24.04-arm`), so they consume no monthly allowance.
`wasm-probe.yml`'s arm64 job already said so (PR #88, "on this repository, which is public, a run
costs no minutes"); this file and `ci.yml` contradicted it.

The 2,000-minute figure was the allowance for a **private** repository, and this one has not been
one. Measured on 2026-10-01 while this section believed otherwise: 91 workflow runs in one day,
roughly 660 minutes — a third of a month — of which 24 were WASM core builds at 18–35 minutes each.
The minutes are not billed, and the discipline below is kept anyway, with its reasons restated: a
run that only repeats a run already in flight carries no new signal; a 60-minute job holds a queue
slot and a runner for an hour; a suite that cannot fail quickly delays the answer rather than the
bill. Two things that sentence does not settle, and that this file therefore does not claim:
whether artifact and cache **storage** for a public repository is free too (GitHub's page treats
storage as a separate line in the billing model, and this file did not verify it), and that a larger
or non-standard runner is billed whatever the repository's visibility — the same documentation's
runner-pricing page says it outright: "The larger runners are not free for public repositories".
What the correction changes is the reason to avoid an experiment: it is time and signal, never an
allowance that was not being spent.

- **Batch experiments into one build.** The module per dispatch is the expensive unit; the fixed
  costs (emsdk setup, the release guest compile gate, the Chromium run) are paid on every run.
- **Screen locally first.** `scripts/phase0/run_checkpoints.sh` runs the 2400 checkpoints against
  the Node module in about 75 s on the VPS and costs no CI minutes. CI is for the module that
  cannot be built locally, not for the first look.
- **Never leave two runs of one branch alive.** A pull-request push and a manual dispatch of the
  same commit build the same module twice. Cancel the duplicate.
- **The heavy build stays on the paths that need it.** Widening `phase0-build.yml`'s
  `pull_request.paths` to all of `scripts/phase0/**` once cost a 35-minute WASM build for an edit
  to the checkpoint comparator.
- **A file another workflow already reads on every pull request does not belong in that list.**
  `web/vite.config.ts` was in it because this workflow's spike step runs `npx vite build`; `ci.yml`
  has no path filter, runs the same build with the same config and the same two entries, and runs
  the browser tests, so the entry bought a 5m34s-5m47s WASM core build (runs `36965278604`,
  `36965993838`) for a pull request whose only file in the list was that one. What it protected was
  the spike page's own invariants, which `ci.yml`'s build guard (`dist/spike.html`) and
  `web/tests/unit/build-config.test.ts` now assert on every pull request, in seconds.
- **One run per push, not two.** A branch with an open pull request used to fire both the `push`
  and the `pull_request` events, so every push cost two full CI runs. `ci.yml` now triggers on
  pull requests and on pushes to `main` only.
- **`[skip ci]` in a delivery commit suppresses the pull-request checks for good.** The event never
  fires for that head commit, and neither a later empty commit nor closing and reopening the pull
  request brings the checks back — so the branch-protection gate blocks the merge on a commit whose
  CI is in fact green. PR #72 hit this: its delivery commit carried `[skip ci]`, the checks never
  appeared, and `ci.yml` had to be dispatched on the branch (`gh workflow run ci.yml --ref
  perf/frame-split`, run `37019777761`, all four jobs green) before the merge, which then needed
  `--admin` because GitHub had no check run to look at. Tell the delivering agent to **stop before
  the CI without skipping it**; "stop before CI" was read as "skip CI", which is the opposite.
- **If pull-request runs stop appearing, prove the commit green by dispatch and merge with `--admin`.**
  Between 13:47 and 16:54 on 2026-10-02 no pull-request event produced a run for **any** branch,
  while pushes to `main` and manual dispatches worked normally. GitHub's public status page reported
  no incident, the workflow states, triggers and repository permissions were all correct, and the
  minutes allowance cannot be the cause — precisely because the manual dispatches ran. Branch
  protection requires three of `ci.yml`'s jobs, so with no check run the merge is **blocked on a
  commit whose CI is green**: PR #72 and #73 were merged with `--admin` after
  `gh workflow run ci.yml --ref <branch>` proved the commit green (runs `37019777761`, `37021908717`).
  The events returned on their own at 16:54. **Remedy if it recurs**: add `push: branches: ['**']`
  to `ci.yml`. It was tested in PR #74 and it works, but while pull-request events are healthy it
  turns every push into two runs — the duplication the trigger comment warns about — so revert it
  once they report again.
- **A `type: boolean` workflow input needs a typed value, not `-f`.** `gh workflow run -f
  upload_module=true` sends the string `"true"`, the step's `if:` sees it as false, and the artifact
  upload is **skipped in silence** — the run still reports success and has no artifacts (run
  `37015365284`). Use the API with a typed field: `gh api -X POST
  .../actions/workflows/phase0-build.yml/dispatches -F ref=<branch> -F
  'inputs[upload_module]=true'` (run `37016378716`, upload succeeded).

## Secrets

Cloudflare and Supabase credentials live in CI secrets and Pages environment
variables. Never in the repo, never in a client bundle. The only credential the browser
may receive is a short-lived TURN credential minted by `/api/turn-credentials`.
