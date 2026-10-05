# Emulator attribution in Chromium

Run `.github/workflows/emulator-cost.yml` through its PR trigger. Do not run the
build, browser or tests on the editing VPS. The workflow reads the existing private
R2 disc and keeps the DOL, generated C++, module, raw profile and disc in
`RUNNER_TEMP`. Only aggregate JSON and source/machine metadata are uploaded.

The branch now includes `main` at `696ec4f`, including PR #121 (FMA exact-product
shortcut) and PR #127 (single-entry-hook inline comparison). The earlier run
37250075985 predates both and is infrastructure evidence only. The refreshed
baseline is measured before any optimization.

## Measurement

1. Build the real web module at the repository's compilation settings, retaining
   function names through the final `wasm-opt -O2` pass.
2. Launch Chromium and run the 2400-retrace Onett script with a fake WebGPU backend.
   Require all 2400 checkpoints to hash to
   `c79c53b9cdf81426fa0277e7497a69e55bc5f571` and the final scene to report 762 match
   frames. A failed oracle stops the job before performance claims.
3. Use new pages/modules for attached and headless runs, with state tracing off.
   At retraces 1638 and 2400, synchronous `console.profile`/`console.profileEnd`
   delimit exactly the requested window. CDP receives the result via
   `Profiler.consoleProfileFinished`. No `Debugger.enable`, breakpoints, source
   rewriting or C++ instrumentation is used. V8 documents its debugging/profiling
   compilation behavior at <https://v8.dev/docs/wasm-compilation-pipeline>.
4. Attribute samples by their stacks. A memory helper beneath vertex decoding
   belongs to GX, not to guest memory accesses. Time spent in backend submission
   remains excluded even when submission is beneath FIFO parsing. Unknown work
   remains visible as `unclassified`, with its largest self-time functions.

`browser.json` records the Chromium version, oracle digest, sample count and
in-match `sim_ms`. `attached.json` and `headless.json` record the disjoint shares,
sampled milliseconds per frame and top functions. Compare sampled elapsed time
with `sim_ms` before interpreting shares. This initial job is attribution, not a
paired speedup experiment or a phone/JSC measurement.

## Limits that must remain visible

- Zero samples means **unobserved, possibly inlined**, not zero cost. An empty
  profile is an error. A timer/counter that is subsequently added must report its
  invocation count as well as its time.
- `mmio_write` self time does not identify the destination. It cannot all be
  called GX time. The FIFO adapter also contains initialization checks, so its
  self time does not isolate byte-buffer writes.
- `record_draw` includes state copies, texture snapshots, observer work and vector
  appends. Out-of-line descendants are separately visible; inlined appends are
  not. No claim about the command-buffer fraction follows from its total.
- A memory helper's self time does not distinguish call overhead, address checks
  and inlined RAM-generation bookkeeping. The previous inlining regression must
  not be reinterpreted as an optimization opportunity on the basis of this table.
- The fake GPU does not execute draws or validate pixels. A checkpoint trace is
  the CPU/RAM determinism oracle; it does not prove rendered geometry equivalence.
- WORKERFS reads the private disc lazily using a loopback synchronous reader in
  the browser worker. This exercises the browser module but is not production disc
  I/O. The fake GPU's CPU overhead is also a fixture, not a real WebGPU API cost.

After attribution, any candidate needs alternate baseline/candidate game runs
with profiling off, a repeated full checkpoint gate, and explicit reporting of
small, null or negative results. Arithmetic changes additionally require a large
differential corpus against the old path. No optimization has been made here.

## Region experiment (second, instrumented build)

`instrument.py` inserts measurement-only scopes on the runner after the normal
patch series. It does not change the production sources in this PR. The baseline
module is measured first, then only affected C++ files are rebuilt. The scopes
separate GX-address MMIO, FIFO byte appends, parser overhead, vertex descriptors,
vertex decoding, draw state copies, texture snapshots and command-vector appends.
The forwarding backend is an excluded nested region; it is not optimized.

All scopes report calls, inclusive and exclusive elapsed time. Parent exclusive
time subtracts nested scopes; inclusive times must not be summed. Three unprofiled
control/measurement pairs in each mode quantify the cost of enabling clocks.
Three unprofiled runs of the unmodified module also expose code-layout/disabled
probe overhead. `region-summary.json` explicitly reports both ratios. Region
fractions describe the instrumented module, not production performance. Zero
calls in any required probe fails; zero elapsed time with calls means below timer
resolution. The complete oracle must pass again with probes enabled.

## Memory experiment

After the GX experiment, the workflow's default measurement becomes `memory`;
manual dispatch with `experiment=gx` still reproduces the GX regions. Both begin
with an unmodified current-main baseline. `instrument_memory.py` makes only
`mark_ram_write` non-inline so its work becomes a sampled boundary. It does not
inline guest memory helpers. Disabled counter branches and the extra call are
explicit perturbations, quantified by unprofiled whole-game controls.

A separate counter run reports invalidator calls, widths, single/multiple-block
ranges, blocks tested and watched hits. Counters are off in the profiling and
control runs. The instrumentation must pass the identical full trace and report
nonzero invalidator samples; otherwise attribution fails. The runner extracts
only the emitted `ld32`, `st32` and invalidator Wasm bodies, excluding all guest
functions and data sections, as instruction evidence. This does not turn
instruction counts into timing estimates.
