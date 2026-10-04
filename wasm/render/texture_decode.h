// Texture decoding for the WebGPU backend: gx::decode_texture, with exact fast paths for the formats
// the game decodes.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// What it does. Each fast path produces the bytes gx_texture.cpp's decode_texture produces, for full
// blocks only; every other level (partial blocks: the small mips, odd sizes) and every other format
// goes to gx::decode_texture unchanged, because partial blocks are where the reference's bounds
// check matters and the kernels have none.
//   I4 (0), I8 (1), IA4 (2), IA8 (3), RGBA8 (6): byte moves and e4(n) = n*17 = (n << 4) | n, done
//     with v128 shuffles, nibble masks and shifts. Integer and exact: nothing to round.
//   CMPR (14): each 4x4 sub-block's four colours are computed by the reference's own scalar integer
//     formulas (rgb565 expansion, (2a+b)/3, (a+b)/2), then each row of four pixels is one i8x16
//     swizzle of those 16 bytes, its indices read from a table of the 256 possible selector bytes.
//     The arithmetic stays scalar; only the per-pixel selection is SIMD.
//   C4 (8), C8 (9): not SIMD (WebAssembly has no gather). The palette is converted once per level
//     (16 or 256 entries) with the reference's tlut_color, then each pixel copies its 4 bytes. The
//     core captures 32 and 512 palette bytes for these formats and the renderer checks the size, so
//     converting every entry reads only bytes the snapshot holds.
// Formats measured absent from the game's decodes (RGB565 4, C14X2 10) and nearly absent (RGB5A3 5:
// one decode in the 2400-retrace replay) have no fast path: docs/TEXTURE_SIMD.md.
//
// Why a function attribute and not -msimd128. The renderer is compiled inside the core's CMake
// target (wasm/core/CMakeLists.txt), which this backend does not own. target("simd128") enables
// the instructions for these functions alone; the module then needs WebAssembly SIMD at load time
// (Safari 16.4+, every Chromium and Node the project runs), and the workflows that post-process
// it pass --enable-simd to wasm-opt.
//
// Measured, not assumed: experiments/texture-simd/ checks every mip of every texture of the 2400-
// retrace replay against gx::decode_texture byte for byte, and times both per frame and per format.
//
// GXW_TEXTURE_DECODE_REFERENCE forces the reference everywhere; only that experiment's baseline
// build defines it.
#pragma once
#include "gx_texture.h"
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>
#ifndef GXW_TEXTURE_DECODE_REFERENCE
#include <wasm_simd128.h>
#ifndef GXW_SIMD  // experiments/texture-simd/emu defines it empty for a native build of the kernels
#define GXW_SIMD __attribute__((target("simd128")))
#endif
#endif

