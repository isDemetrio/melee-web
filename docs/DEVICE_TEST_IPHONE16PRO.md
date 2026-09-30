# Phase 0 — the device row: iPhone 16 Pro, Safari, three runs

Evidence for the device measurement `docs/PHASE0_DEVICE_PLAN.md` prescribes. Written 2026-09-30 from
three JSON files produced on the operator's phone (iPhone 16 Pro; the operator reports iOS 27, the
page's user agent reports `iPhone OS 18_7` — both are recorded, the discrepancy is not resolved).
**Every number below was recomputed on the VPS from the raw CSVs inside those files**, not copied from
the fields the page declares; the declared `stats_in_match` is quoted only where it was checked against
that recomputation.

## 1. How the page reached the device — not by the planned route

`docs/PHASE0_DEVICE_PLAN.md` §2 V3 planned `tailscale serve` to put the spike page behind a trusted
HTTPS origin on the tailnet. Two things happened, and both are recorded because the next session will
hit them:

- The operator **did** enable Serve for the tailnet (the admin link the CLI prints). The next attempt
  then failed with `Access denied: serve config denied`: writing serve config needs root or
  `tailscale set --operator=$USER`, and this VPS has **no sudo** (`sudo -n true` fails). The tailnet
  HTTPS route stays closed until someone with root sets the operator flag.
- Route actually used: a **`cloudflared` quick tunnel** — `~/.local/bin/cloudflared tunnel --url
  http://127.0.0.1:8091`, a userspace binary with no Cloudflare account — giving a real trusted HTTPS
  origin. That is what makes `crossOriginIsolated` true; over plain HTTP the COOP/COEP headers are
  ignored and the clock stays coarse (plan §0.3).

Verified with `curl` **before** any run, not assumed: `spike.html` → `200` with
`cross-origin-opener-policy: same-origin` and `cross-origin-embedder-policy: require-corp`;
`spike-core/melee_core_web.wasm` → `200`, `application/wasm`, **16,323,255 bytes**; `melee_core_web.js`
and `parity_vs_onett.txt` reachable. The disc never crossed the tunnel: the operator had already
downloaded the 1,459,978,240-byte image from a second server instance bound to the tailnet IP
(`http://100.120.206.46:8092/disc.iso`), because the planned one listens on `127.0.0.1` only and is
therefore unreachable from a phone — a gap the earlier curl checks on `127.0.0.1` could not see.

## 2. What the phone ran — identical in all three runs

| Field | Value |
| --- | --- |
| `schema` | `melee-spike-result/1` |
| `core_commit` | `4fba3a080af6f205cc6107ada7baefeb0315cae0` (= the served `spike-core/core.json`) |
| `core_opt` (declared) | `-Oz` |
| `frames` | 2400 |
| `iso_bytes` | 1459978240 |
| `cross_origin_isolated` | `true` |
| `timer_resolution_ms` | 0.01999999999998181 |
| `exit_code` | 0 |
| `final_scene` | `final scene: mode=2 state=2 match_frame=762 (retraces=2400)` |
| trace SHA-1 (recomputed) | `c79c53b9cdf81426fa0277e7497a69e55bc5f571` |

## 3. The three runs (762 in-match retraces each)

| Run | Created (UTC) | Frames in match | Mean | p95 | p99 | Max | Warm-up: first 100 → last 100 | `wall_ms` | Sum of `sim_ms` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-09-30T19:12:53.546Z | 762 | **3.0315** | 3.54 | **3.96** | 8.52 | 3.093 → 3.070 (-0.7%) | 24109 ms | 5227 ms |
| 2 | 2026-09-30T19:19:29.902Z | 762 | **3.2442** | 4.20 | **5.64** | 10.14 | 3.118 → 3.323 (+6.6%) | 24629 ms | 5422 ms |
| 3 | 2026-09-30T20:33:26.578Z | 762 | **3.0809** | 3.60 | **4.12** | 10.94 | 3.113 → 3.136 (+0.8%) | 24216 ms | 5270 ms |

