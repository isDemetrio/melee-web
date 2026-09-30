# Does the checkpoint trace inflate the measured frame times? (2026-09-30, night)

**The question.** `native/headless_host.cpp` hashes about 40 MiB of RAM and ARAM after every
retrace (`trace_state` / `digest_state`). `sim_ms` excludes that work, but the next frame starts
with the cache it evicted, and on the iPhone the wall clock was 24 s against 5.2 s of simulated
frames. So it was worth asking whether part of the measured 3.24 ms is the harness rather than the
browser. The hypothesis came from the night consultation and is worth recording with its answer,
because a plausible mechanism that does not survive a measurement is exactly the kind of thing this
project must not carry forward as an assumption.

**The method.** The native headless binary built from the served core's commit
(`/home/hermes/incoming/phase0/reference-4fba3a0/melee-core-headless/melee_core_headless`), the
operator's own disc (size and SHA-1 checked by the runner before anything executes), the project's
own `upstream/melee-unlocked/port/scripts/parity_vs_onett.txt`, 2400 frames, `--headless --fast
--time-base 1 --volume 0`, `nice -n 10`. Six trials, alternating, same machine, sequential: three
with `--state-trace`, three without it. Statistics from `scripts/phase0/frame_stats.py --in-match`,
which measures only the 762 retrace frames of the match.

| trial | mode | in-match n | mean ms | p95 ms | p99 ms | max ms | sum of frames | wall clock | trace sha1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | with trace | 762 | 14.69 | 17.75 | 19.17 | 29.96 | 11.2 s | 54 s | `c79c53b9…` |
| 1 | without | 762 | 15.24 | 18.58 | 24.55 | 45.81 | 11.6 s | 53 s | — |
| 2 | with trace | 762 | 14.95 | 17.74 | 19.95 | 30.83 | 11.4 s | 53 s | `c79c53b9…` |
| 2 | without | 762 | 14.37 | 18.09 | 19.30 | 23.89 | 11.0 s | 54 s | — |
| 3 | with trace | 762 | 13.87 | 17.78 | 19.57 | 30.50 | 10.6 s | 52 s | `c79c53b9…` |
| 3 | without | 762 | 14.25 | 17.62 | 20.33 | 32.66 | 10.9 s | 52 s | — |

**The answer: no measurable effect.** With the trace the in-match mean is 14.69 / 14.95 / 13.87 ms
(mean of means **14.504**); without it, 15.24 / 14.37 / 14.25 ms (mean of means **14.622**). The
difference is **−0.8%**, in the direction *opposite* to the hypothesis, and the spread inside each
series is about ±5% — five times the difference. The wall clock is the same to the second (52–54 s
either way). All three traced runs hash to
`c79c53b9cdf81426fa0277e7497a69e55bc5f571` and end at `mode=2 state=2 match_frame=762`, so the
comparison is between two runs of the same simulation, not between two different ones.

**What follows.** The per-retrace hashing does not measurably inflate the frame times on this binary
on this machine. The gap between wall clock and simulated time is real but it is not the trace: the
native harness shows the same gap (about 53 s of wall clock for about 11 s of simulated frames)
with and without it, so the remaining ~40 s is startup, disc reading and the harness itself, not the
checkpoint hashing. **The device row stands as measured**: 3.0315 / 3.2442 / 3.0809 ms of in-match
mean, and no correction is owed to those numbers.

**What it does not prove.** That the WebAssembly module under JavaScriptCore behaves the same way.
This experiment ran the x86 binary on the VPS, not the module in Safari: the phone's wall-clock gap
could still come from browser-side work, and a difference smaller than this machine's ~5% noise
cannot be seen here. The negative result removes one candidate explanation; it does not explain the
gap.
