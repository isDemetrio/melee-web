// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace wasm_compat {
// SHA-1 for the existing retail-image identity gate, not a security primitive.
inline std::array<uint8_t, 20> sha1(const uint8_t* data, size_t size) {
  uint32_t h[5] = {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0};
  auto rol = [](uint32_t v, unsigned n) { return (v << n) | (v >> (32 - n)); };
  const size_t blocks = size / 64 + (size % 64 < 56 ? 1 : 2);
  for (size_t block = 0; block < blocks; ++block) {
    uint8_t bytes[64]{};
    for (size_t i = 0; i < 64; ++i) {
      const size_t pos = block * 64 + i;
      if (pos < size) bytes[i] = data[pos];
      else if (pos == size) bytes[i] = 0x80;
    }
    if (block + 1 == blocks) {
      const uint64_t bits = uint64_t(size) * 8;
      for (unsigned i = 0; i < 8; ++i) bytes[63-i] = uint8_t(bits >> (i*8));
    }
    uint32_t w[80];
    for (unsigned i = 0; i < 16; ++i)
      w[i] = uint32_t(bytes[4*i]) << 24 | uint32_t(bytes[4*i+1]) << 16 |
             uint32_t(bytes[4*i+2]) << 8 | bytes[4*i+3];
    for (unsigned i = 16; i < 80; ++i) w[i] = rol(w[i-3]^w[i-8]^w[i-14]^w[i-16], 1);
    uint32_t a=h[0], b=h[1], c=h[2], d=h[3], e=h[4];
    for (unsigned i = 0; i < 80; ++i) {
      const uint32_t f = i < 20 ? ((b & c) | (~b & d)) :
                         i < 40 ? (b ^ c ^ d) : i < 60 ? ((b & c) | (b & d) | (c & d)) : (b ^ c ^ d);
      const uint32_t k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const uint32_t t = rol(a,5) + f + e + k + w[i];
      e=d; d=c; c=rol(b,30); b=a; a=t;
    }
    h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d; h[4]+=e;
  }
  std::array<uint8_t,20> digest{};
  for (unsigned i=0; i<20; ++i) digest[i] = uint8_t(h[i/4] >> (24 - 8*(i%4)));
  return digest;
}
}
