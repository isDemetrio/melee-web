# Phase 0 — next steps: P0-09, P0-10 and the go/no-go

Written 2026-09-30 (12:20 UTC) for an executor that must not re-derive anything. Every path
below was opened and checked on that date; anything that could not be checked says
**not verified**. Paths are relative to the repository root
(`/home/hermes/projects/melee-web`) unless they start with `/`. Task numbers and thresholds
come from `docs/PHASE0_TASKS.md`; this file does not change them, it says how to reach them.

## 0. Where things stand (verified, with evidence)

| Fact | Evidence |
| --- | --- |
| The native reference boots, plays a match, and is reproducible | `docs/PROGRESS.md` "The first native run"; traces in `/home/hermes/.hermes/cache/scratch/melee-run4/trace.csv` and `melee-run5/trace.csv`, both SHA-1 `c79c53b9cdf81426fa0277e7497a69e55bc5f571`, 2401 lines, stdout ends `final scene: mode=2 state=2 match_frame=762 (retraces=2400)` |
| That reference was built from **main at 10:29 UTC** (patches 0001–0002 only, threaded DVD worker) | `gh run view 36702692761` → `workflow_dispatch`, `headBranch: main` |
| **PR #6 (`phase0/wasm-core`) is green**, including the WASM build | `gh pr checks 6`; run 36710111396: offline core compile+link **952 s**, release guest **1066 s**, Node smoke passed, `forbidden_libm_imports: []` |
| The WASM module is **87,117,533 bytes** — over the 25 MiB Pages per-file limit | same run, `wasm_report.py` output: `"within_pages_limit": false` (CI reports it, does not fail on it) |
| Compiler peak RSS in that build was **7,351,844 KiB** with `ninja_jobs=4` on a runner with `MemAvailable_KiB=6943488` | same run, "Numeric compilation report" |
| PR #7 (`phase0/checkpoint-comparator`, P0-03) is open against `main` and **contains PR #6's three commits** (cc4dbf3, 8c87403, b82d6cf) plus its own (8191755) | `git log --oneline`, `gh pr view 7 --json baseRefName` |
| `phase0-build.yml` is **not on `main`** yet, so it cannot be dispatched until PR #6 merges | `git show main:.github/workflows/phase0-build.yml` fails |
| The ISO is on this VPS at `/home/hermes/incoming/melee-ntsc102.iso` (1,459,978,240 bytes) | `ls -la /home/hermes/incoming/`; `docs/OPEN_QUESTIONS.md` Q1 |
| Node on this VPS: `/home/hermes/.local/bin/node`, **v22.22.3**; Python 3.14.7; `gh` at `/home/hermes/.local/bin/gh` | `which node; node --version; python3 --version` |
| Upstream pin `3aab7172db243c159afa76ecb2c564b3de8e4c0a` is checked out in the VPS submodule | `git submodule status` |
| No per-frame timing exists yet: there is no `--sim-times` or equivalent flag anywhere in `native/` | `grep -n sim-times native/*` → nothing; `native/headless_main.cpp:40-77` is the whole option parser |
| `scripts/phase0/run_checkpoints.sh` refuses a `.js` module (`test -x "$exe"`, line 25) and defaults to **the wrong script** `vs_match.txt` (line 19) | the file itself |
| The default Actions shell is `bash -e` **without** `pipefail` | run 36710111396 log: `shell: /usr/bin/bash -e {0}` |
| The service worker caches **every** same-origin `.js` and `.wasm` cache-first | `web/public/sw.js:42-46` |
| `web/` has no `package-lock.json`; CI runs `npm install` when it is missing | `ls web/package-lock.json` fails; `.github/workflows/ci.yml` "Install" step |

What the WASM core promises (`wasm/core/README.md`, `wasm/core/CMakeLists.txt`): the targets are
`melee_core_node` (`-sENVIRONMENT=node -sNODERAWFS=1 -sEXIT_RUNTIME=1`) and `melee_core_web`
(`-sENVIRONMENT=web,worker -sFORCE_FILESYSTEM=1 -sMODULARIZE=1 -sEXPORT_NAME=createMeleeCore
-sINVOKE_RUN=0`, exports `FS` and `callMain`), both grouped by the custom target
`melee_core_wasm`. The build products are `$RUNNER_TEMP/wasm/melee_core_node.{js,wasm}` and
`$RUNNER_TEMP/wasm/melee_core_web.{js,wasm}`. The executable is `native/headless_main.cpp`
and the rest of `native/core_sources.cmake`, compiled with emcc at `-O1` and
`MELEE_SINGLE_THREAD=1`. Nothing is uploaded: the workflow ends with
`# No guest-derived build products or caches are uploaded.`

## 1. Conventions used by every step

- **Branches and PRs.** One branch per step, created from an up-to-date `main`:
  `git checkout main && git pull --ff-only && git checkout -b <branch>`. Never push to `main`.
  Merge only when every check is green: `gh pr checks <N>` shows no `fail` and no `pending`.
  Merge command: `gh pr merge <N> --merge`.
- **Before every commit:** `python3 scripts/check_no_game_data.py` (staged index) and
  `python3 -m unittest discover -s scripts/tests -v` (pure Python, allowed on the VPS). Both
  must exit 0.
- **Nothing is compiled on the VPS.** No `cmake`, `emcc`, `npm`, `npx`, `vite`, `playwright`,
  Chromium. Python scripts, `bash -n`, `gh`, and *running* a CI-built binary against the ISO
  are the only execution allowed here.
- **Game-derived files live under `/home/hermes/incoming/phase0/`, never in the checkout.**
  That directory is created in S3. Traces are hashes, not game data, but they stay there too.
- **Shell state does not persist between tool calls.** Every VPS command block starts with
  `source /home/hermes/incoming/phase0/current.env` once that file exists (S3).
- **Long commands.** If your shell tool times out before 30 minutes, run the game with
  `nohup … &` and poll the console file (shown where needed). `gh run watch <id> --exit-status`
  can be replaced by polling `gh run view <id> --json status,conclusion`.
- **Reading CI failures:** `gh run view <run-id> --log-failed`.
- **Measured CI durations** (from runs 36710111396 and 36710111621): `phase0-build.yml` full PR
  run ≈ **40 min** (952 s offline core + 1066 s release guest + ~3 min setup);
  `phase0-native-headless.yml` ≈ **7 min**; `ci.yml` ≈ 2 min (runs twice per PR: `push` and
  `pull_request`); `phase0-recompile.yml` ≈ 2 min; `wasm-probe.yml` ≈ 1.5 min. All on the
  standard `ubuntu-24.04` runner; **no larger runner is needed for any step in this plan**
  except the conditional S11.

## 2. S0 — Land PR #6 and PR #7 (prerequisite for everything)

- **Files:** none.
- **Commands:**
  ```bash
  cd /home/hermes/projects/melee-web
  gh pr checks 6
  gh pr merge 6 --merge
  gh pr checks 7
  gh pr merge 7 --merge
  git checkout main && git pull --ff-only
  git show HEAD:.github/workflows/phase0-build.yml | head -3
  ```
- **Expected:** `gh pr checks 6` lists only `pass` (it did at 12:20 UTC; the `build` job of
  run 36710111396 finished `success`). After merging #6, PR #7's diff shrinks to commit
  8191755. The last command prints `name: Phase 0 — WASM core`.
- **Success:** both PRs `MERGED` (`gh pr view 6 --json state`, `gh pr view 7 --json state`),
  and `scripts/phase0/compare_checkpoints.py` exists on `main`.
- **Failure modes:**
  - PR #7 checks still `pending` (its own `phase0-build` run 36712930205 was in progress at
    12:14 UTC): wait for it; do not merge on pending.
  - PR #7 shows a merge conflict after #6: it should not (same commits); if it does,
    `git checkout phase0/checkpoint-comparator && git rebase origin/main && git push --force-with-lease`,
    then wait for CI again.
  - This file (`docs/PHASE0_NEXT.md`) is uncommitted in the working tree of
    `phase0/checkpoint-comparator`. Commit it on its own branch `docs/phase0-next` from
    `main` before starting S1 (`git stash`, switch, `git stash pop`), one PR, docs only.
- **Cost:** 0 extra CI minutes (the runs already happened). The docs PR costs ~4 min of
  `ci.yml`.

---

## 3. P0-09 — the WASM core under Node, against the native reference

### The route from CI to the machine with the ISO

The WASM build happens only in CI; the ISO exists only on this VPS; CI has no ISO (D1 open).
So the module must travel CI → VPS. The only mechanism that fits the existing rules is the
one already used for the native binary (`docs/PHASE0_TASKS.md` §4 D3, implemented in
`.github/workflows/phase0-native-headless.yml`): a **private Actions artifact**, produced
**only** by a manual `workflow_dispatch` with an opt-in boolean input, **retention 3 days**,
never produced by a pull request, downloaded with `gh run download` into
`/home/hermes/incoming/phase0/<commit>/`, outside the checkout. No new mechanism, no new
storage, no game data in git. **Operator dependency D3-W** (§8): the existing D3 decision
covers the native executable only. The minimal choice that unblocks P0-09 is to extend D3
with identical terms to the WASM module. S1 and S2 can be merged without it (the upload is
off by default); **S3 needs it**.

