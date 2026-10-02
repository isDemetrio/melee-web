# Guest code baseline — 2026-10-02

Decision: analysis only. No simulation, emitter, compiler flags, assertions or runtime
checks changed. The three proposed DolRecomp optimizations do not match this emitter.
The measured phone gap is still unresolved; no speedup is claimed.

## Reproduction and scope

Base commit `6dd96f4d996a58c1737e543efad87d1dc0d92b9c`, upstream pin
`3aab7172db243c159afa76ecb2c564b3de8e4c0a`, existing patches 0001–0009 applied with
`scripts/apply_patches.sh`. Python generation ran successfully on the VPS, without
compilation or dependency installation. Input `/home/hermes/incoming/main.dol`
verified SHA-1 `08e0bf20134dfcb260699671004527b2d6bb1a45`.
This is an extracted DOL: `dol.py` reads its section header at byte zero; the disc
extraction offset `0x1e800` must not be applied again.

```sh
python3 upstream/melee-unlocked/port/recomp/recomp.py \
  --dol /home/hermes/incoming/main.dol \
  --out /home/hermes/incoming/guest-code-baseline-offline --no-slippi
python3 upstream/melee-unlocked/port/recomp/recomp.py \
  --dol /home/hermes/incoming/main.dol \
  --out /home/hermes/incoming/guest-code-baseline-release --gct-base 0x8065CC80
python3 scripts/analysis/count_guest_code.py /home/hermes/incoming/guest-code-baseline-offline
python3 scripts/analysis/count_guest_code.py /home/hermes/incoming/guest-code-baseline-release
```

Both runs reported 114 HLE overrides and warnings about HLE names absent from the
symbol map. Offline image digest: `ebf9450680c7`, generation 27.7 s. Release image:
`7883e197ff19`, 28.5 s. Generation time is not simulation time.
Generated files remain outside the repository. The counter emits aggregates only.

## What is actually emitted

`port/recomp/emit.py:emit_function`, `_call`, `_tail`, `_local_return` emit one C++
function per guest function, direct calls for known targets, local labels/gotos,
and `ppc::call` for unresolved/indirect targets. `ppc_runtime.cpp:call` performs a
lookup, depth check and call (or interpreter fallback); it is not a central loop
executing every basic block. Local block transitions return to a central dispatcher
**zero times**, including zero per frame. Ordinary `return;` statements return to
C++ callers and must not be counted as dispatcher exits. Label counts are not a
complete CFG/basic-block count (fallthrough and entry blocks also exist).

There is **no architectural `Context::pc`**, no per-instruction PC store, and no
per-instruction `enter()` call. Each non-HLE function has one `ppc::enter` site;
the early null-joint guard can return before reaching it. Inline `enter()` writes
`last_pc` once, writes one trace slot, increments `trace_pos` and `g_enter_count`,
checks the hang watchdog cadence and optionally runs entry hooks/traces. The same
sequence repeats per function entry, not per instruction. These are source-level
operations: generated C++ counts cannot establish the stores remaining in WASM.
`c.entry` is a thunk/resumption selector; `c.lr` is architectural return state.
Neither is a redundant instruction counter.

For N executed `enter()` calls per frame, there are N source-level `last_pc`
assignments and N trace-slot writes. Per-instruction PC writes are exactly **0**.
N is **not measured**: static sites cannot be divided by 2400 or converted to an
execution count. No honest numerical estimate of N follows from the supplied
milliseconds. The desktop host already reports delta `g_enter_count / frames`
in `host.cpp:sim_cost_line`; that is the appropriate dynamic quantity, subject to
using the same workload and frame boundaries.

## Reader audit

Paths below are relative to `upstream/melee-unlocked/port/` unless stated otherwise.

