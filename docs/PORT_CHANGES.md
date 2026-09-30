# Port changes

Every modification this project makes to upstream code is recorded here before it is
made, together with the reason. The upstream is a pinned submodule and is never edited in
place: changes live as patches in `patches/`, applied by `scripts/apply_patches.sh` onto
the CI checkout only.

| Patch | Upstream files touched | Reason | Applied by | Verified by |
| --- | --- | --- | --- | --- |
| `0001-ppc-portable-fma-and-intrinsics.patch` | `port/runtime/ppc/ppc.h` | Portable intrinsic shim and single-rounding FMA family for Emscripten/non-MSVC, routed through `wasm/compat/fma.h`, whose `fma` is `std::fma` plus the guard for musl `fma.c`'s zero-addend shortcut (see below) and whose `fmsub`/`fnmadd`/`fnmsub` refuse to negate a NaN operand (see "The NaN-sign class" below); MSVC branch unchanged | `scripts/apply_patches.sh` (CI only) | Local `git apply --check`; `wasm/probe/fma_shim_test.cpp` and the corpus comparison in the WASM probe |
| `0001-ppc-portable-fma-and-intrinsics.patch` | `port/runtime/gx/gx_texture.h` | Explicit `<stddef.h>` for the public `size_t` parameter; avoid reliance on MSVC transitive includes | `scripts/apply_patches.sh` (CI only) | Local `git apply --check`; texture snapshot test pending CI |

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
reference does not have. `wasm/compat/fma.h` now returns the first NaN operand quieted and
unnegated (x86's priority: multiplicand, multiplier, addend) instead of negating it, for
those three wrappers only. `fmadd` passes its operands through untouched and is unaffected.

This is not the Q7 decision. Q7 asks whether NaN bits that come from the *platform's own*
arithmetic may differ; this change removes divergences our shim invented, and every option in
Q7 requires them gone. Status: written, `git apply --check` clean, unit-tested in
`wasm/probe/fma_shim_test.cpp`; the corpus comparison that must show `nan-sign 0` is the
next probe run.