Why the native reference must be rebuilt too: the traces from 10:29 UTC came from a binary
without patches 0003–0007 and without the shared SHA-1 code. Comparing the WASM from today's
`main` with that binary would mix two variables. The oracle for P0-09 is a native binary
**built from the same commit** as the WASM module, in both threaded and single-thread
configurations (P0-08's own verification list asks for the single-thread comparison).

### S1 — PR `phase0/sim-times`: per-retrace simulation time, producer and consumer

Needed for the go/no-go (P0-10/P0-11) and requested by P0-09 as a proxy number. Adding it
**before** the S3 dispatch means the native and WASM binaries are built once, with it.
No upstream file changes, so no patch and no `docs/PORT_CHANGES.md` row.

**Definition (write it into the code comment):** `sim_ms` for retrace *n* is the
`std::chrono::steady_clock` time from the end of retrace *n−1*'s checkpoint bookkeeping
(state hash, digest, this file) to the start of retrace *n*'s. It therefore includes all
guest execution, interrupts, audio and DVD work, and excludes the 40 MiB of RAM+ARAM hashing
that `trace_state()` does every retrace (`native/headless_host.cpp:450-465`). Retrace 1
includes boot. `match_frame` is the raw value `host::current_scene` returns; the in-match
convention is `match_frame != 0`, the same test the script engine uses
(`native/headless_input.cpp:143`). Only meaningful with `--fast` (otherwise the sleep at
`native/headless_host.cpp:533-536` would be counted), so the option refuses to run without it.

**Files and exact edits:**

1. `native/headless.h` — after `extern std::string dol_path;` add
   `extern std::string sim_times_path;`
2. `native/headless_host.cpp`
   - after line 22 `std::string dol_path;` add `std::string sim_times_path;`
   - after line 30 `static FILE* g_state_digest = nullptr;` add
     ```cpp
     static FILE* g_sim_times = nullptr;
     static std::chrono::steady_clock::time_point g_sim_resume;
     ```
   - in `boot_setup()`, immediately after the `if (!options.state_trace.empty()) { … }` block
     that writes `retrace,cpu,ram,aram,events` (lines 235-239), add
     ```cpp
     if (!sim_times_path.empty()) {
       g_sim_times = std::fopen(sim_times_path.c_str(), "w");
       if (!g_sim_times) die("cannot open sim times");
       std::fprintf(g_sim_times, "retrace,sim_ms,match_frame\n");
     }
     ```
   - at the end of `boot_setup()`, after `g_next_frame = std::chrono::steady_clock::now();`
     (line 295), add `g_sim_resume = g_next_frame;`
   - immediately before the comment `// Same virtual-time and interrupt order as Windows retrace()`
     (line 527), add
     ```cpp
     // --sim-times: wall time spent simulating since the previous retrace finished its checkpoint
     // bookkeeping, so the 40 MiB of RAM/ARAM hashing below is never counted. --fast only.
     static void record_sim_time() {
       if (!g_sim_times) return;
       const auto now = std::chrono::steady_clock::now();
       uint32_t major = 0, minor = 0, match_frame = 0;
       current_scene(&major, &minor, &match_frame);
       std::fprintf(g_sim_times, "%u,%.4f,%u\n", g_retraces,
           std::chrono::duration<double, std::milli>(now - g_sim_resume).count(), match_frame);
       std::fflush(g_sim_times);
     }
     ```
   - in `retrace()`, replace
     ```cpp
       deliver_interrupt(24);
       trace_state();
       digest_state();
     ```
     with
     ```cpp
       deliver_interrupt(24);
       record_sim_time();
       trace_state();
       digest_state();
       if (g_sim_times) g_sim_resume = std::chrono::steady_clock::now();
     ```
     (`fflush` per row matters: the web build has no `EXIT_RUNTIME`, so stdio is not flushed
     at exit; `trace_state()` already flushes per row for the same reason.)
3. `native/headless_main.cpp`
   - usage string (line 21): change `"  [--state-trace PATH|-] [--state-digest PATH] [--card-dir PATH]\n"`
     to `"  [--state-trace PATH|-] [--state-digest PATH] [--card-dir PATH] [--sim-times PATH]\n"`
   - in the option loop, after the `--state-digest` line (59), add
     `else if (a == "--sim-times") host::sim_times_path = next();`
   - after the `if (check_dol) { … }` block (ends line 82), add
     ```cpp
     if (!host::sim_times_path.empty() && !o.fast) throw std::runtime_error("--sim-times requires --fast");
     ```
4. `native/README.md` — in the operator command, replace `vs_match.txt` with
   `parity_vs_onett.txt` and add `--sim-times /tmp/melee-reference/sim_times.csv`; one sentence
   with the definition above.
5. `scripts/phase0/frame_stats.py` — add an `--in-match` flag:
   - `parse_durations(text, in_match=False)`: when `in_match` is true the header must contain
     `match_frame` (else `ValueError('no match_frame column: --in-match needs a --sim-times CSV')`),
     and only rows whose `match_frame` parses as an integer > 0 are kept; if none remain,
     `ValueError('no in-match rows')`.
   - `main(argv)`: accept `frame_stats.py [--in-match] <durations.csv>` (usage error, exit 2,
     for anything else); add `"rows": "in-match"` or `"rows": "all"` to the JSON.
   - Update the module docstring's input/output description accordingly.
6. `scripts/tests/test_frame_stats.py` — add `test_in_match_keeps_only_positive_match_frame`
   (rows with match_frame 0,0,1,2,3 → count 3), `test_in_match_without_the_column_is_an_error`,
   `test_main_in_match_flag_reports_rows` (JSON has `"rows": "in-match"`), and keep every
   existing test passing (`run_main` still passes `['frame_stats.py', path]`).
7. `.github/workflows/phase0-native-headless.yml`, step "CLI and DOL smoke checks", append:
   ```bash
   "$exe" --help > "$RUNNER_TEMP/help.txt"
   grep -q -- '--sim-times' "$RUNNER_TEMP/help.txt"
   if "$exe" --iso missing.iso --frames 1 --sim-times "$RUNNER_TEMP/st.csv" > "$RUNNER_TEMP/st.log" 2>&1; then exit 1; fi
   grep -q -- '--sim-times requires --fast' "$RUNNER_TEMP/st.log"
   ```
8. `.github/workflows/phase0-build.yml`, step "WASM imports, sizes and Node smoke (no ISO)",
   append after the `grep -q 'cannot open ISO /nonexistent'` line:
   ```bash
   node "$RUNNER_TEMP/wasm/melee_core_node.js" --help > "$RUNNER_TEMP/help.txt"
   grep -q -- '--sim-times' "$RUNNER_TEMP/help.txt"
   if node "$RUNNER_TEMP/wasm/melee_core_node.js" --iso /nonexistent --frames 1 --sim-times "$RUNNER_TEMP/st.csv" > "$RUNNER_TEMP/st.log" 2>&1; then
     echo '--sim-times without --fast accepted'; exit 1
   fi
   grep -q -- '--sim-times requires --fast' "$RUNNER_TEMP/st.log"
   ```
   (Files, not pipes: the step shell has no `pipefail`, and `grep -q` closing a pipe early can
   kill `node` with SIGPIPE.)

**Local checks (VPS, allowed):**
```bash
cd /home/hermes/projects/melee-web
python3 -m unittest discover -s scripts/tests -v
python3 scripts/check_no_game_data.py
git diff --check
```
Expected: `OK` from unittest; the hygiene script exits 0; `git diff --check` prints nothing.

**CI verification:** `phase0-native-headless.yml` (triggered by `native/**`) and
`phase0-build.yml` (triggered by `native/**`, `scripts/phase0/**`) both green; `ci.yml`
"Unit tests for the hygiene gate" runs the new Python tests.

**Failure modes:**
- `error: 'current_scene' was not declared` — the helper was placed above `current_scene`
  (line 470); move it below `digest_state()`, directly above `retrace()`.
- A compile error about `std::chrono::duration<double, std::milli>` — add `#include <ratio>`
  (not expected: `<chrono>` includes it).
- Smoke grep fails on `--sim-times requires --fast` — the check was placed after
  `disc_open`; it must come before the `o.iso.empty()` check so it fires with a missing ISO.
- The step fails on `grep -q -- '--sim-times'` in help — the usage string edit is missing.

**Cost:** one PR ≈ 40 (build) + 7 (native) + 4 (ci ×2) ≈ **51 runner-minutes**, ~40 min wall.

### S2 — PR `phase0/wasm-artifact`: carry the module to the ISO, and run it there

**Files and exact edits:**

1. `.github/workflows/phase0-build.yml`
   - replace the bare `workflow_dispatch:` with
     ```yaml
     workflow_dispatch:
       inputs:
         upload_wasm:
           description: 'Upload the built core as a private artifact (game-derived; see docs/PHASE0_NEXT.md D3-W)'
           type: boolean
           default: false
     ```
   - on the step "Compile all 144 release guest TUs with emcc (P0-04)" add
     `if: ${{ !(github.event_name == 'workflow_dispatch' && inputs.upload_wasm) }}`
     (the release guest is not part of the executable; skipping it saves ~18 min per dispatch).
   - replace the final comment `# No guest-derived build products or caches are uploaded.`
     with a comment in the style of `phase0-native-headless.yml:51-55` and this step:
     ```yaml
     - name: Upload the WASM core (opt-in private artifact)
       if: ${{ github.event_name == 'workflow_dispatch' && inputs.upload_wasm }}
       uses: actions/upload-artifact@v4
       with:
         name: melee-core-wasm
         path: |
           ${{ runner.temp }}/wasm/melee_core_node.js
           ${{ runner.temp }}/wasm/melee_core_node.wasm
           ${{ runner.temp }}/wasm/melee_core_web.js
           ${{ runner.temp }}/wasm/melee_core_web.wasm
         retention-days: 3
         if-no-files-found: error
     ```
     It must stay **after** "WASM imports, sizes and Node smoke (no ISO)" and "Repository
     hygiene", so nothing is uploaded that failed the smoke.
2. `.github/workflows/phase0-native-headless.yml`
   - under `workflow_dispatch.inputs`, add
     ```yaml
     single_thread:
       description: 'Build with -DMELEE_SINGLE_THREAD=ON (the configuration the WASM core uses)'
       type: boolean
       default: false
     ```
   - `concurrency.group`: `native-headless-${{ github.ref }}-${{ inputs.single_thread || false }}`
     (otherwise the second dispatch in S3 cancels the first: `cancel-in-progress: true`).
   - in "Build Linux headless executable", add to the `cmake -S native …` line:
     `-DMELEE_SINGLE_THREAD=${{ inputs.single_thread && 'ON' || 'OFF' }}`
     (`native/CMakeLists.txt:29` declares the option; on `pull_request` the input is empty, so OFF).
   - upload step: `name: melee-core-headless${{ inputs.single_thread && '-st' || '' }}`.
3. `scripts/phase0/run_checkpoints.sh`
   - line 19: default script becomes `upstream/melee-unlocked/port/scripts/parity_vs_onett.txt`;
     add a comment that `vs_match.txt` ends in a menu for `--no-slippi` builds
     (`docs/PHASE0_TASKS.md` P0-08).
   - usage comment: `<exe>` may also be an Emscripten Node module ending in `.js`, run with
     `${NODE:-node}`.
   - replace line 25 (`test -x "$exe" || …`) with
     ```bash
     case "$exe" in
       *.js) test -f "$exe" || { echo "no such module: $exe" >&2; exit 1; }
             launch=("${NODE:-node}" "$exe") ;;
       *)    test -x "$exe" || { echo "not executable: $exe" >&2; exit 1; }
             launch=("$exe") ;;
     esac
     repo=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
     case "$(realpath -m "$out")" in
       "$repo"/*) echo "output directory is inside the repository: $out" >&2; exit 1 ;;
     esac
     ```
   - in the run line, `nice -n 10 "$exe" \` becomes `nice -n 10 "${launch[@]}" \`, and after
     `--state-trace "$out/trace.csv"` add `--sim-times "$out/sim_times.csv"`.
   - after `head -2 "$out/trace.csv" …`, add
     ```bash
     echo "trace sha1:  $(sha1sum "$out/trace.csv" 2>/dev/null | cut -d' ' -f1)"
     grep -h '^final scene:' "$out/stdout.log" || echo 'final scene: MISSING'
     grep -h '^FPSCR requests:' "$out/stdout.log" || echo 'FPSCR requests: MISSING'
     ```
4. `docs/PHASE0_NEXT.md` — no change; `docs/PHASE0_TASKS.md` §4 D3 — append one paragraph
   "Extended on <date> to the WASM core (D3-W), same terms" **only if** the operator has
   answered D3-W; otherwise leave it and note the pending decision in the PR description.

**Local checks:** `bash -n scripts/phase0/run_checkpoints.sh` (syntax only), plus the two
Python commands from S1. A refusal-path check that runs nothing heavy:
```bash
cd /home/hermes/projects/melee-web
scripts/phase0/run_checkpoints.sh /nonexistent.js /home/hermes/incoming/melee-ntsc102.iso /tmp/rc-test; echo "status $?"
scripts/phase0/run_checkpoints.sh /bin/true /home/hermes/incoming/melee-ntsc102.iso ./inside-repo; echo "status $?"
```
Expected: `no such module: /nonexistent.js` / `status 1`; then
`output directory is inside the repository: ./inside-repo` / `status 1`. Neither reads the ISO.

**CI verification:** `actionlint` in `ci.yml` "Validate workflow files" passes; both heavy
workflows green on the PR (the upload steps show as *skipped* on `pull_request`, which is
correct).

**Failure modes:**
- actionlint: `property "upload_wasm" is not defined in object type {}` — the input block is
  mis-indented under `workflow_dispatch`.
- actionlint complains about `inputs.single_thread` in `concurrency` — use
  `${{ github.event.inputs.single_thread || 'false' }}` instead (same meaning).

**Cost:** ≈ 40 + 7 + 2 + 4 ≈ **53 runner-minutes**.

### S3 — Dispatch, then download to the VPS (needs D3-W)

After S1 and S2 are merged. All three dispatches run from `main`, so all three artifacts come
from one commit.

```bash
cd /home/hermes/projects/melee-web
git checkout main && git pull --ff-only
mkdir -p /home/hermes/incoming/phase0/reference-2026-09-30
cp /home/hermes/.hermes/cache/scratch/melee-run4/trace.csv /home/hermes/.hermes/cache/scratch/melee-run4/stdout.log /home/hermes/incoming/phase0/reference-2026-09-30/
sha1sum /home/hermes/incoming/phase0/reference-2026-09-30/trace.csv
date -u +%FT%TZ
gh workflow run phase0-build.yml --ref main -f upload_wasm=true
```
Expected: `c79c53b9cdf81426fa0277e7497a69e55bc5f571` (this preserves the old reference; the
scratch cache is pruned — `/home/hermes/.hermes/cache/scratch/.last_prune` exists).
Then, repeating until the newest entry has a `createdAt` later than the `date` printed above:
```bash
gh run list --workflow phase0-build.yml --event workflow_dispatch --limit 1 --json databaseId,headSha,status,createdAt
```
Write the ids down as they appear (one dispatch at a time, so each `--limit 1` is unambiguous):
```bash
echo "WASM_RUN=$(gh run list --workflow phase0-build.yml --event workflow_dispatch --limit 1 --json databaseId -q '.[0].databaseId')" > /home/hermes/incoming/phase0/current.env
gh workflow run phase0-native-headless.yml --ref main -f upload_binary=true -f single_thread=false
# wait until the newest workflow_dispatch run of phase0-native-headless.yml is the new one, then:
echo "NATIVE_RUN=$(gh run list --workflow phase0-native-headless.yml --event workflow_dispatch --limit 1 --json databaseId -q '.[0].databaseId')" >> /home/hermes/incoming/phase0/current.env
gh workflow run phase0-native-headless.yml --ref main -f upload_binary=true -f single_thread=true
# wait likewise, then:
echo "NATIVE_ST_RUN=$(gh run list --workflow phase0-native-headless.yml --event workflow_dispatch --limit 1 --json databaseId -q '.[0].databaseId')" >> /home/hermes/incoming/phase0/current.env
cat /home/hermes/incoming/phase0/current.env
```
Expected: three distinct numeric ids. Wait for all three:
```bash
source /home/hermes/incoming/phase0/current.env
gh run watch "$NATIVE_RUN" --exit-status
gh run watch "$NATIVE_ST_RUN" --exit-status
gh run watch "$WASM_RUN" --exit-status
```
Then download and pin the commit:
```bash
source /home/hermes/incoming/phase0/current.env
SHA=$(gh run view "$WASM_RUN" --json headSha -q .headSha)
for r in "$NATIVE_RUN" "$NATIVE_ST_RUN"; do test "$(gh run view "$r" --json headSha -q .headSha)" = "$SHA" && echo "run $r same commit" || echo "COMMIT MISMATCH run $r"; done
D=/home/hermes/incoming/phase0/${SHA:0:12}
gh run download "$WASM_RUN" -n melee-core-wasm -D "$D/wasm"
gh run download "$NATIVE_RUN" -n melee-core-headless -D "$D/native"
gh run download "$NATIVE_ST_RUN" -n melee-core-headless-st -D "$D/native-st"
chmod +x "$D/native/melee_core_headless" "$D/native-st/melee_core_headless"
mkdir -p "$D/runs"
printf 'SHA=%s\nD=%s\n' "$SHA" "$D" >> /home/hermes/incoming/phase0/current.env
ls -la "$D/wasm" "$D/native" "$D/native-st"
```
- **Expected:** `same commit` twice; `$D/wasm` holds `melee_core_node.js`,
  `melee_core_node.wasm` (≈87 MB), `melee_core_web.js`, `melee_core_web.wasm`; each native
  directory holds `melee_core_headless` (≈30 MB unpacked; the 10:29 one was 30,821,536 bytes).
- **Failure modes:**
  - `gh workflow run` → `HTTP 422 … Unexpected inputs provided` — the S2 input is not on `main`
    (S2 not merged) or the name is misspelled.
  - `could not find any workflow named phase0-build.yml` — S0 not done.
  - `COMMIT MISMATCH` — something merged between dispatches. Delete `$D`, re-dispatch the
    mismatched workflow, do not proceed with mixed commits.
  - `no artifact matches any of the names or patterns provided` — the dispatch ran with the
    input false, or the run failed before the upload step (`gh run view <id> --log-failed`).
  - A run fails in "Compile and link…" with `Killed` / `signal 9` — memory (the build peaked
    at 7.0 GiB with 4 jobs): lower the cap in "Budget compilation from available memory" from
    `4` to `2` in a PR, and re-dispatch. Only if that also fails, D2.
- **Cost:** ≈ 22 min (WASM, release step skipped) + 2 × 7 min (native) ≈ **36 runner-minutes**,
  ~22 min wall (they run in parallel). Artifacts: ≈ 20–40 MB zipped for the WASM (**not
  verified**; the native one was 8,320,754 bytes zipped), expiring after 3 days.

### S4 — Five runs on the VPS

One game process at a time, nothing else heavy running (global rule: one heavy agent at a
time). Check memory first; stop if `available` in `free -m` is below 1200 MB.

```bash
source /home/hermes/incoming/phase0/current.env
cd /home/hermes/projects/melee-web
free -m
scripts/phase0/run_checkpoints.sh "$D/native/melee_core_headless" /home/hermes/incoming/melee-ntsc102.iso "$D/runs/native-1" 2400 upstream/melee-unlocked/port/scripts/parity_vs_onett.txt
```
Repeat with `native-2` (same binary), then `native-st-1` with
`"$D/native-st/melee_core_headless"`. Then the WASM module, in the background:
```bash
source /home/hermes/incoming/phase0/current.env
cd /home/hermes/projects/melee-web
nohup scripts/phase0/run_checkpoints.sh "$D/wasm/melee_core_node.js" /home/hermes/incoming/melee-ntsc102.iso "$D/runs/wasm-node-1" 2400 upstream/melee-unlocked/port/scripts/parity_vs_onett.txt > "$D/runs/wasm-node-1.console" 2>&1 &
```
Poll with `tail -4 "$D/runs/wasm-node-1.console"` until a line `exit status:` appears; then
the same for `wasm-node-2`. Always run from the repository root: the script path is relative,
and under `NODERAWFS` it resolves against the current directory.

- **Expected, every run:**
  ```
  disc image verified: 1459978240 bytes, sha1 d4e70c064cc714ba8400a849cf299dbd1aa326fc
  exit status: 0
  wall clock:  …s for 2400 requested frames
  trace rows:  2401 (header included)
  retrace,cpu,ram,aram,events
  …
  trace sha1:  <40 hex digits>
  final scene: mode=2 state=2 match_frame=762 (retraces=2400)
  FPSCR requests: RN=<n> NI=<n> (non-x86 observation only)
  ```
  Native: ~54 s. WASM under Node: **not measured**; expect minutes (the 1800 s ceiling in
  `run_checkpoints.sh` is the hard stop).
- **Failure modes and actions:**
  - `unknown option: --sim-times` — the binary predates S1; the download is from the wrong run.
  - `CompileError` / `WebAssembly.instantiate` / an error mentioning exceptions — this Node
    cannot run the module (CI ran it with the runner's Node; this VPS has v22.22.3). **Do not
    install anything.** Record the exact message and stop; it is an operator question.
  - `FATAL: cannot open ISO` from the WASM run only — `NODERAWFS` path handling; confirm the
    ISO path is absolute (it is, above) and record the message. 64-bit seeks under
    `NODERAWFS` are **not verified** (offsets here are < 4 GiB, `disc_read` takes `uint32_t`).
  - `FATAL: cannot load script` — the run was not started from the repository root.
  - `RangeError` / `Cannot enlarge memory` / the process killed — VPS memory; check `free -m`,
    make sure no other game process or build is running, retry once.
  - `exit status: 124` — hit the 1800 s ceiling. Retry once with `RUN_TIMEOUT=5400` in front
    of the command; if it still times out, record the last `retrace` in `trace.csv`.
  - `final scene: mode=1 state=0 …` — the script desynchronised (the `vs_match.txt` symptom);
    check that the fifth argument is `parity_vs_onett.txt`.
  - `guest stopped before requested checkpoints` or `OSLoadContext reached top level` — record
    the last retrace and stop; this is a boot-path defect, not a comparison result.
- **Cost:** 0 CI minutes; VPS ≈ 3 min native + WASM time (unknown).

### S5 — The comparison (the P0-09 criterion)

```bash
source /home/hermes/incoming/phase0/current.env
cd /home/hermes/projects/melee-web
python3 scripts/phase0/compare_checkpoints.py "$D/runs/native-1/trace.csv" "$D/runs/native-2/trace.csv"; echo "A $?"
python3 scripts/phase0/compare_checkpoints.py "$D/runs/native-1/trace.csv" "$D/runs/native-st-1/trace.csv"; echo "B $?"
python3 scripts/phase0/compare_checkpoints.py "$D/runs/wasm-node-1/trace.csv" "$D/runs/wasm-node-2/trace.csv"; echo "C $?"
python3 scripts/phase0/compare_checkpoints.py "$D/runs/native-st-1/trace.csv" "$D/runs/wasm-node-1/trace.csv"; echo "D $?"
python3 scripts/phase0/compare_checkpoints.py "$D/runs/native-1/trace.csv" "$D/runs/wasm-node-1/trace.csv"; echo "E $?"
python3 scripts/phase0/compare_checkpoints.py /home/hermes/incoming/phase0/reference-2026-09-30/trace.csv "$D/runs/native-1/trace.csv"; echo "F $?"
python3 scripts/phase0/frame_stats.py --in-match "$D/runs/wasm-node-1/sim_times.csv"
python3 scripts/phase0/frame_stats.py --in-match "$D/runs/native-1/sim_times.csv"
```
- **Expected:** A–E each print
  `identical: 2400 retraces, ['retrace', 'cpu', 'ram', 'aram', 'events'] all equal` and
  `… 0`. F is informational (old binary vs new): expected identical, a difference is a
  finding about patches 0003–0007, recorded but not a blocker. Each `frame_stats` prints
  JSON with `"rows": "in-match"` and a `count` near 762 (≥ 700); fewer means the match did
  not start where it did at 10:29 UTC.
- **P0-09 passes** when A, B, C, D and E all exit 0 and all five `final scene` lines are
  identical. That is `docs/PHASE0_TASKS.md` P0-09's "2400/2400 identical, no tolerance".
- **Diagnosis when something exits 1** (stop at the first that applies; `docs/AGENT_RULES.md`
  rule 5 forbids touching the recompiler or netcode before the first divergent retrace is
  known and written down):
  1. **A fails** — native is not reproducible at this commit. Stop. Compare with F's first
     difference; suspect PR #6's changes. Nothing else is meaningful until A passes.
  2. **B fails** — patch 0005 changes guest timing on native. This is a P0-08 failure. D can
     still be evaluated (WASM uses the single-thread configuration), but Phase 0's first
     criterion is not met until B passes or the operator accepts the single-thread native as
     the reference (D10).
  3. **C fails** — the WASM run is not deterministic (uninitialised memory, a wall-clock
     leak). Stop; record the first difference.
  4. **D fails with A, B, C passing** — a real platform divergence. The column says where to
     look: `events` → host event/DVD completion order; `aram` → AX/audio DMA; `ram` with equal
     `cpu` → a store (NaN payloads, FP store rounding); `cpu` → registers (FP rounding; if the
     WASM `FPSCR requests:` line shows `RN` or `NI` > 0, non-default rounding was requested and
     is not emulated off x86, patch 0004). Then get the gameplay digest up to the divergence,
     with `R` = the retrace number the comparator printed:
     ```bash
     source /home/hermes/incoming/phase0/current.env
     cd /home/hermes/projects/melee-web
     R=<retrace printed by the comparator>
     for v in native wasm; do rm -rf "$D/diag/$v"; mkdir -p "$D/diag/$v/card"; done
     "$D/native-st/melee_core_headless" --iso /home/hermes/incoming/melee-ntsc102.iso --headless --fast --frames $((R+1)) --time-base 1 --volume 0 --script upstream/melee-unlocked/port/scripts/parity_vs_onett.txt --card-dir "$D/diag/native/card" --state-trace "$D/diag/native/trace.csv" --state-digest "$D/diag/native/digest.csv" > "$D/diag/native/stdout.log" 2>&1
     node "$D/wasm/melee_core_node.js" --iso /home/hermes/incoming/melee-ntsc102.iso --headless --fast --frames $((R+1)) --time-base 1 --volume 0 --script upstream/melee-unlocked/port/scripts/parity_vs_onett.txt --card-dir "$D/diag/wasm/card" --state-trace "$D/diag/wasm/trace.csv" --state-digest "$D/diag/wasm/digest.csv" > "$D/diag/wasm/stdout.log" 2>&1
     diff "$D/diag/native/digest.csv" "$D/diag/wasm/digest.csv" | head -20
     ```
     Write R, the column, both cell values, the digest diff and the two FPSCR lines into
     `docs/PROGRESS.md` and a new entry in `docs/OPEN_QUESTIONS.md`. The fix is a separate,
     later task; it is not part of this plan.
- **Recording (always, pass or fail):** PR `phase0/p0-09-result`, docs only:
  `docs/PROGRESS.md` gets a section "P0-09 — WASM under Node against native (<date>)" with:
  the commit `$SHA`; the three run ids; the table of A–F results; the five trace SHA-1s; the
  five `final scene` and `FPSCR requests` lines; wall-clock per run; both `frame_stats`
  JSONs labelled **"proxy: Node on a 2-vCPU VPS, not a go/no-go device"**; and one sentence
  that P0-09 ran on the VPS instead of a CI job because D1 is unanswered (a deliberate
  deviation from `docs/PHASE0_TASKS.md` P0-09 "Files"). Cost ≈ 4 CI minutes.

---

## 4. P0-10 — `spike.html` in a Web Worker, with the checkpoint comparison in the browser

### What exists and is reused

- `melee_core_web` is already linked with `FS` and `callMain` exported, `INVOKE_RUN=0`,
  `FORCE_FILESYSTEM=1` (`wasm/core/CMakeLists.txt`). It is a classic script today (no
  `EXPORT_ES6`), and it has no WORKERFS.
- `web/vite.config.ts` already sets `worker.format: 'es'`; `web/tsconfig.json` already has
  `"WebWorker"` in `lib`; `web/scripts/serve.mjs` is a zero-dependency static server that
  applies `web/public/_headers` (COOP/COEP → `crossOriginIsolated`); `web/playwright.config.ts`
  is the template for a Playwright config. There is **no** existing worker or core loader in
  `web/src` (`grep -rn Worker web/src` finds only the service worker).
- The oracle semantics are `scripts/phase0/compare_checkpoints.py` and
  `scripts/phase0/frame_stats.py`. The browser gets a TypeScript port for display; **the
  Python tools stay authoritative** (S9 recomputes everything from the raw CSVs).

### Design decisions (made here, so the executor does not)

- **Module worker + `-sEXPORT_ES6=1`.** A module worker cannot `importScripts`; with
  `EXPORT_ES6` the worker does `import('/spike-core/melee_core_web.js')` and gets the factory
  as `default`. Emscripten locates the `.wasm` next to the `.js` via `import.meta.url`.
- **The disc is read with WORKERFS** (`-lworkerfs.js`), mounted from the `File` the user
  picked; reads happen on demand through `FileReaderSync`, so the 1.4 GB image is never
  copied into WASM memory and never leaves the device. Not MEMFS preload (SPEC step 5): the
  file list is unknown and 1.4 GB does not fit.
- **The core, its metadata and the input script live in `/spike-core/`**, a directory that
  exists only in the page built by `phase0-build.yml`. `ci.yml` builds and (if credentials
  ever appear) deploys the shell, and it will contain `spike.html` but **no core** — the
  87 MB module could not be deployed to Pages anyway (25 MiB limit).
- **One run per Worker.** `callMain` with `EXIT_RUNTIME=0` leaves static state behind; the page
  creates a fresh Worker per run and terminates it afterwards.
- **One result file per run**: `spike-result-<UTC timestamp>.json`, containing the raw trace
  and sim-times CSVs plus metadata. One file is harder to mislabel than three.
- **The service worker must not touch `/spike-core/`** (`web/public/sw.js:42-46` would cache
  the core cache-first, then serve a stale core after the next build).

### S6 — PR `phase0/spike-harness`

**Files:**

1. `wasm/core/CMakeLists.txt` — in `target_link_options(melee_core_web PRIVATE …)` add
   `-sEXPORT_ES6=1` and `-lworkerfs.js`. Nothing else changes (JS glue only; the compiled code
   and the Node variant are untouched).
2. `web/spike.html` (new): a plain page with
   `<input id="iso" type="file">`, `<input id="reference" type="file" accept=".csv">`,
   `<button id="run">Run</button>`, `<p id="core"></p>`, `<p id="status"></p>`,
   `<pre id="log"></pre>`, `<pre id="stats"></pre>`, `<p id="compare"></p>`,
   `<a id="download" hidden>result JSON</a>`, and
   `<script type="module" src="/src/spike/main.ts"></script>`. No shell CSS, no service
   worker registration.
3. `web/src/spike/compare.ts` (new), pure functions, no DOM:
   - `export const TRACE_HEADER = ['retrace', 'cpu', 'ram', 'aram', 'events'];`
   - `export function compareTraces(left: string, right: string): { identical: boolean; leftRows: number; rightRows: number; differences: number; first: { retrace: string; row: number; column: string; left: string; right: string } | null }`
     — the same rules as `compare_checkpoints.py` `load()`/`compare()`: header must equal
     `TRACE_HEADER` exactly, blank lines skipped, every row 5 cells (else `throw new Error`),
     cell-by-cell comparison, `row` counts the header (first data row is 2), each extra row in
     the longer file counts as one difference.
   - `export function nearestRank(values: number[], fraction: number): number` —
     `sorted[max(0, ceil(fraction·n) − 1)]`, numeric sort.
   - `export function simTimeStats(csv: string, inMatch: boolean)` → `{ count, mean_ms, p95_ms, p99_ms, max_ms, slowest_index, percentile: 'nearest-rank', unit: 'ms', rows: 'in-match' | 'all' }`,
     reading the `retrace,sim_ms,match_frame` header from S1; `inMatch` keeps rows with
     `match_frame > 0`; throws on no rows.
4. `web/tests/unit/spike-compare.test.ts` (new; picked up by the existing vitest include
   `tests/unit/**/*.test.ts`): identical traces; one changed cell reports retrace, column and
   `row`; truncated trace is a difference; wrong header throws; short row throws;
   nearest-rank known answers identical to `scripts/tests/test_frame_stats.py:32-48`;
   in-match filter keeps only `match_frame > 0`.
5. `web/src/spike/worker.ts` (new). The whole file:
   ```ts
   // P0-10 spike worker: loads the offline core once, runs one simulation synchronously, and
   // posts back the checkpoint trace and per-retrace simulation times. One run per Worker.
   interface CoreFS {
     mkdir(path: string): void;
     writeFile(path: string, data: string): void;
     readFile(path: string, options: { encoding: 'utf8' }): string;
     mount(type: unknown, options: { files: File[] }, mountpoint: string): void;
     filesystems: Record<string, unknown>;
   }
   interface MeleeCore { FS: CoreFS; callMain(args: string[]): number }
   type CoreFactory = (options: { print(line: string): void; printErr(line: string): void }) => Promise<MeleeCore>;

   const CORE = '/spike-core/';
   const scope = self as unknown as DedicatedWorkerGlobalScope;
   const lines: string[] = [];
   const log = (line: string): void => { lines.push(line); scope.postMessage({ type: 'log', line }); };

   /** Smallest observable step of performance.now(): the resolution every sim_ms is quantised to. */
   function timerResolutionMs(): number {
     let best = Number.POSITIVE_INFINITY;
     let last = performance.now();
     for (let i = 0; i < 200_000; i++) {
       const now = performance.now();
       if (now > last) { best = Math.min(best, now - last); last = now; }
     }
     return best;
   }

   scope.onmessage = async (event: MessageEvent<{ iso: File; frames: number }>) => {
     const { iso, frames } = event.data;
     try {
       const head = await fetch(`${CORE}melee_core_web.js`, { method: 'HEAD' });
       const type = head.headers.get('content-type') ?? '';
       if (!head.ok || !type.includes('javascript')) {
         throw new Error(`no core at ${CORE} (HTTP ${head.status}, ${type}); it is built only by phase0-build.yml`);
       }
       const meta = (await (await fetch(`${CORE}core.json`)).json()) as { commit: string; opt: string };
       const script = await (await fetch(`${CORE}parity_vs_onett.txt`)).text();
       const factory = ((await import(/* @vite-ignore */ `${CORE}melee_core_web.js`)) as { default: CoreFactory }).default;
       const resolution = timerResolutionMs();
       const core = await factory({ print: log, printErr: log });
       scope.postMessage({ type: 'core', commit: meta.commit, opt: meta.opt });
       const fs = core.FS;
       fs.mkdir('/disc');
       fs.mount(fs.filesystems['WORKERFS'], { files: [iso] }, '/disc');
       fs.mkdir('/work');
       fs.mkdir('/work/card');
       fs.writeFile('/work/script.txt', script);
       // The same arguments as scripts/phase0/run_checkpoints.sh, so traces compare one to one.
       const args = ['--iso', `/disc/${iso.name}`, '--headless', '--fast', '--frames', String(frames),
         '--time-base', '1', '--volume', '0', '--script', '/work/script.txt', '--card-dir', '/work/card',
         '--state-trace', '/work/trace.csv', '--sim-times', '/work/sim_times.csv'];
       const started = performance.now();
       const exitCode = core.callMain(args);
       const wallMs = performance.now() - started;
       const read = (path: string): string => { try { return fs.readFile(path, { encoding: 'utf8' }); } catch { return ''; } };
       scope.postMessage({
         type: 'done', exitCode, wallMs, coreCommit: meta.commit, coreOpt: meta.opt,
         timerResolutionMs: resolution, crossOriginIsolated: scope.crossOriginIsolated,
         finalScene: lines.find((line) => line.startsWith('final scene:')) ?? null,
         trace: read('/work/trace.csv'), simTimes: read('/work/sim_times.csv'),
       });
     } catch (error) {
       scope.postMessage({ type: 'error', message: String(error) });
     }
   };
   ```
6. `web/src/spike/main.ts` (new). Behaviour, in order:
   - URL parameters: `frames` (default `2400`), `nosizecheck` (present → skip the size check).
   - If `navigator.serviceWorker?.controller` is non-null, show in `#status`:
     `a service worker controls this page: use a private window` (a stale cached core would
     invalidate the run).
   - On `#run` click: require a file in `#iso`; unless `nosizecheck`, refuse with
     `refused: disc image is <n> bytes, expected 1459978240` when `file.size !== 1459978240`
     (the core itself then checks the DOL SHA-1 inside the image, `native/headless_host.cpp:190-200`;
     hashing 1.4 GB in a phone browser is not attempted).
   - Create `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`, post
     `{ iso: file, frames }`, set `#status` to `running…`.
   - On `log`: append the line to `#log`. On `core`: `#core` = `core loaded: <commit> <opt>`.
     On `error`: `#status` = `error: <message>`, terminate the Worker.
   - On `done`: terminate the Worker; `#status` = `exit <exitCode>`; compute
     `simTimeStats(simTimes, false)` and `simTimeStats(simTimes, true)` (skip on empty CSV) into
     `#stats`; if `#reference` has a file, `compareTraces(await reference.text(), trace)` →
     `#compare` = `identical: 2400 retraces` or `DIFFERENT: first retrace <r> column <c>`;
     build the JSON below and expose it in `#download` as
     `spike-result-<new Date().toISOString() with ':' replaced by '-'>.json`.
   - Result JSON (schema `melee-spike-result/1`), every field required:
     `schema, created, core_commit, core_opt, user_agent, cross_origin_isolated,
     timer_resolution_ms, frames, iso_bytes, exit_code, final_scene, wall_ms, trace_csv,
     sim_times_csv, stats_all, stats_in_match, comparison` (`comparison` and the stats may be
     `null`).
7. `web/vite.config.ts` — add `import { fileURLToPath } from 'node:url';` and, inside `build`,
   ```ts
   rollupOptions: {
     input: {
       main: fileURLToPath(new URL('./index.html', import.meta.url)),
       spike: fileURLToPath(new URL('./spike.html', import.meta.url)),
     },
   },
   ```
8. `web/public/sw.js` — after the `/api/` early return (line 39), add
   `if (url.pathname.startsWith('/spike-core/')) return;` with a one-line comment: the spike
   core is rebuilt per commit and must never be served from cache.
9. `web/playwright.spike.config.ts` (new): copy of `web/playwright.config.ts` with
   `testDir: './tests/spike'`, `timeout: 120_000`, one project (chromium), `baseURL`
   `http://127.0.0.1:4175`, and a single `webServer`
   `node scripts/serve.mjs --dir "${process.env.SPIKE_DIST}" --port 4175`
   (url `http://127.0.0.1:4175/spike.html`). At the top:
   `if (!process.env.SPIKE_DIST) throw new Error('SPIKE_DIST must point at a page built by phase0-build.yml');`
   The default `web/playwright.config.ts` (`testDir: './tests/e2e'`) never sees these tests,
   so `ci.yml` is unaffected.
10. `web/tsconfig.json` — add `"playwright.spike.config.ts"` to `include`.
11. `web/tests/spike/spike.spec.ts` (new), one test: `page.goto('/spike.html?nosizecheck&frames=1')`;
    `setInputFiles('#iso', { name: 'synthetic.iso', mimeType: 'application/octet-stream', buffer })`
    where `buffer` is 0x440 bytes, `GALE01` at offset 0, zeros elsewhere; click `#run`; expect
    `#core` to contain `core loaded`, `#status` to contain `exit 1`, `#log` to contain
    `FATAL: cannot read full Melee DOL`; and
    `page.evaluate(() => self.crossOriginIsolated)` to be `true`. Why that message: `disc_open`
    accepts any readable 0x440-byte header (`native/headless_host.cpp:104-114`), then
    `boot_setup` → `load_dol_from_disc` → `disc_has_vanilla_dol` cannot read 0x4385E0 bytes
    and calls `die("cannot read full Melee DOL")` (`:196`), which prints `FATAL: …` and exits 1.
    This proves: the module loads in a Worker, WORKERFS serves a `File`, the arguments parse,
    the script loads, and `callMain` returns the exit code.
12. `.github/workflows/phase0-build.yml`
    - `paths:` add `'web/spike.html'`, `'web/src/spike/**'`, `'web/tests/spike/**'`,
      `'web/playwright.spike.config.ts'`, `'web/public/sw.js'`, `'web/vite.config.ts'`.
    - after "WASM imports, sizes and Node smoke (no ISO)", **in the same job** (never a second
      job fed by an artifact), add:
      ```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Build the spike page around the web core (P0-10)
        working-directory: web
        run: |
          set -euo pipefail
          if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
          npx tsc --noEmit
          npx vite build --outDir "$RUNNER_TEMP/spike-dist" --emptyOutDir
          mkdir -p "$RUNNER_TEMP/spike-dist/spike-core"
          cp "$RUNNER_TEMP/wasm/melee_core_web.js" "$RUNNER_TEMP/wasm/melee_core_web.wasm" "$RUNNER_TEMP/spike-dist/spike-core/"
          cp "$GITHUB_WORKSPACE/upstream/melee-unlocked/port/scripts/parity_vs_onett.txt" "$RUNNER_TEMP/spike-dist/spike-core/"
          printf '{"commit":"%s","opt":"-O1"}\n' "$GITHUB_SHA" > "$RUNNER_TEMP/spike-dist/spike-core/core.json"
      - name: Spike harness in Chromium with a synthetic disc header (no ISO)
        working-directory: web
        env:
          SPIKE_DIST: ${{ runner.temp }}/spike-dist
        run: |
          set -euo pipefail
          npx playwright install --with-deps chromium
          npx playwright test -c playwright.spike.config.ts
      ```
    - after the S2 upload step, add a second opt-in upload:
      ```yaml
      - name: Upload the spike page with its core (opt-in private artifact)
        if: ${{ github.event_name == 'workflow_dispatch' && inputs.upload_wasm }}
        uses: actions/upload-artifact@v4
        with:
          name: melee-spike-dist
          path: ${{ runner.temp }}/spike-dist
          retention-days: 3
          if-no-files-found: error
      ```
13. `docs/PROGRESS.md` — record the MEMFS-preload deviation (WORKERFS instead), as
    `docs/PHASE0_TASKS.md` P0-10 requires.

**Local checks:** only the Python ones from S1 and `git diff --check`. TypeScript, vitest and
Playwright run in CI only.

**CI verification:** `ci.yml` "Web shell" typechecks and runs the new vitest file, builds
both pages; `ci.yml` "Browser tests" unchanged and green; `phase0-build.yml` new steps green;
`wasm-probe.yml` green (it triggers on `wasm/**` and must not move).

**Failure modes:**
- `#core` never says `core loaded`, console shows a MIME error — `/spike-core/…` fell through
  to `serve.mjs`'s SPA fallback (`index.html`); the copy step did not run or used another dir.
- `Cannot use import statement outside a module` / `default is not a function` —
  `-sEXPORT_ES6=1` is missing from the web link line.
- `Cannot read properties of undefined (reading 'mount')` or `WORKERFS` undefined —
  `-lworkerfs.js` missing, or `FS.filesystems` has no `WORKERFS` on emsdk 4.0.23 (**not
  verified**). Fallback: add `'WORKERFS'` to `-sEXPORTED_RUNTIME_METHODS` and mount
  `core.WORKERFS`.
- `#status` shows `exit 0` or an exception instead of `exit 1` — `callMain`'s handling of
  `_Exit` under `EXIT_RUNTIME=0` differs from the expected "returns the status" (**not
  verified**). Accept a thrown `ExitStatus` by catching it in the worker and reading `.status`.
- `tsc` errors in `worker.ts` about `postMessage` needing two arguments — the `scope` cast is
  missing; never call `self.postMessage` directly (DOM and WebWorker libs are both loaded).
- Vite warns `The above dynamic import cannot be analyzed` — the `/* @vite-ignore */`
  comment is missing (warning only).
- `npm install` step slow or flaky — expected without a lockfile; `ci.yml` has the same
  behaviour. Do not commit a lockfile in this PR.

**Cost:** one PR ≈ 40 + 6 (npm, Chromium, test) + 1.5 (probe) + 4 ≈ **52 runner-minutes**.

### S7 — The first real browser run (operator's desktop, not the VPS)

Chromium is forbidden on this VPS, and serving from here would need the page exposed to the
network. The operator's own computer serves the page to itself (and to the phone in S9) with
the repository's zero-dependency server.

1. After S6 is merged, on the VPS: `gh workflow run phase0-build.yml --ref main -f upload_wasm=true`,
   record the run id as in S3 (`SPIKE_RUN`), wait for success.
2. On the operator's computer (it needs `gh`, `node` ≥ 18 and a checkout of this repository;
   no `npm install`):
   ```bash
   gh run download <SPIKE_RUN> --repo isDemetrio/melee-web -n melee-spike-dist -D ~/melee-spike
   node web/scripts/serve.mjs --dir ~/melee-spike --port 4173
   ```
   Expected: `serving /home/<user>/melee-spike on http://127.0.0.1:4173 with _headers (4 rules)`.