| Value / consumer | Required visibility and consequence |
| --- | --- |
| `last_pc`: `runtime/ppc/ppc_runtime.cpp:fatal` | Latest entered function at any fault, including a memory helper inside a function. Removing entry stores degrades fault diagnostics. |
| `last_pc`, trace: `runtime/host/host.cpp:mmio_read/mmio_write`; repository `native/headless_host.cpp` equivalents | Unexpected MMIO diagnostics can run inside an instruction helper. They need the current function-level diagnostic history, not an instruction PC. |
| trace / `trace_pos`: `fatal`, MMIO read diagnostics, `host.cpp` end-of-frame diagnostics | Read at faults or frame completion; cannot reconstruct the exact 64-entry history after dropping writes. |
| `last_pc`, trace: `app/main.cpp` | Entry-hook diagnostic logs and Windows exception report. No instruction-level freshness requirement, but deleting stores changes the report. |
| `g_enter_count`: `enter`, `hang_check`, `host.cpp:sim_cost_line` | Watchdog every 2^20 entries and calls/frame statistics; retain cadence and checks. |
| `pc` parameters: `trace_enter`, `trace_spline_guest` | Explicit addresses, not reads of a shared instruction counter. `trace_enter` also invokes registered entry hooks; not safe to delete wholesale. |
| `entry`: emitted entry dispatch, HLE wrappers, table thunks, longjmp catch | Read on function entry/re-entry, reset and used to select local labels. Control flow, not diagnostics. |
| `lr`, `ctr`: emitted branches, runtime, interpreter | Architectural control flow and state hashing. Must preserve. |
| `Interp::pc`: `runtime/ppc/interp.cpp` | Interpreter-local instruction fetch, relative branches, link addresses, backedge decisions, unsupported-instruction diagnostics. Must track every interpreted instruction; unrelated to static C++ entry stores. |
| Interrupts/events: `host.cpp` and repository `native/headless_host.cpp` | `loop_poll` pumps completions; `interrupts_enabled` flushes when MSR EE rises. Handlers copy/restore full Context. No per-instruction `last_pc` reader or instruction-PC resume loop; do not alter backedge cadence (1024) or interrupt delivery. |
| Exceptions: `GuestLongJmp`, context load, `CallDepthScope` | Unwind C++ frames, restore guest state, use LR/entry for resumption. Fatal paths still consume diagnostic history. |
| FIFO/MMIO normal path, `runtime/gx/render_observer.cpp` | No `last_pc`/instruction-PC consumer found. Observer uses guest argument/result registers and RAM. Unexpected MMIO logging is the separate consumer above. |
| Checkpoints: repository `native/headless_host.cpp:trace_state` | Hashes architectural registers, RAM, ARAM and events; excludes last_pc/trace. Passing this oracle alone would not prove diagnostics/watchdog/hooks unchanged. |

Audit used searches for `pc`, `last_pc`, `entry`, `trace_pos`, `g_enter_count`,
`backedges`, and Context copies across runtime, app, native and wasm sources,
then inspected emitter and consumers. No reader requires a *compiled instruction*
PC to be current between instructions: such a field is not emitted in the first
place. This does not authorize deleting the function diagnostic state.

## Proposed next measurement, before any optimization

1. On the same 2400-frame workload, collect per-frame deltas of the existing
   `g_enter_count` at frame boundaries (no clock reads per entry). Report in-match
   mean/p99 separately for the 762 frames. Count indirect dispatch and interpreted
   instructions in a separately instrumented build if sampling implicates them.
2. Capture a symbolized browser profile for compiled guest functions and inline
   helpers: distinguish entry bookkeeping, matrix/paired-single arithmetic,
   memory helpers and indirect dispatch. Static call-site counts are not shares
   of execution time. Check instrumentation overhead against a clean build.
3. If entry bookkeeping dominates, propose an implementation preserving exact
   trace, watchdog, entry hooks and fault visibility; compare emitted WASM first.
   Simply disabling trace writes is not acceptable under the current constraints.
   If a small set of math routines dominates, isolate one exact-semantics change
   there, preserving rounding, paired-single lanes, FPSCR and FMA behavior.
4. Validate any subsequent single change with operator-run checkpoint SHA-1
   `c79c53b9cdf81426fa0277e7497a69e55bc5f571`, then clean iPhone mean/p99 A/B
   and module size. Required target remains mean <= 3 ms, p99 <= 6 ms.

No block chaining or periodic 64-block yield is proposed: compiled blocks are
already connected by local control flow, and inserting yields would introduce a
new scheduling mechanism. No safe, large cut is established by this baseline.

## Measured static counts

Counter scope: numbered `guest_NNN.cpp` only, except explicitly named table row.
Instruction comments include empty emitted operations; these are source sites,
not unique original instructions or executed instructions. Return counts exclude
implicit C++ fallthrough. Source bytes exclude headers and auxiliary generated files.

| Source metric | Offline | Release (Slippi) |
| --- | ---: | ---: |
| Translation units | 137 | 144 |
| Functions | 19,827 | 20,076 |
| Instruction comments | 962,305 | 1,019,597 |
| Explicit pc/last_pc assignments in generated TUs | 0 | 0 |
| `enter` sites (one inline last_pc store each) | 19,713 | 19,962 |
| Local labels | 75,176 | 133,904 |
| Local goto sites | 110,091 | 177,681 |
| Explicit return statements | 22,317 | 23,623 |
| Direct guest call sites | 75,336 | 79,246 |
| `ppc::call` sites | 1,049 | 1,965 |
| Backedge polling sites | 5,550 | 6,560 |
| LR assignments | 91,607 | 97,106 |
| Entry assignments in numbered TUs | 124 | 492 |
| Entry assignments in guest_table.cpp thunks | 5 | 14,410 |
| Numbered TU source bytes | 56,348,251 | 62,764,846 |

No CPU timing, compiled size, executed per-frame entry count, preview or 2400-checkpoint
trace was measured in this audit. No claim of achieving the performance target.
