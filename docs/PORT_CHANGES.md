# Port changes

Every modification this project makes to upstream code is recorded here before it is
made, together with the reason. The upstream is a pinned submodule and is never edited in
place: changes live as patches in `patches/`, applied by `scripts/apply_patches.sh` onto
the CI checkout only.

| Patch | Upstream files touched | Reason | Applied by | Verified by |
| --- | --- | --- | --- | --- |
| `0001-ppc-portable-fma-and-intrinsics.patch` | `port/runtime/ppc/ppc.h` | Portable intrinsic shim and single-rounding FMA family for Emscripten/non-MSVC, routed through `wasm/compat/fma.h`: `fma` is `std::fma` plus the guard for musl `fma.c`'s zero-addend shortcut and the guard that returns a NaN operand quieted and unnegated, and `fmsub`/`fnmadd`/`fnmsub` carry their own copy of the NaN guard because they negate an operand before calling `fma` (see below); MSVC branch unchanged | `scripts/apply_patches.sh` (CI only) | Local `git apply --check`; `wasm/probe/fma_shim_test.cpp` and the corpus comparison in the WASM probe (run 36677219860: 0 divergences in 8 000 000 results) |
| `0001-ppc-portable-fma-and-intrinsics.patch` | `port/runtime/gx/gx_texture.h` | Explicit `<stddef.h>` for the public `size_t` parameter; avoid reliance on MSVC transitive includes | `scripts/apply_patches.sh` (CI only) | Local `git apply --check`; `ctest` in the WASM probe builds and runs `texture_snapshot_test` under Node |
| `0002-native-linux-runtime.patch` | `port/runtime/ppc/ppc.h` | Restore native x86 `<immintrin.h>` in the non-MSVC path introduced by 0001: Linux runtime uses MXCSR and TSC while WASM must not include x86 intrinsics | `scripts/apply_patches.sh` (CI only) | Patch-series applicability checked in a temporary tree; native build/runtime verification pending GitHub Actions and an operator ISO run |
| `0002-native-linux-runtime.patch` | `port/runtime/hle/hle_dvd.cpp` | Under `MELEE_HEADLESS`, drain and join the DVD worker before C++ static destruction on Linux; Windows retains its detached worker | `scripts/apply_patches.sh` (CI only) | Patch-series applicability checked in a temporary tree; CI and ISO shutdown verification pending |

| `0003-portable-runtime-platform.patch` | `host/host.cpp`, `host/host.h`, `ppc/ppc.h` | Portable SHA-1, file/timing operations; restart explicitly unavailable off Windows; profiler cycles unavailable off Windows. Preserve Win32 behavior. | CI patch series | Pending clang/emcc runtime compile |
| `0004-ppc-fpscr-diagnostics.patch` | `ppc/ppc_runtime.cpp`, `ppc/ppc.h` | Keep MXCSR only on x86; count RN/NI requests and log each category once on non-x86, without emulation. | CI patch series | Pending WASM link/ISO observation |
| `0005-single-thread-workers.patch` | `hle/hle_dvd.cpp`, `host/host.cpp`, `hle/exi_slippi.cpp` | Inline DVD reads, log drain and Sys preload under MELEE_SINGLE_THREAD; preserve virtual DVD completion times. | CI patch series | Pending native/emcc compile |
| `0006-exi-portable-mkdir.patch` | `hle/exi_slippi.cpp` | Replace the sole Win32 directory creation call with nonthrowing filesystem operation. | CI patch series | Pending clang/emcc compile |

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

The guard does not touch NaN bit patterns. `fma.c:54-55` still sends every non-finite
operand through ordinary WASM arithmetic, whose NaN sign and payload the specification
leaves to the engine, so a NaN *result* of a non-finite operation remains the platform's
rather than the reference's. That residual is measured by the probe and is a policy question
for the operator (`docs/OPEN_QUESTIONS.md` Q7); the gate stays strict until it is answered.

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