3. In desktop Chrome, a **private window** (no service worker from earlier visits), open
   `http://127.0.0.1:4173/spike.html`, pick the ISO, pick
   `/home/hermes/incoming/phase0/<SHA12>/runs/native-1/trace.csv` (copied from the VPS) as the
   reference **only if the spike core's commit equals `$SHA` from S3** (`#core` prints it);
   otherwise use no reference and compare in S9.
4. Expected: `#core` `core loaded: <commit> -O1`, `#status` `exit 0`, `#log` ends with
   `final scene: mode=2 state=2 match_frame=762 (retraces=2400)`, `#compare`
   `identical: 2400 retraces`, `#stats` in-match `count` ≈ 762. Download the JSON.
- **Failure modes:** `refused: disc image is …` — wrong file; `crossOriginIsolated: false` in
  the JSON — the page was not served by `serve.mjs` with `_headers`; the tab crashes
  ("Aw, Snap") — memory for compiling an 87 MB module; record it (it is itself a result for
  the go/no-go); any `DIFFERENT` — apply S5's diagnosis with the browser trace in place of
  `wasm-node-1`.
- **Cost:** one dispatch ≈ 28 runner-minutes (release step skipped); artifact ≈ the WASM
  artifact's size, 3-day retention.

---

## 5. The go/no-go: command, output, thresholds

