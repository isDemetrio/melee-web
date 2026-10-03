# Port changes

Every modification this project makes to upstream code is recorded here before it is
made, together with the reason. The upstream is a pinned submodule and is never edited in
place: changes live as patches in `patches/`, applied by `scripts/apply_patches.sh` onto
the CI checkout only.

| Patch | Upstream files touched | Reason | Applied by | Verified by |
| --- | --- | --- | --- | --- |
| `0001-ppc-portable-fma-and-intrinsics.patch` | `port/runtime/ppc/ppc.h` | Portable intrinsic shim and single-rounding FMA family for Emscripten/non-MSVC, routed through `wasm/compat/fma.h`: `fma` is `std::fma` plus the guard for musl `fma.c`'s zero-addend shortcut and the guard that returns a NaN operand quieted and unnegated, and `fmsub`/`fnmadd`/`fnmsub` carry their own copy of the NaN guard because they negate an operand before calling `fma`, and an invalid operation with no NaN operand (`0 * inf`, `inf - inf`) is pinned to the reference's indefinite `0xFFF8000000000000` instead of being left to the engine (see below); MSVC branch unchanged | `scripts/apply_patches.sh` (CI only) | Local `git apply --check`; `wasm/probe/fma_shim_test.cpp` and the corpus comparison in the WASM probe (run 36677219860: 0 divergences in 8 000 000 results); the cross-architecture comparison (run 37101091371: WASM-x86 and WASM-arm64 digests identical, 0 divergent) |
| `0001-ppc-portable-fma-and-intrinsics.patch` | `port/runtime/gx/gx_texture.h` | Explicit `<stddef.h>` for the public `size_t` parameter; avoid reliance on MSVC transitive includes | `scripts/apply_patches.sh` (CI only) | Local `git apply --check`; `ctest` in the WASM probe builds and runs `texture_snapshot_test` under Node |
| `0002-native-linux-runtime.patch` | `port/runtime/ppc/ppc.h` | Restore native x86 `<immintrin.h>` in the non-MSVC path introduced by 0001: Linux runtime uses MXCSR and TSC while WASM must not include x86 intrinsics | `scripts/apply_patches.sh` (CI only) | Patch-series applicability checked in a temporary tree; native build/runtime verification pending GitHub Actions and an operator ISO run |
| `0002-native-linux-runtime.patch` | `port/runtime/hle/hle_dvd.cpp` | Under `MELEE_HEADLESS`, drain and join the DVD worker before C++ static destruction on Linux; Windows retains its detached worker | `scripts/apply_patches.sh` (CI only) | Patch-series applicability checked in a temporary tree; CI and ISO shutdown verification pending |

| `0003-portable-runtime-platform.patch` | `host/host.cpp`, `host/host.h`, `ppc/ppc.h` | Portable SHA-1, file/timing operations; restart explicitly unavailable off Windows; profiler cycles unavailable off Windows. Preserve Win32 behavior. | CI patch series | Pending clang/emcc runtime compile |
| `0004-ppc-fpscr-diagnostics.patch` | `ppc/ppc_runtime.cpp`, `ppc/ppc.h` | Keep MXCSR only on x86; count RN/NI requests and log each category once on non-x86, without emulation. | CI patch series | Pending WASM link/ISO observation |
| `0005-single-thread-workers.patch` | `hle/hle_dvd.cpp`, `host/host.cpp`, `hle/exi_slippi.cpp` | Inline DVD reads, log drain and Sys preload under MELEE_SINGLE_THREAD; preserve virtual DVD completion times. | CI patch series | Pending native/emcc compile |
| `0006-exi-portable-mkdir.patch` | `hle/exi_slippi.cpp` | Replace the sole Win32 directory creation call with nonthrowing filesystem operation. | CI patch series | Pending clang/emcc compile |