The second run is **7% slower** than the first and its warm-up slope is
**+6.6%** where the other two are flat: that is thermal drift inside a single run, not a
property of the code. Run 3 was taken after a longer pause and came back down to 3.08 ms.

## 4. The checks of plan §5

| # | Check | Result |
| --- | --- | --- |
| C1 | `schema`, `frames`, `iso_bytes`, `exit_code` | pass, in all three: `melee-spike-result/1`, 2400, 1459978240, 0 |
| C2 | `cross_origin_isolated` `true`, `timer_resolution_ms` ≤ 0.1 | **pass**: `true`, 0.0200 ms |
| C3 | `core_commit` = the served core's commit | pass: `4fba3a08…` |
| C4 | `final_scene` = `mode=2 state=2 match_frame=762 (retraces=2400)` | pass, in all three |
| C5 | trace SHA-1 and a line-by-line diff against `$D/runs/native-1/trace.csv` | **pass**: SHA-1 `c79c53b9…`, **0 differing lines out of 2400**, in all three |
| C6 | recomputed `frame_stats` vs declared `stats_in_match` | pass: `count` 762, mean/p95/p99/max agree to the rounding of the declared fields |
| C7 | warm-up: mean of first 100 vs last 100 in-match values | −0.7% / +6.6% / +0.8% — inside the 15% threshold, but run 2 shows the drift |
| C8 | sum of `sim_ms` < `wall_ms`; `max_ms` not seconds; scatter between runs ≤ 15% | pass: 5227/5422/5270 ms against 24109/24629/24216 ms; maxima 8.52/10.14/10.94 ms; scatter **7.0%** |

`comparison` is `null` in all three, as expected: the reference CSV selector was left empty on the
phone, and the trace was checked against the VPS copy instead.

## 5. The verdict

Worst of the three (plan §6: three runs, the worst counts): **m = 3.2442 ms**, **p = 5.64 ms**,
**q = 0.0200 ms**.

| Criterion | Arithmetic | Met? |
| --- | --- | --- |
| GO | `m + q ≤ 3` → 3.264 ms | **no** |
| GO | `p + q ≤ 6` → 5.66 ms | yes |
| GO | `q ≤ 0.1` and C2 | yes |
| NO-GO | `m − q > 6` → 3.224 ms | no |
| NO-GO | `p − q > 12` → 5.62 ms | no |
| "Desktop only" band | `3 < m − q` (3.224) and `m + q ≤ 6` and `p + q ≤ 12` | **yes** |

**Result: not GO, not NO-GO — the "desktop only" band of `docs/SPEC_PIANO.md`, i.e. proceed on desktop
and re-evaluate the mobile row in Phase 4.** The mean misses the GO line by 0.26 ms, about
9%; the p99 is inside its line with 0.34 ms to spare. Nothing here is a NO-GO, and
nothing here is a GO.

Information that is not a criterion: `p = 5.64 ms ≤ 16.67 ms`, so on this device the game would hold
60 Hz **without** rollback.

## 6. The optimisation lever — measured, and closed by size (2026-09-30, later the same night)

The served core is `-Oz`. `docs/PROGRESS.md` measured `-Oz` as ~6% slower than `-O1` on the VPS, which
made the optimisation level the first lever to test. It has since been tested, and the answer is in
`docs/OPT_LEVEL_EXPERIMENT.md`:

- `-O1` reproduces the native trace on all 2400 checkpoints — two runs, `c79c53b9…`,
  `identical: 2400 retraces` — and is about **7% faster** on the VPS (26.9 ms mean of means against
  28.9 ms for the three `-Oz` runs of the same day);
- but the module grows from 16,323,255 to **85,658,030 bytes**, `within_pages_limit: false`, i.e.
  3.3x over the 25 MiB limit for a single file on Cloudflare Pages. The bytes are in the `code`
  section (99.1% of the file), so there is no symbol or debug section to strip.