### The criterion, made mechanical

From `docs/PHASE0_TASKS.md` §1, applied to **in-match retraces** (`match_frame > 0` in the
`--sim-times` CSV — the frames that matter for the rollback budget; menus are excluded), with
`sim_ms` as defined in S1 (hashing excluded), nearest-rank percentiles, **three repeats per
device, the worst repeat counts**:

| Verdict | Condition (all numbers in ms) | Exit code |
| --- | --- | --- |
| **NO-GO** | any trace (Node, desktop, phone) differs from the same-commit native reference in any cell; **or** phone mean > 6; **or** phone p99 > 12; **or** desktop mean > 4 | 1 |
| **GO** | every trace identical; phone mean ≤ 3; phone p99 ≤ 6; desktop mean ≤ 1.5 | 0 |
| **DESKTOP-ONLY** | not NO-GO, not GO, and desktop mean ≤ 1.5 (the phone is in the 3–6 / 6–12 band) | 3 |
| **REVIEW** | not NO-GO, not GO, and desktop mean in (1.5, 4] — a band the specification does not cover (D8) | 4 |
| input error | fewer than 3 desktop or 3 phone results; any result with `exit_code ≠ 0`, `frames ≠ 2400`, `iso_bytes ≠ 1459978240`, `final_scene` not starting `final scene: mode=2`, `timer_resolution_ms > 0.1`, fewer than 700 in-match rows, or a `core_commit` different from `--reference-commit` | 2 |

