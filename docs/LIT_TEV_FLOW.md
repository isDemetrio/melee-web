# Lit-channel hang: finite TEV control flow

The original WGSL does not contain a non-terminating source loop. Its four loops are:

```wgsl
for (var j = 0u; j < min(nchan, 2u); j++) { /* channels */ }
for (var i = 0u; i < 8u; i++) { /* lights */ }
for (var i = 0u; i < ntex; i++) { /* ntex = min(uid(6u), 8u) */ }
for (var n = 0u; n < stages; n++) { /* stages = uid(24u) */ }
```

`make_uid` writes `numtevstages() + 1` to word 24; `numtevstages` extracts four
bits (`gx_regs.h:40`), hence 1..16. `fill_uid_rows` stores it exactly as a float
at row 128.x, included in every draw's upload (`uniform_rows` >= 141).
No body writes its counter or bound. The unlit-channel `continue` still executes
`j++` under [WGSL for semantics](https://www.w3.org/TR/WGSL/#for-statement).
There is no `loop` or `while` in the emitted shader or its helpers.

The existing local dump-only executables `/tmp/wgsl_dump` and `/tmp/wgsl_lit`
were run without compilation or GPU execution. The original dump (19,803 bytes)
was matched exactly against the current raw WGSL template with its numeric tokens
substituted. The specialized dump is a synthetic lit-channel fixture, not a dump
of the earlier failing draw: its loops are expanded by C++, with no WGSL loops.
The constant-fragment variant is the original prefix plus precisely the replacement
fragment used in `scripts/diagnostic/lit-hang.mjs` on branch `fix/lit-hang-3`.
It retains all three vertex loops unchanged.

The prior controlled run [37169761081](https://github.com/isDemetrio/melee-web/actions/runs/37169761081)
completed specialized and constant-fragment variants; original, constant-stages
(`stages = 1u`) and no-continue timed out after 30 s, with compilation messages
empty and the worker responsive. This excludes a missing source increment and
motivated trying the fragment loop first; it does not identify a particular
compiler pass or prove an infinite machine-code loop rather than slow compilation.
The constant fragment also makes colour varyings unused: an optimizer can prune
vertex lighting, so that variant alone does not exonerate the vertex loops.

The candidate workaround changes only generation of the fragment TEV schedule:

```wgsl
if (stages > 0u) { let n = 0u; /* identical stage body */ }
// ...
if (stages > 15u) { let n = 15u; /* identical stage body */ }
```

Each enabled stage runs once in the same order. The stage body is unchanged;
so are final register selection, fog, alpha test, vertex lighting and uniform
packing. Text remains independent of draw state and is compiled at backend attach.
The expanded text is 72,674 bytes; phone compilation latency has not been measured.
No test, expected pixel, timeout or replay oracle has been modified.

## Single-cycle result: incomplete, not ready to merge

[Run 37181434299](https://github.com/isDemetrio/melee-web/actions/runs/37181434299),
source `35538f2f5ae5ad3e5900b5884318a65ea19da5d2`:

- WASM compilation, linking, wasm-opt, all 144 release guest TUs, Node smoke and
  the spike page build passed.
- The formerly stalled transformed-triangle test passed in 8.0 s. All subsequent
  individual geometry/texture cases through test 34 passed, mostly in 8.0 s.
- Test 35, `resources stay bounded through 384 synchronous textured draws`, failed
  after 1.8 minutes (the existing result wait is 110 s). No final resource result
  was printed. The run was cancelled at 06:14:21 UTC to bound cost; the browser
  step began at 06:07:27. The final assertion stack was not printed before cancel.
- The complete harness did **not** pass. Pixel-pipeline/lighting differential
  checks did not run. No private Node artifact was produced, and the 2400-checkpoint
  replay did not run. The required SHA-1 remains
  `c79c53b9cdf81426fa0277e7497a69e55bc5f571`; parity is **unverified** for this branch.

This is evidence that removing the dynamic TEV loop restores completion for the
original simple draws, without any change to their state or expected pixels.
It is not evidence of acceptable throughput or of a specific compiler defect.
The expanded schedule is an incomplete workaround, left in a draft PR, not a
production-ready correction. Resolving the repeated-draw failure without the
expanded shader's cost remains outstanding. No second CI attempt was made.