| `0007-gx-settings-boundary.patch` | `gx/gx_core.cpp`, `gx/pc_settings_shared.h`, new `gx/pc_settings_guest.h` | Move the guest menu observer declaration into a platform-neutral header, so FIFO decoding does not include Win32/XInput settings UI types. | CI patch series | clang run 36709850208 identified the include chain; verification pending |

## Why the FMA family goes through `wasm/compat/fma.h`

The patch's Emscripten branch used to call `std::fma` directly. Emscripten's libc is
musl, and musl's `fma.c` returns early when the addend is zero:

```
if (nz.e >= ZEROINFNAN) { if (nz.e > ZEROINFNAN) /* z==0 */ return x*y + z; ... }
```

emsdk 4.0.23, `system/lib/libc/musl/src/math/fma.c:56-60` (and again on the "exact +-0"
path at `:134-136`). That rounds the product and then adds the zero, so when the exact
product is nonzero but rounds to `-0` while the addend is `+0`, the sum is `+0` and the
sign of the exact result is lost. The probe measured it: `fma(-2^-1074, 2^-1074, +0)` must
be `-0`, and the pinned toolchain returned `+0` — 120 of the 20 264 divergent results in
the first classified run, 24 of them with fully ordinary operands.

Upstream fixed this in musl git and in Emscripten main by returning the product when the
addend is zero. `wasm/compat/fma.h` applies the same fix in our own shim rather than
patching the pinned toolchain in place. It needs one condition upstream does not, because
upstream reaches its early return only after `fma.c:54-55` has already diverted every
zero, infinity and NaN *factor* to `x*y + z`: when a factor is zero the exact product is a
signed zero and the correct result is the IEEE addition of the two zeros
(`fma(-0, 5, +0)` is `+0`, not `-0`).

The guard does not touch NaN *operands*, and the NaN bit pattern of an operation that had
no NaN operand is a different case: `fma.c:54-55` sends every non-finite operand through
ordinary WASM arithmetic, whose NaN sign and payload the specification leaves to the engine,
so before the pin a NaN *result* of such an operation was the platform's rather than the
reference's. That case is no longer left to the engine -- see the next section.

## The NaN-sign class: our own negation, not the platform's latitude

`fmsub`, `fnmadd` and `fnmsub` are written as one `fma` call with a negated operand
(`fma(a,c,-b)`, `fma(-a,c,-b)`, `fma(-a,c,b)`), which is exact for the value: the negation
lands on the product term before the single rounding. It is not exact for a NaN *operand*.
Negating a NaN flips its sign, and the x86 instructions these wrappers stand in for leave a
NaN operand's sign alone.

Measured in the probe run before this change (36661984096, 2026-09-30), the first of 18 680
`nan-sign` divergences:

```
fnmadd a=7ff8000000000001 c=0000000000000000 b=0000000000000000
       native=7ff8000000000001  wasm=fff8000000000001
```

