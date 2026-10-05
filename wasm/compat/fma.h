#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>

// Correctly rounded FMA for the WASM build, with two deliberate guards: the sign of an
// exact zero (below), and NaN operands. The hardware does not compute with a NaN operand,
// it returns the first one quieted and unnegated, and the WASM build must do the same:
// `fma` below carries that guard, and the three negating wrappers carry their own because
// they negate an operand before they call `fma`.
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
// What this does NOT do, and what `pinned` below does instead: `fma.c:54-55` also
// short-circuits every non-finite operand to ordinary arithmetic, and the WASM
// specification leaves the sign and payload of a NaN produced by arithmetic to the engine,
// so a NaN *result* of an operation that has no NaN operand (`0 * inf`) was the platform's
// rather than the reference's. NaN operands are a different case and are handled below:
// the hardware returns the operand itself.
//
// That residual stopped being a policy question when it was measured across engines. The
// arm64 job of the WASM probe (run 37097105278) runs this same module -- built once on
// x86 -- under Node on aarch64, and the two architectures disagreed on 3,040 of the
// 8,000,000 corpus results: every one of them `nan-sign`, every one of them an invalid
// operation with no NaN operand, the first at triple 12, `fmadd a=7ff0000000000000
// c=0000000000000000 b=0000000000000000`, x86 `fff8000000000000` against arm64
// `7ff8000000000000`. The peers of a netcode match are engines on different machines, so
// that difference is a desync waiting for a frame that feeds `0 * inf` into an FMA, and
// `pinned` removes it by returning the reference's own indefinite NaN whatever the engine
// would have produced. It is the option `docs/OPEN_QUESTIONS.md` Q7 already recorded as
// chosen, applied to the case that was still open.
namespace wasm_compat {

// The quiet bit: x86 quiets a signalling NaN operand and keeps its payload.
inline double quiet(double v) {
  uint64_t u;
  std::memcpy(&u, &v, 8);
  u |= 0x0008000000000000ull;
  std::memcpy(&v, &u, 8);
  return v;
}

// True when an operand is a NaN, with that operand quieted into `out`; operand order is
// x86's priority (multiplicand, multiplier, addend). `x != x` is the portable NaN test and
// is false for infinities, so an infinite operand keeps taking the arithmetic path.
inline bool nan_operand(double x, double y, double z, double& out) {
  if (x != x) { out = quiet(x); return true; }
  if (y != y) { out = quiet(y); return true; }
  if (z != z) { out = quiet(z); return true; }
  return false;
}

// The "indefinite" NaN an x86 FMA returns for an invalid operation: quiet, payload 0,
// sign set, 0xFFF8000000000000. Confirmed against the native reference build, not assumed:
// the probe's corpus comparison runs the unpatched upstream `ppc.h` with the x86
// `_mm_fmadd_sd` intrinsics and the WASM shim side by side and reports no differing line
// in 8,000,000 results (run 36677219860), and the arm64 job's classification table
// (run 37097105278) prints this value for all eight paths at its first divergent triple.
inline double invalid_nan() {
  uint64_t u = 0xfff8000000000000ull;
  double v;
  std::memcpy(&v, &u, 8);
  return v;
}

// Pin the result of an operation that had no NaN operand. With no NaN operand the only way
// to a NaN result is an invalid operation (`0 * inf`, `inf - inf`), so this test is exact.
// It is one compare per call and it can only fire when an operand is infinite or zero. On
// x86 the engine already returns `invalid_nan()`, so
// this changes nothing there -- the corpus digest of the x86 build is the same before and
// after (6b79b92a3bc1fb1699853e1c8c671d37aaf64f82378bcb9d393387480f66afc9) -- while on
// arm64 it turns 3,040 divergent results into 0.
inline double pinned(double r) { return r != r ? invalid_nan() : r; }

// True when x*y is exact in a double: both factors normal with unbiased exponents in
// [-300, 300], so the product is a normal double far from overflow and underflow, and at most
// 53 significant bits between them. A double with t trailing zero bits in its 52-bit fraction
// has 53 - t significant bits, so the condition is t(x) + t(y) >= 53. Zeros, subnormals,
// infinities and NaNs all fail the exponent test and keep the general path.
inline bool exact_product(double x, double y) {
  uint64_t ux, uy;
  std::memcpy(&ux, &x, 8);
  std::memcpy(&uy, &y, 8);
  const uint32_t ex = uint32_t(ux >> 52) & 0x7FFu, ey = uint32_t(uy >> 52) & 0x7FFu;
  if (ex - 723u > 600u || ey - 723u > 600u) return false;
  const uint64_t fx = ux & 0x000FFFFFFFFFFFFFull, fy = uy & 0x000FFFFFFFFFFFFFull;
  const int tx = fx ? __builtin_ctzll(fx) : 52, ty = fy ? __builtin_ctzll(fy) : 52;
  return tx + ty >= 53;
}

inline double fma(double x, double y, double z) {
  // x86's FMA does not compute with a NaN operand: the result is the first NaN operand,
  // quieted and unnegated. musl's `fma.c:54-55` diverts every non-finite operand to
  // ordinary WASM arithmetic instead, and the WASM specification leaves the sign and
  // payload of a NaN that arithmetic produces to the engine, so without this guard the
  // result is the engine's NaN rather than the operand the hardware would return.
  //
  // Measured in probe run 36672598366 (2026-09-30), where `fmadd` was the one operation
  // still without this guard and the other three had just been fixed: 64 `nan-sign` and
  // 716 `nan-payload` divergences were left, every one of them with a NaN operand. The
  // first `nan-payload` of that run was
  //
  //     fmadd a=7ff0000000000000 c=0000000000000000 b=fff8000000001234
  //     native=fff8000000001234   wasm=fff8000000000000
  //
  // -- `inf * 0 + NaN` returning the invalid-operation default NaN instead of the NaN
  // operand. The first `nan-sign` was `fmadds a=fff8000000001234 c=7ff8000000000000
  // b=0000000000000000`, native `fff8000000000000` against wasm `7ff8000000000000`: two
  // NaN operands, and `NaN * NaN` lost the multiplicand's sign.
  //
  // This removes a divergence the shim invented. The other NaN case -- the bit pattern the
  // platform's *own* arithmetic produces when no operand is a NaN (`0 * inf` and the like)
  // -- is what `pinned` below replaces with the reference's.
  double nan;
  if (nan_operand(x, y, z, nan)) return nan;
  // A zero factor makes the exact product a signed zero, so the exact sum is the IEEE sum
  // of that zero and z and ordinary addition already gives it the right sign. A matrix is
  // full of these -- the off-diagonal zeros of every axis whose rotation is zero -- and
  // taking the case here is one compare. Left to the general path it costs the
  // `exact_product` scan and then libc's `fma`, which normalizes x, y and z (three calls,
  // `fma.c:40-42`) before reaching the same `x*y + z` shortcut; the profile put that
  // libc path at 2.3% of an in-match frame, all of it on this case
  // (docs/CORE_COST_BROWSER.md). `x == 0.0` is false for NaN, so an infinite factor keeps
  // taking this path: with the other factor zero that product is an invalid operation, and
  // `pinned` is what makes its result the reference's on every engine.
  if (x == 0.0 || y == 0.0) return pinned(x * y + z);
  // `z == 0.0` is true for -0.0 as well.
  if (z == 0.0) {
    // The factors are nonzero, so the exact product is nonzero: the exact sum is that
    // product and the correctly rounded product is the correctly rounded fused result,
    // sign of an underflow to -0 included.
    return x * y;
  }
  // An exact product needs no fused hardware: when x*y is representable in a double, `x*y + z`
  // rounds once, over the exact sum, which is the definition of the fused result. That holds
  // whenever the two factors have at most 53 significant bits between them and the product
  // neither overflows nor underflows. The single-precision and paired-single paths
  // (port/recomp/emit.py, fmadds/ps_madd) pass a float (24 bits) and `f25(c)` (at most 26), so
  // 50 bits: their products are always exact. musl's `fma` reconstructs the same answer in
  // software, and that was 7-12% of an in-match frame (docs/CORE_COST_BROWSER.md).
  if (exact_product(x, y)) return pinned(x * y + z);
  return pinned(std::fma(x, y, z));
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
//
// These three keep their own copy of the guard even though `fma` above now has one, because
// they negate an operand *before* calling it: `fma(-a, c, -b)` would hand `fma` an already
// flipped NaN, and the guard would faithfully return the wrong sign. Checking the operands
// as the port received them is the only way to return what the instruction returns.
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
