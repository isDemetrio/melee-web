// Tests byte framing and interrupt effects without copyrighted guest data.
// SPDX-License-Identifier: GPL-2.0-or-later
#include "headless.h"
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <vector>
namespace {
unsigned finishes = 0, tokens = 0;
uint16_t last_token = 0;
std::vector<uint8_t> memory(4096);
void require(bool condition) { if (!condition) std::abort(); }
void bytes(std::initializer_list<uint8_t> b) { for (auto v : b) host::gx_write(v, 1); }
void bp(uint32_t v) { host::gx_write(0x61, 1); host::gx_write(v, 4); }
}
namespace host {
void set_pe_finish_pending() { ++finishes; }
void set_pe_token_pending(uint16_t t) { ++tokens; last_token = t; }
uint8_t* ptr(uint32_t a, uint32_t n) {
  require(a <= memory.size() && n <= memory.size()-a); return memory.data()+a;
}
uint8_t rd8(uint32_t) { return 0; }
uint16_t rd16(uint32_t) { return 0; }
uint32_t rd32(uint32_t) { return 0; }
void wr8(uint32_t, uint8_t) {}
void wr32(uint32_t, uint32_t) {}
[[noreturn]] void die(const char* fmt, ...) {
  va_list args; va_start(args, fmt); vfprintf(stderr, fmt, args); va_end(args); std::abort();
}
}
int main() {
  // Split a BP command at every byte: no interrupt before the last byte.
  bytes({0x61,0x45,0,0}); require(finishes == 0);
  bytes({2}); require(finishes == 1);
  bp(0x48001234); require(tokens == 1 && last_token == 0x1234);
  bp(0xFE000000); bp(0x45000000); // zero mask preserves draw-done bit
  require(finishes == 2);
  bp(0x45000000); require(finishes == 2); // mask resets after one write
  // CP VCD: direct XY position, unsigned bytes, 3 vertices = 6 payload bytes.
  bytes({8,0x50,0,0,2,0});
  bytes({0x80,0,3,0x61,0x45,0,0,2,0});
  require(finishes == 2); // a draw's payload is not a BP command
  // XF payload also contains a fake finish command.
  bytes({0x10,0,1,0,0,0x61,0x45,0,0,2,0,0,0});
  require(finishes == 2);
  memory[32]=0x61; memory[33]=0x48; memory[34]=0; memory[35]=0xAB; memory[36]=0xCD;
  bytes({0x40,0,0,0,32,0,0,0,5});
  require(tokens == 2 && last_token == 0xABCD);
  std::puts("FIFO boundaries, masks, draw/XF payloads and display-list interrupts passed");
}
