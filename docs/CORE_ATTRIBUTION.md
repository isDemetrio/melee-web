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
