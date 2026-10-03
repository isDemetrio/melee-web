// Guards the WASM FMA shim against the musl fma.c zero-addend shortcut, which loses the
// sign of an exact zero, and against a NaN operand reaching the engine's arithmetic instead
// of being returned the way the hardware returns it (wasm/compat/fma.h). Runs under Node
// from ctest in the WASM build only, through the patched ppc.h, so it exercises the code
// path the port uses.
//
// Every expected pattern here was confirmed against the platform's correctly rounded
// fma before it was written; the probe's corpus comparison against the native x86
// intrinsics is the measurement that matters, this is the cheap regression net. The
// NaN-operand block at the end is the exception to "confirmed against math.fma": its
// reference is the native intrinsic build, and its patterns come from the probe run
// that measured them (see the comment there).
#include "ppc.h"
#include "wasm/compat/fma.h"
#include <cstdint>
#include <cstdio>
#include <cstring>

static int failures = 0;

static uint64_t bits(double d) { uint64_t u; std::memcpy(&u, &d, 8); return u; }
static double from_bits(uint64_t u) { double d; std::memcpy(&d, &u, 8); return d; }

static void expect(const char* what, double got, uint64_t want) {
  const uint64_t g = bits(got);
  if (g != want) {
    std::printf("FAIL %-46s got=%016llx want=%016llx\n", what,
                (unsigned long long)g, (unsigned long long)want);
    ++failures;
  } else {
    std::printf("ok   %-46s %016llx\n", what, (unsigned long long)g);
  }
}

// Edge operands, as raw patterns.
constexpr uint64_t kMinSub = 0x0000000000000001ull;        // 2^-1074
constexpr uint64_t kMinSubNeg = 0x8000000000000001ull;     // -2^-1074
constexpr uint64_t kTwoPowNeg500 = 0x20B0000000000000ull;  // 2^-500
constexpr uint64_t kTwoPowNeg600Neg = 0x9A70000000000000ull;  // -2^-600
constexpr uint64_t kOnePlus2PowNeg52 = 0x3FF0000000000001ull;   // 1 + 2^-52
constexpr uint64_t kNegOnePlus2PowNeg51 = 0xBFF0000000000002ull;  // -(1 + 2^-51)
constexpr uint64_t kNegZero = 0x8000000000000000ull;
constexpr uint64_t kPosZero = 0x0000000000000000ull;
constexpr uint64_t kTwoPowNeg104 = 0x3970000000000000ull;  // 2^-104