Every one of the 18 680 had a NaN operand and not one had an ordinary operand, so this was
not the engine's NaN latitude: it was this patch's own sign flip, and a divergence the
reference does not have. `wasm/compat/fma.h` returns the first NaN operand quieted and
unnegated (x86's priority: multiplicand, multiplier, addend) instead of negating it, for
those three wrappers.

### Correction: `fmadd` was affected too, and the first fix was incomplete

An earlier version of this file said "`fmadd` passes its operands through untouched and is
unaffected". **The next probe run refuted that.** Run 36672598366 measured `nan-sign` 18 680
→ 64 and `nan-payload` 1 464 → 716, and the first example of each class was on an `fmadd`
path:

```
fmadds a=fff8000000001234 c=7ff8000000000000 b=0000000000000000
       native=fff8000000000000  wasm=7ff8000000000000     (nan-sign)
fmadd  a=7ff0000000000000 c=0000000000000000 b=fff8000000001234
       native=fff8000000001234  wasm=fff8000000000000     (nan-payload)
```

`fmadd` is `wasm_compat::fma` with no wrapper in between, and that function had no NaN guard:
a NaN operand went into the engine's arithmetic and came back as the engine's NaN. Two
symptoms in one defect — `NaN * NaN` losing the multiplicand's sign, and `inf * 0 + NaN`
returning the invalid-operation default NaN instead of the NaN operand.

`fma` now carries the same guard. The three wrappers keep their own, because they negate an
operand *before* calling `fma`: a guard inside `fma` would see an already flipped sign.
Measured in run 36677219860: `nan-sign` 0, `nan-payload` 0, 8 000 000 results with
identical digests, and the strict gate passing with no exemption. The x86 NaN priority order
is now a measurement rather than an expectation: 51 656 NaN-operand results, multi-NaN cases
included, match the reference bit for bit.

This is not the Q7 decision. Q7 asks whether NaN bits that come from the *platform's own*
arithmetic may differ; these changes remove divergences our shim invented, and every option
in Q7 required them gone. The Q7 question is now moot for this corpus: nothing diverges, so
there is nothing to exempt. `docs/OPEN_QUESTIONS.md` Q7 records that.


### The invalid-operation NaN is pinned to the reference's value (2026-10-03, `ci/wasm-arm64-parity`)

The arm64 job of the WASM probe runs the module the x86 job built under Node on aarch64 and
compares the two dumps. That is the browser-to-browser question, because the peers of a
netcode match are engines on different machines and not one Node build. Run 37097105278
measured **3,040 divergent results out of 8,000,000**, every one of them class `nan-sign`,
every one of them an invalid operation with no NaN operand, and the first of them at triple 12:

```
fmadd a=7ff0000000000000 c=0000000000000000 b=0000000000000000
      WASM-x86 fff8000000000000   WASM-arm64 7ff8000000000000
```

`0 * inf` and `inf - inf` are the invalid operations. x86 answers them with its indefinite
NaN, `0xFFF8000000000000`; ARM's default NaN is positive, `0x7FF8000000000000`. The
specification leaves that choice to the engine, and this shim had been leaving it there on
purpose, so the same module produced different bits on two architectures -- a desync waiting
for the frame that feeds `0 * inf` into an FMA, and the option `docs/OPEN_QUESTIONS.md` Q7
records as chosen, applied to the case that was still open.

`wasm/compat/fma.h` now pins it. `pinned(r)` returns the reference's indefinite NaN whenever
an operation that had no NaN operand produces a NaN: with no NaN operand that can only be an
invalid operation, so the test is exact and costs one compare per call. It wraps the two
places where the engine's arithmetic can produce that NaN -- the zero-addend path's
`x*y + z`, and the `std::fma` call.

| measured in CI | before (run 37097105278) | after (run 37101091371) |
| --- | ---: | ---: |
| WASM-x86 digest | `6b79b92a…f66afc9` | `6b79b92a…f66afc9` (unmoved) |
| WASM-arm64 digest | `ddb759d8…b86393e5` | `6b79b92a…f66afc9` (identical) |
| divergent results, WASM-x86 vs WASM-arm64 | 3,040 | **0** |
| divergent results, WASM vs native x86 intrinsics | 0 | 0 |

The x86 digest not moving is the check that the pin is a no-op where the engine already
returned the reference's value; the arm64 digest becoming the x86 one is the fix. Both jobs
print `GATE PASS`, and the x86 job still prints `arithmetic parity (native reference):
nan-vs-number=0, zero-sign=0, subnormal=0, value=0`.

Verified without a compiler, on the operator's VPS (rules 2 and 3): a model of
`wasm/probe/fma_vectors.cpp` and this shim reproduces the x86 dump byte for byte (0
mismatches in 8,000,000 results), reproduces the arm64 digest when the engine's NaN is the ARM
default, and counts exactly those 3,040 engine-NaN results. It also found the boundary this
change must not cross, and the corpus confirms it: the exact product of two finite doubles may
round to an infinity, and that is an overflow, not an invalid operation --
`fmsub(max, max, +inf)` is `-inf`. `wasm/probe/fma_shim_test.cpp` pins that case and the eight
invalid ones, each to the value the real module produced for that triple.

Not measured: what the pin costs on the hot path. `fmadd_ns_per_op` moved from 36.82 to 22.90
(x86) and from 23.71 to 25.06 (arm64) across runs and runners, so no cost is resolvable from
these numbers and none is claimed; it is one compare per call.

### 0008 — optional offline WASM decoder phase accounting

`0008-offline-decoder-cost.patch` specializes `host::SimCostScope` only under
`MELEE_OFFLINE_COST`, defined by the Emscripten core build. It reuses the pinned
GX scopes (`SIM_RECORD`, `SIM_SNAPSHOT`, `SIM_OBSERVE`, `SIM_DECODE`), with portable
nanosecond conversion independent of the offline host's zero `tsc_seconds`.
`native/headless_host.cpp` collects durations and invocation counts only when the
browser explicitly enables profiling before `callMain`. Native compilation keeps
the existing scope and no-op accumulator. No GX command, validation, guest write,
texture version, observer counter or floating-point option changes.

### 0009 — offline frame split (measurement only)

`0009-offline-frame-split.patch` adds collect-only scopes to the bodies of
`RenderObserver` construction/destruction (seven `Observe` kinds) and to the
`c.to_xfb` completion block in `gx_core.cpp`. The helper added to patch 0008
checks `offline_cost_mode == 1` before either clock read. Legacy mode retains
only its previous clocks. Native/non-offline builds have no new instrumentation.
Constructor and destructor costs are added together, while invocation counts use
constructor entries only. Guest function execution between them is excluded;
member initialization/destruction and the instrumentation's own bookkeeping are
not separately timed. No hook, decoder operation or guest write is removed.

The XFB block is **inside `SIM_DECODE`** (`drain_fifo` → `parse_command` → BP load),
so `end_frame_ms` is subtracted from `decode_rest_ms`, not `non_decode_ms`.
It includes scene/HUD capture, backend submission/recycling, draw destruction and
cache cleanup together; it does not isolate allocator/shared_ptr/hash-table costs.
`non_decode_rest_ms = non_decode_ms - observer_game_ms`; `rest_ms` now excludes
both new timed phases and equals `decode_rest_ms + non_decode_rest_ms`.
The report checks all five partition identities at the existing 0.00001 ms
rounding tolerance, retains signed residuals and rejects the old CSV schema.

`mark_ram_write` counts watched **block hits** only in collect mode: a range
spanning two watched blocks contributes two. This includes every caller (guest
stores and host bulk writes), not just guest store instructions. There is no
per-write clock. Watched blocks are scanned after the simulation timestamp;
min/max/last are gauges over the selected retraces, never a sum. Counters reset
at the existing interval boundaries; watched flags and versions are unchanged.
With profiling off, new flag checks remain but no new clocks/counter increments
run. Their actual disabled-path overhead has not been measured.

Observer-off was deliberately **not implemented**, per the requested reader gate:
`gx_core.cpp:457-476` constructs identities and reads `skinned`/`authored_pose` for
statistics in the compiled offline core (`native/offline_authored_stats.cpp`).
The pinned desktop consumers additionally include `gx_d3d12.cpp:1781`
(`identity`), `gx_shader.cpp:838-839` (`skinned`, `owner_player`), and subframe
pose sampling. `passes` is read/updated to derive `current_pass` inside the
observer. Thus “nobody reads these data” is false even though the WebGPU backend
does not currently consume all of these fields. `?observer=off` is not supported.

### Optional live browser input (first playable)

No upstream patch or pin change. `native/headless_input.cpp` consults an optional host callback
before the existing script path; null/default and browser modules without `Module.livePad` retain
that path. `wasm/core/live_input.cpp` supplies the browser-only PADStatus adapter. This is host input
integration, not a change to guest simulation or virtual-time scheduling. Oracle parity remains an
operator verification, not an assertion inferred from the code diff.
