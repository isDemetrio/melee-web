// Test-only scalar stand-in for the few <wasm_simd128.h> operations wasm/render/texture_decode.h
// uses, so its kernels can be built and checked natively (g++) where there is no wasm toolchain.
// CI also builds the same check with em++ -msimd128 against the real header (kernels_check.cpp).
#pragma once
#include <cstdint>
#include <cstring>
#define GXW_SIMD
struct v128_t { uint8_t b[16]; };
inline v128_t wasm_v128_load(const void* p) { v128_t v; std::memcpy(v.b, p, 16); return v; }
inline void wasm_v128_store(void* p, v128_t v) { std::memcpy(p, v.b, 16); }
inline v128_t wasm_i8x16_splat(int8_t x) { v128_t v; std::memset(v.b, uint8_t(x), 16); return v; }
inline v128_t wasm_v128_and(v128_t a, v128_t b) { for (int i = 0; i < 16; ++i) a.b[i] &= b.b[i]; return a; }
inline v128_t wasm_v128_or(v128_t a, v128_t b) { for (int i = 0; i < 16; ++i) a.b[i] |= b.b[i]; return a; }
inline v128_t wasm_i8x16_shl(v128_t a, uint32_t n) { for (int i = 0; i < 16; ++i) a.b[i] = uint8_t(a.b[i] << (n & 7)); return a; }
inline v128_t wasm_u8x16_shr(v128_t a, uint32_t n) { for (int i = 0; i < 16; ++i) a.b[i] = uint8_t(a.b[i] >> (n & 7)); return a; }
// Out-of-range indices give 0, as the instruction specifies.
inline v128_t wasm_i8x16_swizzle(v128_t a, v128_t idx) {
  v128_t r; for (int i = 0; i < 16; ++i) r.b[i] = idx.b[i] < 16 ? a.b[idx.b[i]] : 0; return r;
}
inline v128_t emu_shuffle(v128_t a, v128_t b, const int (&k)[16]) {
  v128_t r; for (int i = 0; i < 16; ++i) r.b[i] = k[i] < 16 ? a.b[k[i]] : b.b[k[i] - 16]; return r;
}
#define wasm_i8x16_shuffle(a, b, ...) emu_shuffle((a), (b), {__VA_ARGS__})