**So the lever moves the line and cannot be shipped.** Applying the measured 7% to these three runs:
worst 3.2442 / 1.07 = **3.03 ms** (still outside the 3 ms line, and the ratio is a VPS proxy under
Node, not JavaScriptCore); best 3.0315 / 1.07 = **2.83 ms** (inside). The route that remains, if the
mobile row ever needs it, is a level per file — the hot translation units at `-O2`/`-O3` and the rest
at `-Oz` — measured with the same method (2400 checkpoints, bytes, `within_pages_limit`).

## 7. What this does not establish

- **One device.** iPhone 16 Pro, one OS version, Safari only. Nothing about Android, nothing about
  other iPhones, nothing about Chrome on iOS. `docs/PHASE0_DEVICE_PLAN.md` §0.2 stands: without the
  mid-range Android row this is the **iOS row**, not the spec's go/no-go.
- **No graphics, no audio, no input, no network.** The core ran headless with a scripted input
  sequence; the cost of rendering will add to these numbers, and the rollback was deduced, not run.
- **The `-Oz` level only.** The verdict is the verdict of this build. `-O1` is bit-exact and about 7%
  faster but 5.2x larger, so it cannot be published to Cloudflare Pages: section 6.
- **Short runs.** Three runs of ~24 s each, not a long session: the thermal behaviour over half an
  hour is not measured, and run 2 shows that heat is already visible at this scale.
- **Where the times came from.** The trace proves the game ran correctly and identically; the device
  and the timings are declared by the page and by the operator, not proven by the VPS.

## 8. Where the evidence is

Outside the repository, as required (`docs/AGENT_RULES.md` rule 1 — the trace is game-derived):

- `/home/hermes/incoming/phase0/devices/iphone-safari/` — the three JSON files exactly as received,
  plus `run{1,2,3}_trace.csv` and `run{1,2,3}_sim_times.csv` extracted from them.
- Native reference used for C5: `/home/hermes/incoming/phase0/f0d76a2816ec/runs/native-1/trace.csv`.

## 9. What this predicts for the mid-range Android (M2) — an estimate, with its sources

The spec's deciding row is a mid-range Android ("es. Snapdragon 7 series", `docs/SPEC_PIANO.md`).
Nothing here measures one: the arithmetic below is a **prediction**, and it is written down because it
changes the order of the work, not because it is a result.

Geekbench 6 single-core, as published:

| SoC | single-core | source |
| --- | --- | --- |
| Apple A18 Pro (this device) | 3,408–3,539 | cputronic comparison page; a `browser.geekbench.com` result page |
| Snapdragon 7 Gen 4 | 1,325 | cputronic comparison page |
| Tensor G4 (Pixel 9 Pro), for scale | 1,948 | Tom's Guide benchmark table |
| Snapdragon 8 Gen 3 (Galaxy S24 Ultra), for scale | 2,300 | Tom's Guide benchmark table |

The ratio is **about 2.6x**. Applied to this device's 3.0315–3.2442 ms in-match mean, a Snapdragon
7-series class phone is predicted at **roughly 7.9–8.4 ms per frame** — past the spec's NO-GO
threshold of 6 ms, where the spec stops the project instead of narrowing its scope.

Three reasons to read that as an order of magnitude and not a number: Geekbench's single-core test is
not this workload (a single-threaded interpreter inside a browser engine, where WebAssembly tiering
and the memory subsystem matter as much as the core); these runs show +6.6% of thermal drift inside
one of them, and a phone under sustained load throttles; and V8 and JavaScriptCore do not tier up the
same way.

**What it changes is the order of the work.** The "desktop only" band reads like a marginal miss —
0.26 ms, 9% — and invites compiler tuning. If M2 lands near 8 ms rather than 3.2 ms, the gap is not 9%
and no flag closes it: it would take structural work (keeping GX and audio work out of the measured
window, or recompiler codegen), and the spec's own answer would be to stop. **The next measurement
that matters is M2, on the operator's mid-range Android, and it comes before further optimisation.**
This estimate is a reason to measure early, not a substitute for measuring.
