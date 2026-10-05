// Differential corpus for gx::same_bytes (patch 0012): it must answer exactly as the !memcmp it
// replaced in TextureSnapshotCache::equal, for every length and alignment, and whichever byte differs.
//
// Three families, each against !memcmp on the same two pointers:
//  1. exhaustive small: every length 0..160, every pair of start offsets 0..7, the two buffers equal,
//     then each byte of the range changed in turn by three masks (low bit, high bit, all bits), then
//     a difference just outside the range on either side (it must not count);
//  2. texture sizes: the byte counts texture_chain_bytes gives for every GX format, square and
//     non-square sizes 1..1024 and 1..11 mip levels, plus the three palette sizes, with the
//     difference at the first byte, the last byte, word boundaries and random places;
//  3. random: lengths biased small (most compares in the game are a few KB, a few are 64 KB),
//     random offsets, zero to three differences biased to the first and last 8 bytes.
// The output is the number of cases per family and a digest of the answers, so the x86 and arm64
// runs (and the -O2 and -Oz builds) can be compared by eye as well as by the exit status.
#include "texture_snapshot.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace {
uint64_t g_state = 0x9E3779B97F4A7C15ull;
uint64_t next() {
  g_state ^= g_state << 13; g_state ^= g_state >> 7; g_state ^= g_state << 17;
  return g_state;
}
uint64_t g_cases = 0, g_equal = 0, g_digest = 1469598103934665603ull;
uint64_t g_failures = 0;

void check(const uint8_t* a, const uint8_t* b, size_t size) {
  const bool expected = std::memcmp(a, b, size) == 0;
  const bool got = gx::same_bytes(a, b, size);
  ++g_cases;
  g_equal += expected;
  g_digest = (g_digest ^ (uint64_t(size) << 1 | expected)) * 1099511628211ull;
  if (got != expected && g_failures++ < 20)
    std::fprintf(stderr, "MISMATCH size %zu a%%8 %u b%%8 %u: memcmp says %s, same_bytes says %s\n", size,
                 unsigned(uintptr_t(a) & 7), unsigned(uintptr_t(b) & 7), expected ? "equal" : "different",
                 got ? "equal" : "different");
}

void fill(std::vector<uint8_t>& v) { for (auto& x : v) x = uint8_t(next()); }

// a and b hold the same bytes at [oa, oa+size) and [ob, ob+size); change b at position k by mask,
// check, restore.
void flip_check(const uint8_t* a, uint8_t* b, size_t size, size_t k, uint8_t mask) {
  b[k] ^= mask; check(a, b, size); b[k] ^= mask;
}

void exhaustive_small() {
  std::vector<uint8_t> a(256), b(256);
  const uint8_t masks[] = {0x01, 0x80, 0xFF};
  for (size_t size = 0; size <= 160; ++size)
    for (size_t oa = 0; oa < 8; ++oa)
      for (size_t ob = 0; ob < 8; ++ob) {
        fill(a);
        fill(b);
        std::memcpy(&b[8 + ob], &a[8 + oa], size);
        const uint8_t* pa = &a[8 + oa];
        uint8_t* pb = &b[8 + ob];
        check(pa, pb, size);
        for (size_t k = 0; k < size; ++k)
          for (uint8_t m : masks) flip_check(pa, pb, size, k, m);
        // Outside the range: the bytes just before and just after differ on purpose (they are
        // random and independent), and they must not change the answer.
        pb[-1] = uint8_t(pa[-1] ^ 0x5A); pb[size] = uint8_t(pa[size] ^ 0xA5);
        check(pa, pb, size);
      }
}

