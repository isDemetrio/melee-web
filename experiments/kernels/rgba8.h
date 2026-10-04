// Exact GX RGBA8 block unpacking. Other formats/edge blocks use the reference.
#pragma once
#include <wasm_simd128.h>
#include "gx_texture.h"
inline void decode_rgba8_simd(const uint8_t* src, uint32_t w, uint32_t h,
                             std::vector<uint8_t>& out) {
  out.resize(size_t(w)*h*4);
  for (uint32_t by=0; by<h; by+=4) for (uint32_t bx=0; bx<w; bx+=4) {
    for (uint32_t y=0; y<4; y+=2) {
      const v128_t ar=wasm_v128_load(src+y*8), gb=wasm_v128_load(src+32+y*8);
      const v128_t row0=wasm_i8x16_shuffle(ar,gb,1,16,17,0,3,18,19,2,5,20,21,4,7,22,23,6);
      const v128_t row1=wasm_i8x16_shuffle(ar,gb,9,24,25,8,11,26,27,10,13,28,29,12,15,30,31,14);
      wasm_v128_store(out.data()+(size_t(by+y)*w+bx)*4,row0);
      wasm_v128_store(out.data()+(size_t(by+y+1)*w+bx)*4,row1);
    }
    src+=64;
  }
}
inline void decode_candidate(const uint8_t* src,uint32_t w,uint32_t h,uint32_t fmt,
                             const uint8_t* pal,uint32_t pf,std::vector<uint8_t>& out) {
  if (fmt==6 && w%4==0 && h%4==0) decode_rgba8_simd(src,w,h,out);
  else gx::decode_texture(src,w,h,fmt,pal,pf,out);
}
