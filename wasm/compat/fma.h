#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>

// Correctly rounded FMA for the WASM build, with two deliberate guards: the sign of an
// exact zero (below), and the sign of a NaN operand in the three wrappers that negate
// an operand (at the end of this file).
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
// produced by arithmetic to the engine, so a NaN *result* of a non-finite operation stays
// the platform's rather than the reference's. That difference is measured by the probe and
// is parked as a policy question (`wasm/README.md`, `docs/OPEN_QUESTIONS.md` Q7); it is not
// papered over here.
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

// ---- the sign of a NaN operand, in the three wrappers that negate one ----
//
// `fmsub(a,c,b)` is `a*c - b`, `fnmadd(a,c,b)` is `-(a*c) - b` and `fnmsub(a,c,b)` is
// `-(a*c) + b`. Each is written as one `fma` call with a negated operand, which is exact
// for the value -- the negation is applied to the product term before the single rounding,
// not to an already-rounded result -- but the negation is a sign operation, and applying it
// to a NaN *operand* changes the result: the NaN that comes back out carries the flipped
// sign. The x86 instructions these wrappers stand in for do not do that.
//
// Measured, WASM probe run 36661984096 (2026-09-30), the first of 18,680 `nan-sign`
// divergences in that run:
//
//     fnmadd a=7ff8000000000001 c=0000000000000000 b=0000000000000000
//     native=7ff8000000000001   wasm=fff8000000000001
//
// Every one of those 18,680 had a NaN operand and none had an ordinary one, so this was not
// the platform's NaN latitude: it was our own negation, and it is a divergence the reference
// does not have. The guard below removes it by returning the NaN operand the way the
// hardware does -- quieted, unnegated, first NaN in operand order, which is x86's priority
// (multiplicand, multiplier, addend).
//
// What it does not claim: the NaN bits a *non-finite* operation produces when no operand is
// a NaN (0*inf and the like) remain the engine's, and so do the payload bits a NaN result
// carries through the arithmetic paths. Those are Q7 and are left alone.
inline double quiet(double v) {
  uint64_t u;
  std::memcpy(&u, &v, 8);
  u |= 0x0008000000000000ull;  // the quiet bit: x86 quiets a signalling NaN operand
  std::memcpy(&v, &u, 8);
  return v;
}

// True when an operand is a NaN, with that operand quieted into `out`; operand order is
// x86's priority. `x != x` is the portable NaN test and is false for infinities, so an
// infinite operand keeps taking the arithmetic path.
inline bool nan_operand(double x, double y, double z, double& out) {
  if (x != x) { out = quiet(x); return true; }
  if (y != y) { out = quiet(y); return true; }
  if (z != z) { out = quiet(z); return true; }
  return false;
}

inline double fmsub(double a, double c, double b) {
  double nan;
  if (nan_operand(a, c, b, nan)) return nan;
  return fma(a, c, -b);
}

inline double fnmadd(double a, double c, double b) {
  double nan;
  if (nan_operand(a, c, b, nan)) return nan;
  return fma(-a, c, -b);
}

inline double fnmsub(double a, double c, double b) {
  double nan;
  if (nan_operand(a, c, b, nan)) return nan;
  return fma(-a, c, b);
}

}  // namespace wasm_compat
