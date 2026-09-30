#pragma once
#include <cstdint>

// Pinned port/runtime/ppc/ppc.h:173-216,250 needs swaps and a 32-bit scan;
// port/recomp/emit.py:263-271 emits _rotl. Keep operands 32-bit on LP64 too.
inline uint16_t _byteswap_ushort(uint16_t v) { return __builtin_bswap16(v); }
inline uint32_t _byteswap_ulong(uint32_t v) { return __builtin_bswap32(v); }
inline uint64_t _byteswap_uint64(uint64_t v) { return __builtin_bswap64(v); }
inline unsigned char _BitScanReverse(unsigned long* index, uint32_t mask) {
  if (!mask) return 0;
  *index = 31u - static_cast<unsigned>(__builtin_clz(mask));
  return 1;
}
inline unsigned char _BitScanForward(unsigned long* index, uint32_t mask) {
  if (!mask) return 0;
  *index = static_cast<unsigned>(__builtin_ctz(mask));
  return 1;
}
// GCC x86 headers may provide these names as macros in the native baseline.
#ifdef _rotl
#undef _rotl
#endif
#ifdef _rotr
#undef _rotr
#endif
inline uint32_t _rotl(uint32_t v, int count) {
  const unsigned n = static_cast<unsigned>(count) & 31u;
  return (v << n) | (v >> ((32u - n) & 31u));
}
inline uint32_t _rotr(uint32_t v, int count) {
  const unsigned n = static_cast<unsigned>(count) & 31u;
  return (v >> n) | (v << ((32u - n) & 31u));
}