int main() {
  static_assert(sizeof(double) == 8, "IEEE binary64 required");

  // The zero-sign cases the probe reported: the exact product is nonzero but rounds to
  // -0, and the addend is +0. musl's shortcut adds the zero and returns +0.
  expect("fnmsub(2^-1074, 2^-1074, +0)", ppc::fnmsub(from_bits(kMinSub), from_bits(kMinSub), 0.0), kNegZero);
  expect("fmadd(2^-1074, -2^-1074, +0)", ppc::fmadd(from_bits(kMinSub), from_bits(kMinSubNeg), 0.0), kNegZero);
  expect("fmadd(2^-500, -2^-600, +0)", ppc::fmadd(from_bits(kTwoPowNeg500), from_bits(kTwoPowNeg600Neg), 0.0), kNegZero);
  expect("fnmsub(2^-1074, 2^-1074, -0)", ppc::fnmsub(from_bits(kMinSub), from_bits(kMinSub), from_bits(kNegZero)), kNegZero);
  expect("fmsub(2^-1074, 2^-1074, -0)", ppc::fmsub(from_bits(kMinSub), from_bits(kMinSub), from_bits(kNegZero)), kPosZero);

  // The exact product is a signed zero here, so the exact sum is the IEEE addition of
  // two zeros and the product alone is not the answer: -0 + +0 is +0. A guard that
  // simply returned x*y when z is zero would flip these to -0 and diverge from the
  // hardware reference in the opposite direction.
  expect("fmadd(-0, 5, +0)", ppc::fmadd(from_bits(kNegZero), 5.0, 0.0), kPosZero);
  expect("fmadd(0, -5, +0)", ppc::fmadd(0.0, -5.0, 0.0), kPosZero);
  expect("fmadd(0, 5, +0)", ppc::fmadd(0.0, 5.0, 0.0), kPosZero);
  expect("fnmadd(0, 5, +0)", ppc::fnmadd(0.0, 5.0, 0.0), kNegZero);

  // One rounding over the exact product: a non-fused (x*y)+z returns +0 here.
  expect("fma(1+2^-52, 1+2^-52, -(1+2^-51))",
         wasm_compat::fma(from_bits(kOnePlus2PowNeg52), from_bits(kOnePlus2PowNeg52),
                          from_bits(kNegOnePlus2PowNeg51)), kTwoPowNeg104);
  // A nonzero addend still delegates to libc's fma, and the subnormal addend wins.
  expect("fmadd(2^-1074, 2^-1074, 2^-1074)",
         ppc::fmadd(from_bits(kMinSub), from_bits(kMinSub), from_bits(kMinSub)), kMinSub);

  // Sign conventions of the four wrappers, on values where the result is exact.
  expect("fmadd(3, 4, 5) = 17", ppc::fmadd(3.0, 4.0, 5.0), bits(17.0));
  expect("fmsub(3, 4, 5) = 7", ppc::fmsub(3.0, 4.0, 5.0), bits(7.0));
  expect("fnmadd(3, 4, 5) = -17", ppc::fnmadd(3.0, 4.0, 5.0), bits(-17.0));
  expect("fnmsub(3, 4, 5) = -7", ppc::fnmsub(3.0, 4.0, 5.0), bits(-7.0));

  // The NaN-operand rule of the three negated wrappers. The reference is the native x86
  // intrinsic build in the same CI run: `fnmadd(NaN, 0, 0)` was measured there as
  // 7ff8000000000001 -- the first of the 18 680 nan-sign divergences that the negating
  // shim produced (probe run 36661984096). The rule these pin is "the first NaN operand,
  // quieted, unnegated"; the probe's corpus comparison re-measures every one of these
  // bit patterns against the hardware, so this is the regression net and not the proof.
  constexpr uint64_t kQNanA = 0x7ff8000000000001ull;     // quiet NaN, positive, payload 1
  constexpr uint64_t kQNanB = 0xfff8000000001234ull;     // quiet NaN, negative, payload 0x1234
  constexpr uint64_t kSNanB = 0x7ff0000000000001ull;     // signalling NaN, positive
  expect("fnmadd(NaN, 0, 0) keeps the operand's sign",
         ppc::fnmadd(from_bits(kQNanA), 0.0, 0.0), kQNanA);
  expect("fnmsub(NaN, 0, 0) keeps the operand's sign",
         ppc::fnmsub(from_bits(kQNanA), 0.0, 0.0), kQNanA);
  expect("fmsub(1, 1, NaN) returns the addend, unnegated",
         ppc::fmsub(1.0, 1.0, from_bits(kQNanB)), kQNanB);
  expect("fnmadd(1, 1, NaN) returns the addend, unnegated",
         ppc::fnmadd(1.0, 1.0, from_bits(kQNanB)), kQNanB);
  expect("fnmsub(1, 1, NaN) returns the addend, unnegated",
         ppc::fnmsub(1.0, 1.0, from_bits(kQNanB)), kQNanB);
  expect("fnmsub(1, 1, sNaN) quiets the operand and keeps its sign",
         ppc::fnmsub(1.0, 1.0, from_bits(kSNanB)), kQNanA);
  expect("fnmadd(NaN, NaN, NaN) returns the first operand",
         ppc::fnmadd(from_bits(kQNanA), from_bits(kQNanB), from_bits(kSNanB)), kQNanA);
  expect("fnmadd(1, NaN, 1) returns the multiplier",
         ppc::fnmadd(1.0, from_bits(kQNanB), 1.0), kQNanB);

  // The same rule for `fmadd`, which reaches `wasm_compat::fma` with no wrapper in between.
  // That operation had no guard at all, and the probe measured what it cost: 64 `nan-sign`
  // and 716 `nan-payload` divergences in run 36672598366, every one of them with a NaN
  // operand, while the three guarded wrappers contributed none. The two patterns below are
  // that run's own first examples of each class, turned into expectations.
  constexpr uint64_t kPosInf = 0x7ff0000000000000ull;
  constexpr uint64_t kQNanZero = 0x7ff8000000000000ull;  // quiet NaN, positive, payload 0
  expect("fmadd(inf, 0, NaN) returns the NaN operand",
         ppc::fmadd(from_bits(kPosInf), 0.0, from_bits(kQNanB)), kQNanB);
  expect("fmadd(NaN, NaN, +0) returns the first operand",
         ppc::fmadd(from_bits(kQNanB), from_bits(kQNanZero), 0.0), kQNanB);
  expect("fmadd(NaN, 5, +0) is not swallowed by the zero-addend path",
         ppc::fmadd(from_bits(kQNanA), 5.0, 0.0), kQNanA);
  expect("fmadd(1, sNaN, 1) quiets the operand and keeps its sign",
         ppc::fmadd(1.0, from_bits(kSNanB), 1.0), kQNanA);
  expect("fmadd(NaN, NaN, 1) returns the first operand",
         ppc::fmadd(from_bits(kQNanA), from_bits(kQNanB), 1.0), kQNanA);
  // An invalid operation with no NaN operand. x86's FMA answers it with its indefinite NaN,
  // 0xfff8000000000000; the WASM specification leaves the same result to the engine, and
  // arm64 gives 0x7ff8000000000000 instead -- measured on the arm64 job (run 37097105278):
  // 3 040 of the 8 000 000 corpus results, every one of them this class and this operand
  // pair. The shim pins the reference's value (wasm/compat/fma.h), because the peers of a
  // netcode match are engines on different architectures.
  constexpr uint64_t kNegInf = 0xfff0000000000000ull;
  constexpr uint64_t kIndefinite = 0xfff8000000000000ull;
  constexpr uint64_t kMaxDouble = 0x7fefffffffffffffull;
  expect("fmadd(inf, 0, +0) is the indefinite NaN",
         ppc::fmadd(from_bits(kPosInf), 0.0, 0.0), kIndefinite);
  expect("fmadd(0, inf, +0) is the indefinite NaN",
         ppc::fmadd(0.0, from_bits(kPosInf), 0.0), kIndefinite);
  expect("fmadd(-inf, 0, +0) is the indefinite NaN",
         ppc::fmadd(from_bits(kNegInf), 0.0, 0.0), kIndefinite);
  expect("fmadd(inf, 0, 5) is the indefinite NaN",
         ppc::fmadd(from_bits(kPosInf), 0.0, 5.0), kIndefinite);
  expect("fmadd(inf, 1, -inf) is the indefinite NaN",
         ppc::fmadd(from_bits(kPosInf), 1.0, from_bits(kNegInf)), kIndefinite);
  expect("fmsub(inf, 0, +0) is the indefinite NaN",
         ppc::fmsub(from_bits(kPosInf), 0.0, 0.0), kIndefinite);
  expect("fnmadd(inf, 0, +0) is the indefinite NaN",
         ppc::fnmadd(from_bits(kPosInf), 0.0, 0.0), kIndefinite);
  expect("fnmsub(inf, 0, +0) is the indefinite NaN",
         ppc::fnmsub(from_bits(kPosInf), 0.0, 0.0), kIndefinite);
  expect("the single path: fs(fmadd(inf, 0, +0)) is the indefinite NaN",
         ppc::fs(ppc::fmadd(from_bits(kPosInf), 0.0, 0.0)), kIndefinite);
  // The boundary of that rule, and the case the corpus caught while this was being written:
  // the exact product of two finite doubles may round to an infinity, and that is an
  // overflow, not an invalid operation -- `fmsub(max, max, +inf)` is `max*max - inf`, and
  // the exact product is finite, so the answer is -inf. Pinning a *rounded* product and
  // then adding the infinity would answer with a NaN.
  expect("fmsub(max, max, +inf) is -inf",
         ppc::fmsub(from_bits(kMaxDouble), from_bits(kMaxDouble), from_bits(kPosInf)), kNegInf);
  expect("fmadd(max, max, -inf) is -inf",
         ppc::fmadd(from_bits(kMaxDouble), from_bits(kMaxDouble), from_bits(kNegInf)), kNegInf);
  expect("fmadd(max, max, +inf) is +inf",
         ppc::fmadd(from_bits(kMaxDouble), from_bits(kMaxDouble), from_bits(kPosInf)), kPosInf);

  // What is deliberately not asserted here: what `ppc::fs` does to a NaN's payload. The
  // double->single step is the engine's, not the shim's, and the probe's per-path table is
  // what measures it (all four single paths, against the native reference).

  if (failures) {
    std::printf("\n%d expectation(s) failed\n", failures);
    return 1;
  }
  std::puts("\nall FMA shim expectations hold");
  return 0;
}