"Unexplained" in the specification is not machine-checkable, so the tool treats **every**
difference as NO-GO; an explanation can only be recorded by the operator in
`docs/PHASE0_REPORT.md`, next to the tool's output, never by relaxing the tool.

### S8 — PR `phase0/go-no-go`: the tool

- **Files:** `scripts/phase0/go_no_go.py` (new), `scripts/tests/test_go_no_go.py` (new).
- **Interface:**
  ```
  go_no_go.py --reference NATIVE_TRACE.csv --reference-commit SHA
              --desktop R1.json R2.json R3.json [...]
              --phone   R1.json R2.json R3.json [...]
              [--node-trace TRACE.csv ...]
  ```
  `argparse` with `nargs='+'` for the lists. Imports `compare_checkpoints` and `frame_stats`
  from `scripts/phase0/` the way the tests do (`importlib.util.spec_from_file_location`), so
  the thresholds use exactly the comparator and percentile code the rest of Phase 0 uses.
  For each JSON: validate the fields in the table above; write `trace_csv` to a temporary file
  and call `compare_checkpoints.compare(reference, tmp)`; compute
  `frame_stats.stats(frame_stats.parse_durations(sim_times_csv, in_match=True))`. Per class
  take the maximum `mean_ms` and maximum `p99_ms` over its repeats. Thresholds as named
  constants at the top: `PHONE_MEAN_GO = 3.0`, `PHONE_P99_GO = 6.0`, `DESKTOP_MEAN_GO = 1.5`,
  `PHONE_MEAN_NOGO = 6.0`, `PHONE_P99_NOGO = 12.0`, `DESKTOP_MEAN_NOGO = 4.0`,
  `MIN_REPEATS = 3`, `MIN_IN_MATCH_ROWS = 700`, `MAX_TIMER_RESOLUTION_MS = 0.1`.
  Output: one JSON object on stdout (every run with its file, user agent, identity result,
  in-match stats; the per-class worst values; `verdict`; `reasons` as a list of strings;
  `provisional: true` when `core_opt` is `-O1` and the verdict is not GO — see S11), then a
  last line `VERDICT: <GO|NO-GO|DESKTOP-ONLY|REVIEW>`. Exit codes as in the table.