namespace gxw {

namespace texdetail {
// Block size in texels, as gx_texture.cpp's block_dims.
inline void block_dims(uint32_t format, uint32_t& bw, uint32_t& bh) {
  switch (format) {
    case 0: case 8: case 14: bw = 8; bh = 8; break;
    case 1: case 2: case 9: bw = 8; bh = 4; break;
    default: bw = 4; bh = 4; break;
  }
}
inline bool full_blocks(uint32_t w, uint32_t h, uint32_t format) {
  uint32_t bw, bh; block_dims(format, bw, bh); return w && h && w % bw == 0 && h % bh == 0;
}
}  // namespace texdetail

// True when decode_texture_level takes a SIMD kernel for this level.
inline bool texture_level_simd(uint32_t w, uint32_t h, uint32_t format) {
#ifdef GXW_TEXTURE_DECODE_REFERENCE
  (void)w; (void)h; (void)format; return false;
#else
  const bool simd = format <= 3 || format == 6 || format == 14;
  return simd && texdetail::full_blocks(w, h, format);
#endif
}

// True when decode_texture_level takes the palette-table path (C4, C8) for this level.
inline bool texture_level_table(uint32_t w, uint32_t h, uint32_t format) {
#ifdef GXW_TEXTURE_DECODE_REFERENCE
  (void)w; (void)h; (void)format; return false;
#else
  return (format == 8 || format == 9) && texdetail::full_blocks(w, h, format);
#endif
}

#ifndef GXW_TEXTURE_DECODE_REFERENCE
namespace texdetail {
// gx_texture.cpp's conversions, unchanged.
inline uint32_t be16(const uint8_t* p) { return ((uint32_t)p[0] << 8) | p[1]; }
inline uint8_t e5(uint32_t v) { return (uint8_t)((v << 3) | (v >> 2)); }
inline uint8_t e6(uint32_t v) { return (uint8_t)((v << 2) | (v >> 4)); }
inline uint8_t e4(uint32_t v) { return (uint8_t)(v * 17); }
inline uint8_t e3(uint32_t v) { return (uint8_t)((v << 5) | (v << 2) | (v >> 1)); }
inline void rgb565(uint32_t c, uint8_t* o) { o[0] = e5(c >> 11); o[1] = e6((c >> 5) & 63); o[2] = e5(c & 31); o[3] = 255; }
inline void rgb5a3(uint32_t c, uint8_t* o) {
  if (c & 0x8000) { o[0] = e5((c >> 10) & 31); o[1] = e5((c >> 5) & 31); o[2] = e5(c & 31); o[3] = 255; }
  else { o[0] = e4((c >> 8) & 15); o[1] = e4((c >> 4) & 15); o[2] = e4(c & 15); o[3] = e3((c >> 12) & 7); }
}
inline void tlut_color(const uint8_t* tlut, uint32_t tlut_format, uint32_t index, uint8_t* o) {
  uint32_t c = be16(tlut + index * 2);
  switch (tlut_format) {
    case 0: o[0] = o[1] = o[2] = (uint8_t)(c & 0xFF); o[3] = (uint8_t)(c >> 8); break;
    case 1: rgb565(c, o); break;
    default: rgb5a3(c, o); break;
  }
}

// CMPR row selection: for selector byte r, lane x*4+c = ((r >> (6-2x)) & 3)*4 + c, the byte of
// colour (r >> (6-2x)) & 3, channel c, in a 16-byte palette of four RGBA colours.
struct CmprRowMasks {
  std::array<std::array<uint8_t, 16>, 256> m{};
  constexpr CmprRowMasks() {
    for (uint32_t r = 0; r < 256; ++r)
      for (uint32_t x = 0; x < 4; ++x)
        for (uint32_t c = 0; c < 4; ++c) m[r][x * 4 + c] = uint8_t(((r >> (6 - 2 * x)) & 3) * 4 + c);
  }
};
inline constexpr CmprRowMasks cmpr_row_masks{};

// e4 on every byte of a vector of nibbles (each byte 0..15): (n << 4) | n.
GXW_SIMD inline v128_t e4x16(v128_t n) { return wasm_v128_or(wasm_i8x16_shl(n, 4), n); }

// I4: 8x8 blocks of 32 bytes, row y = 4 bytes, pixel x = nibble x&1 (high first) of byte x/2;
// every channel e4(nibble). Loads of 16 bytes cover rows y..y+3.
GXW_SIMD inline void decode_i4(const uint8_t* src, uint32_t w, uint32_t h, uint8_t* dst) {
  const v128_t low = wasm_i8x16_splat(0x0F);
  for (uint32_t by = 0; by < h; by += 8)
    for (uint32_t bx = 0; bx < w; bx += 8) {
      for (uint32_t half = 0; half < 2; ++half, src += 16) {
        const v128_t v = wasm_v128_load(src);
        const v128_t hi = e4x16(wasm_u8x16_shr(v, 4)), lo = e4x16(wasm_v128_and(v, low));
        // Pixels in raster order: rows 0,1 of this half, then rows 2,3.
        const v128_t px[2] = {wasm_i8x16_shuffle(hi, lo, 0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23),
                              wasm_i8x16_shuffle(hi, lo, 8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31)};
        for (uint32_t k = 0; k < 2; ++k) {
          const v128_t p = px[k];
          uint8_t* r0 = dst + (size_t(by + half * 4 + k * 2) * w + bx) * 4;
          uint8_t* r1 = r0 + size_t(w) * 4;
          wasm_v128_store(r0, wasm_i8x16_shuffle(p, p, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3));
          wasm_v128_store(r0 + 16, wasm_i8x16_shuffle(p, p, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 7));
          wasm_v128_store(r1, wasm_i8x16_shuffle(p, p, 8, 8, 8, 8, 9, 9, 9, 9, 10, 10, 10, 10, 11, 11, 11, 11));
          wasm_v128_store(r1 + 16, wasm_i8x16_shuffle(p, p, 12, 12, 12, 12, 13, 13, 13, 13, 14, 14, 14, 14, 15, 15, 15, 15));
        }
      }
    }
}

// I8: 8x4 blocks of 32 bytes, one byte per pixel copied to all four channels.
GXW_SIMD inline void decode_i8(const uint8_t* src, uint32_t w, uint32_t h, uint8_t* dst) {
  for (uint32_t by = 0; by < h; by += 4)
    for (uint32_t bx = 0; bx < w; bx += 8)
      for (uint32_t y = 0; y < 4; y += 2, src += 16) {
        const v128_t v = wasm_v128_load(src);
        uint8_t* r0 = dst + (size_t(by + y) * w + bx) * 4;
        uint8_t* r1 = r0 + size_t(w) * 4;
        wasm_v128_store(r0, wasm_i8x16_shuffle(v, v, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3));
        wasm_v128_store(r0 + 16, wasm_i8x16_shuffle(v, v, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 7));
        wasm_v128_store(r1, wasm_i8x16_shuffle(v, v, 8, 8, 8, 8, 9, 9, 9, 9, 10, 10, 10, 10, 11, 11, 11, 11));
        wasm_v128_store(r1 + 16, wasm_i8x16_shuffle(v, v, 12, 12, 12, 12, 13, 13, 13, 13, 14, 14, 14, 14, 15, 15, 15, 15));
      }
}

// IA4: 8x4 blocks of 32 bytes, one byte per pixel: RGB = e4(low nibble), A = e4(high nibble).
GXW_SIMD inline void decode_ia4(const uint8_t* src, uint32_t w, uint32_t h, uint8_t* dst) {
  const v128_t low = wasm_i8x16_splat(0x0F);
  for (uint32_t by = 0; by < h; by += 4)
    for (uint32_t bx = 0; bx < w; bx += 8)
      for (uint32_t y = 0; y < 4; y += 2, src += 16) {
        const v128_t v = wasm_v128_load(src);
        const v128_t a = e4x16(wasm_u8x16_shr(v, 4)), i = e4x16(wasm_v128_and(v, low));
        uint8_t* r0 = dst + (size_t(by + y) * w + bx) * 4;
        uint8_t* r1 = r0 + size_t(w) * 4;
        wasm_v128_store(r0, wasm_i8x16_shuffle(i, a, 0, 0, 0, 16, 1, 1, 1, 17, 2, 2, 2, 18, 3, 3, 3, 19));
        wasm_v128_store(r0 + 16, wasm_i8x16_shuffle(i, a, 4, 4, 4, 20, 5, 5, 5, 21, 6, 6, 6, 22, 7, 7, 7, 23));
        wasm_v128_store(r1, wasm_i8x16_shuffle(i, a, 8, 8, 8, 24, 9, 9, 9, 25, 10, 10, 10, 26, 11, 11, 11, 27));
        wasm_v128_store(r1 + 16, wasm_i8x16_shuffle(i, a, 12, 12, 12, 28, 13, 13, 13, 29, 14, 14, 14, 30, 15, 15, 15, 31));
      }
}

// IA8: 4x4 blocks of 32 bytes, two bytes per pixel, A then I: RGB = I, A = A.
GXW_SIMD inline void decode_ia8(const uint8_t* src, uint32_t w, uint32_t h, uint8_t* dst) {
  for (uint32_t by = 0; by < h; by += 4)
    for (uint32_t bx = 0; bx < w; bx += 4)
      for (uint32_t y = 0; y < 4; y += 2, src += 16) {
        const v128_t v = wasm_v128_load(src);
        uint8_t* r0 = dst + (size_t(by + y) * w + bx) * 4;
        wasm_v128_store(r0, wasm_i8x16_shuffle(v, v, 1, 1, 1, 0, 3, 3, 3, 2, 5, 5, 5, 4, 7, 7, 7, 6));
        wasm_v128_store(r0 + size_t(w) * 4, wasm_i8x16_shuffle(v, v, 9, 9, 9, 8, 11, 11, 11, 10, 13, 13, 13, 12, 15, 15, 15, 14));
      }
}

// RGBA8: 4x4 blocks of 32 bytes of AR pairs then 32 bytes of GB pairs; pixel = ar[1] gb[0] gb[1] ar[0].
GXW_SIMD inline void decode_rgba8(const uint8_t* src, uint32_t w, uint32_t h, uint8_t* dst) {
  for (uint32_t by = 0; by < h; by += 4) {
    for (uint32_t bx = 0; bx < w; bx += 4) {
      for (uint32_t y = 0; y < 4; y += 2) {
        const v128_t ar = wasm_v128_load(src + y * 8), gb = wasm_v128_load(src + 32 + y * 8);
        const v128_t row0 = wasm_i8x16_shuffle(ar, gb, 1, 16, 17, 0, 3, 18, 19, 2, 5, 20, 21, 4, 7, 22, 23, 6);
        const v128_t row1 = wasm_i8x16_shuffle(ar, gb, 9, 24, 25, 8, 11, 26, 27, 10, 13, 28, 29, 12, 15, 30, 31, 14);
        wasm_v128_store(dst + (size_t(by + y) * w + bx) * 4, row0);
        wasm_v128_store(dst + (size_t(by + y + 1) * w + bx) * 4, row1);
      }
      src += 64;
    }
  }
}

// CMPR: 8x8 blocks of four 8-byte DXT1 sub-blocks (top-left, top-right, bottom-left, bottom-right).
GXW_SIMD inline void decode_cmpr(const uint8_t* src, uint32_t w, uint32_t h, uint8_t* dst) {
  for (uint32_t by = 0; by < h; by += 8)
    for (uint32_t bx = 0; bx < w; bx += 8)
      for (uint32_t sub = 0; sub < 4; ++sub, src += 8) {
        // The reference's palette, computed the reference's way.
        const uint32_t c0 = be16(src), c1 = be16(src + 2);
        alignas(16) uint8_t cols[4][4];
        rgb565(c0, cols[0]); rgb565(c1, cols[1]);
        if (c0 > c1) {
          for (int k = 0; k < 3; ++k) { cols[2][k] = (uint8_t)((2 * cols[0][k] + cols[1][k]) / 3); cols[3][k] = (uint8_t)((cols[0][k] + 2 * cols[1][k]) / 3); }
          cols[2][3] = cols[3][3] = 255;
        } else {
          for (int k = 0; k < 3; ++k) { cols[2][k] = (uint8_t)((cols[0][k] + cols[1][k]) / 2); cols[3][k] = cols[2][k]; }
          cols[2][3] = 255; cols[3][3] = 0;
        }
        const v128_t pal = wasm_v128_load(cols);
        uint8_t* out = dst + (size_t(by + (sub >> 1) * 4) * w + bx + (sub & 1) * 4) * 4;
        for (uint32_t y = 0; y < 4; ++y, out += size_t(w) * 4)
          wasm_v128_store(out, wasm_i8x16_swizzle(pal, wasm_v128_load(cmpr_row_masks.m[src[4 + y]].data())));
      }
}

// C4 (8x8 blocks, 4-bit index, high nibble first) and C8 (8x4 blocks, 8-bit index): palette
// converted once, then 4 bytes copied per pixel.
inline void decode_ci(const uint8_t* src, uint32_t w, uint32_t h, uint32_t format, const uint8_t* tlut,
                      uint32_t tlut_format, uint8_t* dst) {
  uint8_t pal[256][4];
  const uint32_t entries = format == 8 ? 16 : 256;
  for (uint32_t i = 0; i < entries; ++i) tlut_color(tlut, tlut_format, i, pal[i]);
  if (format == 8) {
    for (uint32_t by = 0; by < h; by += 8)
      for (uint32_t bx = 0; bx < w; bx += 8)
        for (uint32_t y = 0; y < 8; ++y, src += 4) {
          uint8_t* out = dst + (size_t(by + y) * w + bx) * 4;
          for (uint32_t b = 0; b < 4; ++b, out += 8) {
            std::memcpy(out, pal[src[b] >> 4], 4);
            std::memcpy(out + 4, pal[src[b] & 15], 4);
          }
        }
  } else {
    for (uint32_t by = 0; by < h; by += 4)
      for (uint32_t bx = 0; bx < w; bx += 8)
        for (uint32_t y = 0; y < 4; ++y, src += 8) {
          uint8_t* out = dst + (size_t(by + y) * w + bx) * 4;
          for (uint32_t x = 0; x < 8; ++x) std::memcpy(out + x * 4, pal[src[x]], 4);
        }
  }
}
}  // namespace texdetail
#endif

// One mip level, the same contract as gx::decode_texture.
inline void decode_texture_level(const uint8_t* src, uint32_t w, uint32_t h, uint32_t format,
                                 const uint8_t* tlut, uint32_t tlut_format, std::vector<uint8_t>& out) {
#ifndef GXW_TEXTURE_DECODE_REFERENCE
  if (texture_level_simd(w, h, format) || texture_level_table(w, h, format)) {
    out.resize(size_t(w) * h * 4);
    uint8_t* dst = out.data();
    switch (format) {
      case 0: texdetail::decode_i4(src, w, h, dst); return;
      case 1: texdetail::decode_i8(src, w, h, dst); return;
      case 2: texdetail::decode_ia4(src, w, h, dst); return;
      case 3: texdetail::decode_ia8(src, w, h, dst); return;
      case 6: texdetail::decode_rgba8(src, w, h, dst); return;
      case 14: texdetail::decode_cmpr(src, w, h, dst); return;
      default: texdetail::decode_ci(src, w, h, format, tlut, tlut_format, dst); return;
    }
  }
#endif
  gx::decode_texture(src, w, h, format, tlut, tlut_format, out);
}

}  // namespace gxw
