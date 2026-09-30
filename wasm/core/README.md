# Phase 0 WASM core

Build only in Actions (`phase0-build.yml`). `melee_core_wasm` links Node and web/worker
variants with native WASM exceptions, strict FP, no pthreads and undefined-symbol errors.
`guest` consumes the relocatable generated source list. All compile products stay in
RUNNER_TEMP; compiler timing CSV and job summaries contain only numbers/source basenames.

The executable is the **offline native reference compiled with emcc**: it shares
`native/core_sources.cmake`, entry point, portable host, input, FIFO and service adapters.
Generate with `--no-slippi`, as the native reference does. Both use the same patch series,
-O1, FP flags and SHA-1 identity gate. `MELEE_SINGLE_THREAD` makes DVD reads inline while
leaving their virtual completion times unchanged; native can select this option too.
FPSCR RN/NI non-x86 request totals print at exit, with a first-use message per category.

`runtime_core` separately compiles the exact 13 upstream files proposed in RUNTIME_MAP
on clang and emcc. It is a **compile gate**, not the executable's host/GX/Slippi boundary.
Linking that wider boundary would change the verified native reference. The executable
retains native/headless_services.cpp's explicit offline guards: Slippi translations are
rejected, EXI Slippi access fails, physical audio/input and render observation are absent.
A successful compile of exi_slippi.cpp does not establish working Slippi/Sys support.

The web module factory is `createMeleeCore`; populate its FS with user-provided disc/files
before `callMain`. It does not auto-run. This is a linkable worker module, not the P0-10
browser harness or a random-access OPFS adapter. Use `--fast` for simulation measurement.
Node uses NODERAWFS for operator files. Neither variant embeds a disc or DOL.

CI checks SHA-1 vectors, `--help`, the real DOL gate, rejection of a missing ISO, WASM
imports (host libm forbidden), module size against the 25 MiB Pages limit, and the ten
largest function bodies/local counts. These do not prove ISO boot, checkpoint parity,
RN/NI usage in gameplay, or performance on a phone. See docs/PROGRESS.md for measured runs.