- **Tests (synthetic, no game data):** one test per verdict row, each input-error rule, the
  "worst repeat counts" rule, and a mismatched `core_commit`.
- **Verification:** `python3 -m unittest discover -s scripts/tests -v` on the VPS and in
  `ci.yml`.
- **Cost:** ≈ 4 runner-minutes (`ci.yml` only; `scripts/phase0/**` also triggers
  `phase0-build.yml`, ≈ 40 more — unavoidable with the current path filter, do not edit the
  filter to dodge it).

### S9 — Device runs (P0-11), then the verdict

1. Devices (D5): at least Chrome on the operator's desktop and Chrome on a mid-range Android
   phone. Safari macOS/iOS are recorded if available but are not in the verdict.
2. Delivery (D4, minimal choice): the operator's computer runs `serve.mjs` as in S7; the
   Android phone reaches it by **USB port forwarding** (desktop Chrome
   `chrome://inspect/#devices` → *Port forwarding* → `4173` → `localhost:4173`, phone opens
   `http://localhost:4173/spike.html`). `localhost` is a secure context, so the phone also gets
   `crossOriginIsolated` and a fine timer. No deployment, no Cloudflare, no public URL.
3. The ISO must be on the device's local storage to be picked (D7). It is read in place and
   never uploaded.
