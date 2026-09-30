#pragma once
#include <cmath>

// Correctly rounded FMA for the WASM build, with one deliberate guard.
//
// The four FMA helpers in the pinned `port/runtime/ppc/ppc.h` must round once, over the
// exact product, and must keep the sign of an exact zero. Emscripten's libc (musl) does
// not: `fma.c` returns early when the addend is zero,
//
//     if (nz.e >= ZEROINFNAN) { if (nz.e > ZEROINFNAN) /* z==0 */ return x*y + z; ... }
//
// (read in emsdk 4.0.23, `system/lib/libc/musl/src/math/fma.c:56-60`; the same shortcut
// appears on the "exact +-0" path at `:134-136`). That computes the product with one
// rounding and then adds the zero, so when the exact product is nonzero but rounds to
// -0 while the addend is +0, the sum is +0 and the sign of the exact result is lost.
//
// Worked example, the first zero-sign divergence the probe printed:
//
//     fma(-2^-1074, 2^-1074, +0)   exact product -2^-2148, exact sum -2^-2148
//     correctly rounded            -0   (0x8000000000000000)
//     musl's shortcut              -0 + +0 = +0   (0x0000000000000000)
//
// Upstream fixed this in musl git and in Emscripten main by returning the product when
// the addend is zero. This shim applies the same fix instead of patching the pinned
// toolchain in place -- with one extra condition that upstream does not need. Upstream
// reaches its early return only after `fma.c:54-55` has already diverted every zero,
// infinity and NaN *factor* to `x*y + z`, so for upstream the product at that point is
// guaranteed nonzero. This shim delegates to libc for every nonzero addend, so it has
// to make that check itself: when a factor is zero the exact product is a signed zero
// and the correct result is the IEEE addition of the two zeros, not the product.
// `fma(-0, 5, +0)` is +0, while a bare `return x*y` would give -0.
//
// Every expected bit pattern below was confirmed against the platform's correctly
// rounded `fma` (CPython `math.fma`, see the test); the probe then measures the whole
// corpus against the native x86 intrinsics, which is the reference that counts.
//
// What this does NOT do: `fma.c:54-55` also short-circuits every non-finite operand to
// ordinary arithmetic, and the WASM specification leaves the sign and payload of a NaN
// produced by arithmetic to the engine, so NaN results stay the platform's rather than
// the reference's. That difference is measured by the probe and is parked as a policy
// question (`wasm/README.md`, `docs/OPEN_QUESTIONS.md` Q7); it is not papered over here.
namespace wasm_compat {

inline double fma(double x, double y, double z) {
  // `z == 0.0` is true for -0.0 as well. With a nonzero addend the call is libc's fma,
  // so the hot path pays this one compare and nothing else.
  if (z == 0.0) {
    // A zero factor makes the exact product a signed zero: the exact sum is the IEEE
    // sum of that zero and z, and ordinary addition already gives it the right sign.
    // `x == 0.0` is false for NaN, so NaN and infinite factors keep taking this path
    // and are propagated by the arithmetic itself.
    if (x == 0.0 || y == 0.0) return x * y + z;
    // Otherwise the exact product is nonzero, so the exact sum is that product and the
    // correctly rounded product is the correctly rounded fused result, sign of an
    // underflow to -0 included.
    return x * y;
  }
  return std::fma(x, y, z);
}

}  // namespace wasm_compat
