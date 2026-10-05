# GX FIFO and memory helpers: Chromium attribution after #121/#127

Measurement PR [#124](https://github.com/isDemetrio/melee-web/pull/124), starting
from main `696ec4f`. Both FMA #121 and single-entry-hook #127 are ancestors of this
base. No renderer implementation change, no production optimization, no merge.

## Baseline, 2026-10-05

[Actions 37269543623](https://github.com/isDemetrio/melee-web/actions/runs/37269543623)
ran Chromium 153.0.8010.12 on a GitHub-hosted Ubuntu runner, not Node on the VPS.
The real named web module ran the Onett script, two players, retraces 1639–2400.
The attached mode uses fake WebGPU; the backend's time is excluded below. The
complete 2400-checkpoint trace is still
`c79c53b9cdf81426fa0277e7497a69e55bc5f571`.

Evidence: [aggregate JSON](measurements/gx-browser-main-37269543623.json).
The sampled clock agrees with core `sim_ms` within 0.3%: 15.533 versus 15.498 ms
attached, 10.249 versus 10.220 ms headless. These are profiled runner times, not
phone performance or a before/after speedup experiment.

| Disjoint observed region | Attached, % frame | Headless, % frame |
| --- | ---: | ---: |
| FIFO adapter/write path, unresolved internals | 4.684 | 7.325 |
| Parser and inlined descendants | 9.837 | 15.169 |
| Out-of-line vertex decode helpers | 1.012 | 1.546 |
| Draw recording and its descendants | 5.784 | 8.559 |
| Out-of-line texture snapshot helpers | 0.001 | 0.002 |
| **GX total above** | **21.318** | **32.601** |
| MMIO self/descendants outside GX; destination unresolved | 0.994 | 1.614 |
| Guest memory helpers, including inlined bookkeeping | 10.357 | 15.543 |
| Out-of-line `mark_ram_write` | 0.024 | 0.041 |
| Renderer, excluded | 33.873 | 0.255 |

`trace_enter`: **no samples** in either mode. This is a visibility statement,
not proof of zero execution; #127 is already in main and is not reimplemented.

**What this does not establish.** Vertex decode is often inlined into the parser;
the 1.012% cannot stand for the full vertex cost. Likewise the 0.001% snapshot row
cannot stand for snapshot cost: `memcmp` beneath `record_draw` is inside that row.
`mark_ram_write` is often inlined into store helpers, so its tiny named self time
does not make invalidation free. MMIO self samples do not identify the target
address. None of these numbers warrants an optimization on its own.

## Next attribution step

The runner-only region build separates MMIO by address, FIFO byte-buffer writes,
parser overhead, vertex descriptor construction, vertex decoding, draw state
copies, texture snapshots and command-vector appends. It reports invocation
counts and inclusive/exclusive clocks, gates again on the full trace, and compares
three unprofiled original-module runs with three disabled/enabled probe pairs.
The instrumentation's overhead is part of the report; its fractions must never
be presented as unperturbed production fractions. Results pending Actions.

Memory experiments follow GX attribution. The earlier 0.92× whole-helper inlining
experiment remains a regression, not a candidate to repeat blindly.