4. Three runs per device, each in a fresh private tab, nothing else running, phone plugged in
   and screen on. Download each `spike-result-….json`.
5. Copy all JSONs to the VPS under `/home/hermes/incoming/phase0/devices/<device>/`
   (e.g. `desktop-chrome/`, `android-chrome/`).
6. The verdict:
   ```bash
   source /home/hermes/incoming/phase0/current.env
   cd /home/hermes/projects/melee-web
   python3 scripts/phase0/go_no_go.py \
     --reference "$D/runs/native-1/trace.csv" --reference-commit "$SHA" \
     --desktop /home/hermes/incoming/phase0/devices/desktop-chrome/*.json \
     --phone /home/hermes/incoming/phase0/devices/android-chrome/*.json \
     --node-trace "$D/runs/wasm-node-1/trace.csv" "$D/runs/wasm-node-2/trace.csv"
   echo "exit $?"
   ```
   `--reference-commit "$SHA"` is correct only if the spike artifact (S7) was built from the
   same commit as S3's. If `main` moved in between, redo S3–S5 at the spike's commit first;
   otherwise the tool exits 2 on the commit check, by design.
7. **Expected output:** the JSON, then `VERDICT: …` and the matching exit code. That output
   goes verbatim into `docs/PHASE0_REPORT.md` (P0-12), with the device table (mean, p95, p99,
   max, timer resolution, user agent) taken from the JSON.
