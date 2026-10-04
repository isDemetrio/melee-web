# Core attribution — experiment in progress

Baseline: 1844f42. No optimization has been applied. Renderer and web play code are excluded.
The 14.9 ms unassigned phone interval is outside this investigation.

Method: `.github/workflows/core-profile.yml` builds the existing native offline core, single
threaded like WASM, with an opt-in interval logger. Linux perf samples at 499 Hz with DWARF
call stacks and CLOCK_MONOTONIC. Only the 762 in-match simulation intervals are retained;
checkpoint hashing, menus and startup are excluded by timestamps, not guessed by symbol.
Every replay must retain SHA-1 `c79c53b9cdf81426fa0277e7497a69e55bc5f571`.
Only aggregate symbol counts and machine metadata leave the runner; stack memory, generated
C++, DOL, disc and traces stay in RUNNER_TEMP and are removed. Three trials quantify stability.
Native attribution is evidence about this workload, not an iPhone timing prediction or a
four-player benchmark. Inclusive stack percentages must not be summed.

Pending: measured attribution, reducibility bounds, and project decision. The existing
600-frame unnamed V8 hotspot (53%, PROGRESS.md) is insufficient to name the simulation bottleneck.

## Phone attribution already available (2026-10-04)

Source: the four operator JSON reports in `/home/hermes/.hermes/cache/documents/`.
[Machine-readable means and source SHA-256](measurements/core-phone-2026-10-03.json).
Method: CSV rows with `match_frame > 0`, `hidden == 0` when available; arithmetic means.
E and F share `started_at=2026-10-03T20:19:47.403Z` and core `9e9b6e7`:
they are overlapping exports, **not independent repeated trials**.

| Exclusive interval (ms/frame) | E, 1437 frames | F, 1577 frames |
| --- | ---: | ---: |
| Outside decoder, excluding game observer | 13.069 | 13.165 |
| Game observer | 0.203 | 0.202 |
| GX parsing/vertices/FIFO remainder | 6.773 | 6.870 |
| Draw recording, excluding texture/observer | 0.858 | 0.869 |
| Texture snapshots | 0.640 | 0.609 |
| Draw observer | 0.112 | 0.113 |
| End-frame/backend submission and cleanup | 7.139 | 7.260 |
| **Sum = internal sim interval** | **28.794** | **29.087** |

Thus `sim_ms` is **not exclusive game simulation**. `decode_ms` is 15.522/15.720,
including synchronous backend submission; the decoder-only remainder after end-frame is
8.383/8.460 ms. `non_decode_ms` is 13.272/13.367; calling it "rest of renderer" is
not supported by the scope definitions (`native/headless_host.cpp:record_decoder_cost`,
`patches/0009-offline-frame-split.patch`). The quoted 33%/35.8% cannot be used as two
exclusive parts of the current core. Current E/F summaries report 34.0/34.2% decode
and 29.1/29.0% non-decode, with **cycle**, not core, as denominator.

E/F profiling uses about 29,252/29,518 decode scopes per frame, in addition to draw
and observer clocks. D/G have profiling disabled and internal intervals 18.280/19.461 ms.
The difference is **not** an overhead measurement: replay, duration and scene differ.
Neither these reports nor the parity script establish the required four-player load.
The parity run ends at match frame 762; its first scripted in-match movement is at 900.
It measures two characters on Onett before those scripted actions, not active four-player combat.

No attribution, hypothesis or optimization of the separate 14.9 ms interval is made here.

## Amdahl bound for the requested scope

Using the measured **profiled** phone E/F decomposition, with other work unchanged:

| Quantity | E | F |
| --- | ---: | ---: |
| Current core ms | 43.816 | 44.154 |
| Reduction required to reach 13 ms | 30.816 | 31.154 |
| Required speedup to reach 13 ms | 3.370× | 3.396× |
| Non-decode plus GX excluding end-frame, ms | 21.655 | 21.827 |
| Core left if those two blocks cost **zero**, ms | 22.161 | 22.327 |
| Maximum speedup from those blocks alone | 1.977× | 1.978× |

This is an optimistic **upper bound**, not an attainable optimization. It already rules out
3× from simulation/decoder changes alone in those measured sessions. It does not prove an
absolute no-go for the whole project: renderer work and the separate outstanding attribution
are outside this task. No cost in either is declared irreducible or removable here. The table
must not be applied to unprofiled D/G as if their missing split were measured.

## First native result — run 37224298646

