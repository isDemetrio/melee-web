// Texture decoding for the WebGPU backend: gx::decode_texture, with an exact SIMD path for RGBA8.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// What it does. RGBA8 (GX format 6) stores each 4x4 block as 32 bytes of AR pairs then 32 bytes of
// GB pairs; the reference (gx_texture.cpp, case 6) moves each byte to its RGBA slot one pixel at a
// time. Here one shuffle per two rows does the same moves, byte for byte: no arithmetic, so nothing
// to round. Every other format, and any RGBA8 level whose width or height is not a multiple of 4
// (the small mips: 2x2, 1x1, ...), goes to gx::decode_texture unchanged. Those partial blocks are
// where the reference's bounds check matters, and the kernel has none.
//
// Why a function attribute and not -msimd128. The renderer is compiled inside the core's CMake
// target (wasm/core/CMakeLists.txt), which this backend does not own. target("simd128") enables
// the instructions for this function alone; the module then needs WebAssembly SIMD at load time
// (Safari 16.4+, every Chromium and Node the project runs), and the workflows that post-process
// it pass --enable-simd to wasm-opt.
//
// Measured, not assumed: experiments/texture-simd/ checks every mip of every texture of the 2400-
// retrace replay against gx::decode_texture byte for byte, and times both per frame. The result,
// and what it is worth per frame, is in docs/TEXTURE_SIMD.md.
//
// GXW_TEXTURE_DECODE_REFERENCE forces the reference everywhere; only that experiment's baseline
// build defines it.
#pragma once
#include "gx_texture.h"
#include <cstddef>
#include <cstdint>
#include <vector>
#ifndef GXW_TEXTURE_DECODE_REFERENCE
#include <wasm_simd128.h>
#endif

namespace gxw {

// True when decode_texture_level takes the SIMD path for this level.
inline bool texture_level_simd(uint32_t w, uint32_t h, uint32_t format) {
#ifdef GXW_TEXTURE_DECODE_REFERENCE
  (void)w; (void)h; (void)format; return false;
#else
  return format == 6 && w % 4 == 0 && h % 4 == 0;
#endif
}

#ifndef GXW_TEXTURE_DECODE_REFERENCE
// Full 4x4 blocks only (texture_level_simd). Output row y, pixel x: R=ar[1], G=gb[0], B=gb[1],
// A=ar[0] of pixel y*4+x, as gx_texture.cpp's case 6.
__attribute__((target("simd128"))) inline void decode_rgba8_simd(const uint8_t* src, uint32_t w, uint32_t h,
                                                                  std::vector<uint8_t>& out) {
  out.resize(size_t(w) * h * 4);
  uint8_t* dst = out.data();
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
#endif

// One mip level, the same contract as gx::decode_texture.
inline void decode_texture_level(const uint8_t* src, uint32_t w, uint32_t h, uint32_t format,
                                 const uint8_t* tlut, uint32_t tlut_format, std::vector<uint8_t>& out) {
#ifndef GXW_TEXTURE_DECODE_REFERENCE
  if (texture_level_simd(w, h, format)) { decode_rgba8_simd(src, w, h, out); return; }
#endif
  gx::decode_texture(src, w, h, format, tlut, tlut_format, out);
}

}  // namespace gxw
