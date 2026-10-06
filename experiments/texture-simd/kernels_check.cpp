// Every fast path of wasm/render/texture_decode.h against gx::decode_texture, byte for byte, on
// random texels and palettes: every format 0..14, every tlut format, full and partial block sizes.
// Native: g++ -std=c++17 -O2 -Iexperiments/texture-simd/emu -Iupstream/melee-unlocked/port/runtime/gx
//   -I. experiments/texture-simd/kernels_check.cpp upstream/melee-unlocked/port/runtime/gx/gx_texture.cpp
// CI (texture-simd.yml): the same with em++ -msimd128 and the real <wasm_simd128.h>, run under node.
#include "wasm/render/texture_decode.h"
#include <cstdio>
#include <random>
int main() {
  std::mt19937 rng(12345);
  const uint32_t sizes[] = {1, 2, 4, 8, 12, 16, 24, 32, 64, 128};
  uint64_t checked = 0, fast = 0;
  for (uint32_t format = 0; format <= 14; ++format)
    for (uint32_t tf = 0; tf < 3; ++tf)
      for (uint32_t w : sizes)
        for (uint32_t h : sizes)
          for (int rep = 0; rep < 3; ++rep) {
            std::vector<uint8_t> src(gx::texture_level_bytes(w, h, format)), tlut(32768);
            for (auto& b : src) b = uint8_t(rng());
            for (auto& b : tlut) b = uint8_t(rng());
            // CMPR's two palette branches: force c0 <= c1 on some sub-blocks.
            if (format == 14 && rep == 1) for (size_t i = 0; i + 4 <= src.size(); i += 8) { src[i] = 0; src[i + 2] = 0xFF; }
            if (format == 14 && rep == 2) for (size_t i = 0; i + 4 <= src.size(); i += 8) { src[i] = src[i + 2]; src[i + 1] = src[i + 3]; }
            std::vector<uint8_t> ref, cand(7, 0xAB);  // candidate output starts dirty, as the renderer's reused buffer
            gx::decode_texture(src.data(), w, h, format, tlut.data(), tf, ref);
            gxw::decode_texture_level(src.data(), w, h, format, tlut.data(), tf, cand);
            fast += gxw::texture_level_simd(w, h, format) || gxw::texture_level_table(w, h, format);
            ++checked;
            if (ref != cand) { std::printf("MISMATCH format %u tlut %u %ux%u rep %d\n", format, tf, w, h, rep); return 1; }
          }
  std::printf("kernels_check: %llu levels identical to gx::decode_texture, %llu on a fast path\n",
              (unsigned long long)checked, (unsigned long long)fast);
  return fast ? 0 : 1;
}
