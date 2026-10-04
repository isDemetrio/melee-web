# wasm-opt post-processing: measured on the -Oz module

Emscripten already runs Binaryen at link. A **second** pass over the finished module, run outside
the compiler, still pays — enough to make it part of the shipped build.

## What was run

`wasm-opt` (npm `binaryen@132.0.0`, the JS build) over the `-Oz` node module, with the feature set
spelled out — `--enable-bulk-memory --enable-mutable-globals --enable-nontrapping-float-to-int
--enable-sign-ext --enable-exception-handling` — at `-O2`.

## Result

| | baseline `-Oz` | with wasm-opt `-O2` |
| --- | --- | --- |
| module size | 16,323,657 B | **15,162,083 B** (−7.1%) |
| in-match mean, run 1 | 27.667 ms | 26.014 ms |
| in-match mean, run 2 | 27.332 ms | 26.470 ms |
| trace, all four runs | `c79c53b9cdf81426fa0277e7497a69e55bc5f571` | identical |

In-match means the 762 rows of `sim_times.csv` where `match_frame` is non-zero. Between-repeat
spread is about 1.5%; the gap between the two groups is about 4.6% and the groups do not overlap,
so the speed effect is small but real *on this machine*. The size and the trace are exact numbers.

## The trap

`--all-features` produces a module that Node and V8 **reject at instantiation**:
`CompileError: WebAssembly.instantiate(): unknown import kind 0x7f`. Nothing in a normal build
notices — the compiler is happy, the artifact looks fine, and the failure appears only when
something tries to load it. Hence: the feature list stays explicit, and the CI step compiles both
modules after processing and fails the job if either stops compiling.

## What this does and does not mean

- **Solid:** the size win and the bit-exactness. −7.1% under a 26,214,400-byte Pages limit is real
  headroom for the per-file and interpreter experiments, and the trace is unchanged on all 2400
  checkpoints.
- **Not solid yet:** the speed number. It was measured on Node/V8 on the shared reference machine,
  not on Safari or Chrome on a phone, and the web module is a different link from the node module
  (`-sENVIRONMENT=web,worker`, `workerfs`) even though the objects are the same. A device run is
  what would turn the 4.6% into a claim.
- **Not the lever that matters most:** the device that measured 13.94–16.06 ms is not made fast by
  4.6%. Those runs are Android with "Request desktop site" on — the result JSON's own user agent is
  `Mozilla/5.0 (X11; Linux x86_64 …)`, which is not a Linux desktop — on the operator's 2025
  OnePlus tablet (`docs/PROGRESS.md`, "the spike is published, the OPFS path costs nothing, and the
  optimisation campaign finds its ceiling"). This buys size headroom and a small, free gain; the
  ranked levers remain those in `docs/CORE_BUDGET_DECISION.md` section 2.