void texture_sizes() {
  std::vector<size_t> sizes = {32, 512, 32768};   // the three palette sizes
  const uint32_t formats[] = {0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 14};
  for (uint32_t f : formats)
    for (uint32_t w = 1; w <= 1024; w *= 2)
      for (uint32_t h : {w, w / 2 ? w / 2 : 1u, w * 2 <= 1024 ? w * 2 : w, w + 3u})
        for (uint32_t levels = 1; levels <= 11; ++levels)
          sizes.push_back(gx::texture_chain_bytes(w, h, f, gx::texture_mip_count(w, h, levels)));
  // Up to 256 KB (a 256x256 RGBA8 texture): the 64 KB palette-free chains the game compares are
  // inside it, and the multi-megabyte chains would make this run minutes long for nothing new.
  sizes.erase(std::remove_if(sizes.begin(), sizes.end(), [](size_t n) { return n > 262144; }), sizes.end());
  std::sort(sizes.begin(), sizes.end());
  sizes.erase(std::unique(sizes.begin(), sizes.end()), sizes.end());
  size_t largest = sizes.back();
  std::vector<uint8_t> a(largest + 16), b(largest + 16);
  fill(a);
  for (size_t size : sizes) {
    for (size_t oa : {size_t(0), size_t(3)})
      for (size_t ob : {size_t(0), size_t(5)}) {
        uint8_t* pb = &b[ob];
        const uint8_t* pa = &a[oa];
        std::memcpy(pb, pa, size);
        check(pa, pb, size);
        if (!size) continue;
        std::vector<size_t> places = {0, size - 1, size / 2};
        for (size_t step : {size_t(8), size_t(32)})
          for (size_t k = step; k < size; k += step * (1 + size / 4096)) {
            places.push_back(k - 1); places.push_back(k);
          }
        if (size >= 8) for (size_t k = size - 8; k < size; ++k) places.push_back(k);
        for (int r = 0; r < 64; ++r) places.push_back(next() % size);
        for (size_t k : places) flip_check(pa, pb, size, k, uint8_t(1u << (next() & 7)));
      }
  }
}

size_t random_size() {
  const uint64_t r = next() % 1000;
  if (r < 500) return next() % 65;            // 0..64
  if (r < 850) return 65 + next() % 960;      // ..1024
  if (r < 990) return 1025 + next() % 7168;   // ..8192
  return 8193 + next() % 65536;               // ..73728
}

void random_cases(uint64_t count) {
  const size_t cap = 8193 + 65536 + 16;
  std::vector<uint8_t> a(cap), b(cap);
  fill(a);
  for (uint64_t i = 0; i < count; ++i) {
    const size_t size = random_size();
    const size_t oa = next() & 7, ob = next() & 7;
    const uint8_t* pa = &a[oa];
    uint8_t* pb = &b[ob];
    std::memcpy(pb, pa, size);
    const unsigned diffs = size ? unsigned(next() % 4) : 0;
    size_t changed[3];
    for (unsigned d = 0; d < diffs; ++d) {
      const uint64_t where = next() % 4;
      size_t k = where == 0 ? next() % (size < 8 ? size : 8)                        // head
               : where == 1 ? size - 1 - next() % (size < 8 ? size : 8)             // tail
               : next() % size;                                                     // anywhere
      changed[d] = k;
      pb[k] ^= uint8_t(1 + next() % 255);
    }
    check(pa, pb, size);
    for (unsigned d = diffs; d-- > 0;) pb[changed[d]] = pa[changed[d]];
    // Occasionally refresh a so the content is not one fixed buffer.
    if ((i & 0xFFFFF) == 0) fill(a);
  }
}
}  // namespace

int main(int argc, char** argv) {
  const uint64_t random_count = argc > 1 ? std::strtoull(argv[1], nullptr, 10) : 40000000ull;
  std::setvbuf(stdout, nullptr, _IONBF, 0);
  uint64_t before = g_cases;
  exhaustive_small();
  std::printf("exhaustive small: %llu cases\n", (unsigned long long)(g_cases - before));
  before = g_cases;
  texture_sizes();
  std::printf("texture sizes:    %llu cases\n", (unsigned long long)(g_cases - before));
  before = g_cases;
  random_cases(random_count);
  std::printf("random:           %llu cases\n", (unsigned long long)(g_cases - before));
  std::printf("total %llu cases, %llu equal, digest %016llx, %llu mismatches\n", (unsigned long long)g_cases,
              (unsigned long long)g_equal, (unsigned long long)g_digest, (unsigned long long)g_failures);
  return g_failures ? 1 : 0;
}