[CI run](https://github.com/isDemetrio/melee-web/actions/runs/37224298646), source
`7cbab8d`; [aggregates](measurements/core-native-37224298646/).
AMD EPYC 7763 runner, GCC native `-O1`, single-thread host, real decoder, no WebGPU.
All **six** 2400-row traces (three unprofiled, three sampled) passed the full reference SHA-1.
Mean in-match ms, paired unprofiled → sampled: **8.050 → 8.102**, **8.037 → 7.958**,
**7.717 → 7.708**. Difference ranges −0.98% to +0.66%; no measurable systematic slowdown
at this resolution, but this is not a confidence bound for an individual function.
9,037 retained samples across 2,286 match frames, at 499 Hz. Unknown leaf PCs account for
1.76–1.84%; outer stacks still identify an area. The native compile policy differs from WASM
(`-Oz` guest, selected runtime units `-O2`), so percentages are not transferred to iPhone.

First pass: translated guest/PPC **60.48–61.64%**, GX together **32.35–33.66%**,
HLE/audio/OS **4.94–5.92%**, observers **0.59–0.68%**. Subdividing GX needs care:
`decode_vertices` was inlined into `parse_command` (15.25–16.87% self). This first
classifier also labels allocations whose template name contains `gx::` as generic GX;
its draw/vertex subcategories are consequently **not** a complete attribution. The next
run adds decoder-only debug information and inline symbolization, and fixes scope ownership.

Independent self costs: `ppc::st32` **8.19–9.46%**, `ppc::ld32` **4.90–5.59%**,
software exact FMA **2.04–2.63%**; `trace_enter` **1.20–2.04%**. No one of these can
supply a factor three. Inclusive guest display call `HSD_JObjDisp` (`803749B0`) is about
70%; `SetupEnvelopeModelMtx` (`8036E4C4`) about 16%. These include callees and must not
be added to GX or to each other. Names come from the pinned `port/recomp/GALE01_symbols.txt`.
No optimization has been implemented on this evidence.

The inclusive display result is stable: `HSD_JObjDisp` **70.514/71.462/71.365%**.
Even subtracting *every* GX sample in each run (including those outside that call), at least
**37.679/37.798/39.019%** of total time remains below this guest display function. That is
**56.1–57.7% of non-GX time** in the native replay. The dominant "simulation" area is therefore
guest scene preparation, with its matrix/memory operations, not demonstrably fighter physics.
`SetupEnvelopeModelMtx` alone is **13.889–16.275% inclusive** (overlaps other rows).

## What can and cannot be removed without changing behavior

These are opportunity ceilings from sampled CPU cost, **not measured speedups**. A new
implementation must show an A/B improvement before it earns a positive savings estimate.
There has been no such successful A/B optimization in this task, so the demonstrated
production saving is currently **0 ms**.

- **Guest memory helpers:** `st32` + `ld32` account for 13.4–15.0% self in the first
  native sample. Reducing call/dispatch/range-check overhead is a candidate; required loads,
  stores, endian conversion, MMIO side effects and RAM invalidation cannot be discarded.
  Eliminating even the whole sampled self cost would save only about 1.1–1.2 native ms/frame.
  The existing WASM optimization policy differs, so this is not an iPhone estimate.
- **Guest scene/matrices:** joint traversal and envelope matrix setup dominate the guest
  display path. Specialization or reuse needs proof of unchanged matrix inputs, writes and
  rounding. Skipping traversal/animation, using approximate math, or replacing emulated PPC
  arithmetic with host math is not an admissible saving. The profile does not demonstrate
  how much of this implementation is redundant.
- **FIFO storage:** byte-vector append self cost 3.20–3.71% (about 0.25–0.30 native ms).
  `write_fifo` resizes/initializes then overwrites each appended byte; avoiding redundant
  initialization is a candidate, but retaining byte order and exactly the same drain/interrupt
  boundaries is mandatory. This ceiling includes necessary append work; it is not all removable.
- **Draw recording and texture snapshots:** state copies/cache lookups could be reduced only
  while preserving immutable snapshots, texture/palette versions, owners and order. Existing
  code already merges compatible consecutive primitives, hoists vertex format work per call,
  caches snapshots and skips unused matrix/light copies. "Add a cache" is not a measured gain.
  Phone E/F exclusive record+texture costs total **1.498/1.478 ms**, an upper ceiling if both
  vanished, before accounting for the work they must still perform.
- **Observer metadata:** phone game+draw observers total **0.315 ms** in both E/F; deleting
  all of them cannot supply a meaningful factor-three contribution. Existing readers prevent
  simply turning them off (`PORT_CHANGES.md`, patch 0009).
- **Exact FMA:** 2.04–2.63% self native, about 0.16–0.21 ms/frame. The particular software
  algorithm is not proven optimal, but its PPC rounding/NaN behavior is required. Approximate
  or fast-math replacements violate the task. Even an impossible zero-cost replacement is small.

"Required semantics" is not a lower bound on milliseconds. These samples do **not** prove
that a function is already maximally optimized, and no honest numerical irreducible floor
for a different recompiler/architecture can be derived from them. The proven negative is the
Amdahl limit of this intervention scope, not a theorem that Melee in a browser is impossible.

The checkpoint digest proves equality of the entire CPU/RAM/ARAM/event trace in this replay.
A future GX optimization additionally needs identical decoded vertices/state/texture snapshots
(or an equivalent rendering oracle): a visually wrong decoder can preserve CPU checkpoints.