- **Failure modes:** exit 2 with `timer_resolution_ms` — the page was not cross-origin
  isolated (opened by LAN IP instead of `localhost`); exit 2 with in-match rows < 700 — the
  run did not reach the match (check `final_scene`); the phone tab crashes — record it: a
  core that cannot load on the phone is a phone NO-GO datum by itself.
- **Cost:** 0 CI minutes; operator time ≈ 6 runs × (load + run) per device.

### S10 — Recording the decision (P0-12)

PR `phase0/report`: `docs/PHASE0_REPORT.md` (new) with the S9 output, the P0-09 table, the
compile/link numbers (952 s offline, 1066 s release, 87,117,533-byte module, peak RSS), the
FPSCR lines, and the verdict; `docs/PROGRESS.md` updated in the same PR. ≈ 4 CI minutes.

### S11 — Conditional: a non-GO verdict measured on `-O1` is provisional

Both cores are compiled at `-O1` for CI affordability (`wasm/core/CMakeLists.txt`,
`target_compile_options(core_options INTERFACE -O1 …)`). If S9 returns anything but GO, the
tool marks it `provisional`, and before the report calls it final: one PR adding a cache
variable `MELEE_OPT` (default `-O1`) used in both the compile and link options of
`core_options`, a `workflow_dispatch` choice input `opt` (`-O1`, `-O2`) in `phase0-build.yml`
passed as `-DMELEE_OPT=…` to the emcmake configure of `$RUNNER_TEMP/wasm`, and `core.json`
written with the chosen level. Then S7 and S9 again with `-O2`, **and** S4–S5 for the `-O2`
Node module (a different code generation must pass the checkpoints again). Cost: unknown
compile time; `-O1` already peaked at 7.0 GiB with 4 jobs, so start `-O2` with the job cap at
2 and expect it may need D2 (a larger runner).

---

## 6. Order and total cost

| Step | Needs | Runner-minutes (≈) | VPS work |
| --- | --- | --- | --- |
| S0 merge #6, #7 (+ docs PR) | green checks | 4 | none |
| S1 `phase0/sim-times` | S0 | 51 | Python tests |
| S2 `phase0/wasm-artifact` | S0 (independent of S1; merge both before S3) | 53 | Python tests, `bash -n` |
| S3 dispatch + download | S1, S2, **D3-W** | 36 | download ≈ 100 MB |
| S4 five runs | S3 | 0 | ≈ 3 min native + WASM (unknown) |
| S5 compare + record | S4 | 4 | Python |
| S6 `phase0/spike-harness` | S0 (S1 for `--sim-times`) | 52 | none |
| S7 first browser run | S6, **D3-W**, **D7** | 28 | none (operator's computer) |
| S8 `phase0/go-no-go` | S1 | 44 | Python tests |
| S9 devices + verdict | S5, S7, S8, **D4, D5, D7** | 0 | Python |
| S10 report | S9 | 4 | none |
| S11 `-O2` (only if not GO) | S9 | unknown, possibly D2 | as S4 |

About **280 runner-minutes** without S11, all on the standard runner. The repository is
**public** (verified 2026-10-04, `docs/OPEN_QUESTIONS.md` Q11), so the standard runners consume
no monthly allowance; the minutes are avoided for time and signal, never for a bill that was not
being spent (`docs/AGENT_RULES.md`, "CI budget").

## 7. Items that could not be verified today

- Whether Node v22.22.3 on this VPS runs `melee_core_node.js` (CI ran it with the runner's
  Node; the WASM exception-handling encoding emitted by emsdk 4.0.23 was not checked).
- WASM run time under Node on the VPS; artifact size of the WASM zip.
- `FS.filesystems.WORKERFS` availability and `callMain`'s return value on `_Exit` under
  `EXIT_RUNTIME=0` in emsdk 4.0.23 (the S6 CI test is what verifies both).
- Whether a mid-range Android phone can compile an 87 MB module at all.
- Whether `match_frame != 0` covers exactly the match: it is the script engine's convention
  (`native/headless_input.cpp:143`) and the endpoint value (762 at retrace 2400) is measured;
  the per-row behaviour is first observed in S5's `frame_stats --in-match` count.
- That GitHub accepts the `concurrency` expression with `inputs.single_thread` (S2 gives the
  fallback).

## 8. Decisions that belong to the operator

Each has a minimal proposed choice; the plan is written so that choice unblocks everything.

- **D1 — ISO in CI.** *Proposed: no, keep the status quo.* Node parity runs on this VPS
  (S4–S5) and browser parity runs on the operator's devices (S7, S9); nothing in the go/no-go
  needs CI to read the disc. Cost of this choice: P0-09 is a manual step per commit, not a CI
  check.
- **D3-W — the WASM core (and the spike page with it) as a private artifact.** *Proposed:
  yes, on exactly D3's terms* — private, only on manual `workflow_dispatch` with
  `upload_wasm=true`, 3-day retention, never on pull requests, downloaded outside the
  checkout. Blocks S3 and S7. Reversal: dispatch without the input, delete artifacts with
  `gh api -X DELETE repos/isDemetrio/melee-web/actions/artifacts/<id>`.
- **D4 — how devices reach the page.** *Proposed: the operator's computer with
  `web/scripts/serve.mjs`, the phone via USB port forwarding to `localhost`.* Cloudflare Pages
  is not an option for this core as built: 87,117,533 bytes exceeds the 25 MiB per-file limit.
- **D5 — devices.** Which mid-range Android phone (SPEC suggests Snapdragon 7-series); whether
  a Mac/iPhone is available. No verdict without the Android row.
- **D7 (new) — the disc on the test devices.** *Proposed: the operator copies their own ISO to
  the phone's local storage for the measurement and deletes it afterwards.* The page reads it
  in place and never uploads it.
- **D8 (new) — the uncovered band.** The specification does not say what a desktop mean in
  (1.5, 4] ms means. *Proposed: the tool reports REVIEW (exit 4) and the operator decides in
  the report;* the alternative is to fold it into NO-GO.
- **D10 (new, only if S5 step 2 happens) — accept the single-thread native build as the
  reference** if threaded and single-thread native differ. *Proposed: no — fix patch 0005
  first,* because the specification's reference is the native build as shipped.
- **D2 — larger runner**, only if S3's retry at 2 jobs or S11 runs out of memory.

## 9. What NOT to do

- **Do not use `vs_match.txt`.** It ends in a menu for this `--no-slippi` build
  (`mode=1 state=0 match_frame=0`). Every run in this plan passes `parity_vs_onett.txt`
  explicitly, even after S2 changes the default.
- **Do not compare the WASM core with the 10:29 UTC native binary or its trace
  `c79c53b9…` as the oracle.** Different commit, different patches. It is informational (F).
- **Do not download artifacts into the checkout**, and never `git add -A` after a download.
  The hygiene gate catches `.wasm` but not the `.js` glue, the traces or the result JSONs.
- **Do not upload the ISO anywhere, and do not add an ISO job to CI** — D1 is the operator's.
- **Do not pass the core between jobs** with `upload-artifact`/`download-artifact` on pull
  requests to "split" `phase0-build.yml`: that uploads game-derived code on every PR. The
  spike steps stay in the `build` job.
- **Do not copy the core into `web/public/` or anywhere `ci.yml` builds**: `ci.yml`'s `deploy`
  job publishes the shell as soon as Cloudflare credentials exist.
- **Do not relax the comparator**: no tolerance, no dropped column (`events` and `aram` are
  part of the oracle), no "ignore the first N retraces".
- **Do not touch the recompiler, `upstream/melee-unlocked`, or the patch series to make a
  trace match** before the first divergent retrace and column are written down (rule 5). Any
  upstream change is a new patch in `patches/` plus a row in `docs/PORT_CHANGES.md` written
  first.
- **Do not run two game processes at once on the VPS**, or a game process while another heavy
  agent works; do not run Chromium, Playwright, `npm` or a bundler here; do not serve the page
  from the VPS.
- **Do not take timing without `--fast`**, or from a run whose timer resolution is above
  0.1 ms, or from Node on the VPS, as a go/no-go number. Node numbers are a proxy, labelled so.
- **Do not measure the whole 2400 retraces** for the verdict: ~1638 of them are boot and
  menus. The verdict uses in-match rows only; `stats_all` is context.
- **Do not dispatch the same workflow twice at once** on the same ref: `cancel-in-progress`
  kills the first run silently.
- **Do not raise the optimisation level, add `-O3`, or touch FP flags in a PR that also
  records a parity result.** One variable at a time; S11 is its own PR and re-runs parity.
- **Do not merge on `pending`**, and do not merge a PR whose `phase0-build` was skipped by the
  path filter when it changed something that build consumes.
