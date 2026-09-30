#include "wasm/compat/sha1.h"
#include <cstdio>
#include <string>
int main() {
  const std::string messages[] = {"", "abc",
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", std::string(1000000, 'a')};
  const char* expected[] = {"da39a3ee5e6b4b0d3255bfef95601890afd80709",
    "a9993e364706816aba3e25717850c26c9cd0d89d", "84983e441c3bd26ebaae4aa1f95129e5e54670f1",
    "34aa973cd4c4daa4f61eeb2bdbad27316534016f"};
  for (unsigned i=0; i<4; ++i) {
    const auto digest = wasm_compat::sha1(reinterpret_cast<const uint8_t*>(messages[i].data()), messages[i].size());
    char hex[41];
    for (unsigned j=0; j<20; ++j) std::snprintf(hex+2*j, 3, "%02x", digest[j]);
    if (std::string(hex) != expected[i]) return 1;
  }
  puts("SHA-1: 4 known-answer vectors passed");
}
