// Tests byte framing and interrupt effects without copyrighted guest data.
// SPDX-License-Identifier: GPL-2.0-or-later
#include "headless.h"
#include "gx_core.h"
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
struct Recorder : gx::Backend {
  std::vector<gx::Frame> frames;
  void submit_frame(const gx::Frame& frame) override { frames.push_back(frame); }
};
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
  // The renderer seam. No backend is attached by default: a clearing XFB copy produces nothing.
  Recorder recorder;
  bp(0x52004800); require(recorder.frames.empty());
  host::gx_set_backend(&recorder);
  bp(0x49000000);                          // EFB_TL 0,0
  bp(0x4A000000 | (479u << 10) | 639u);    // EFB_BR: 640x480
  bp(0x4F00FF20);                          // CLEAR_AR: A=FF R=20
  bp(0x50008040);                          // CLEAR_GB: G=80 B=40
  bp(0x52000800);                          // clear only, not to XFB: recorded, not yet handed over
  require(recorder.frames.empty());
  bp(0x52004800);                          // to XFB with clear: the frame is handed over
  require(recorder.frames.size() == 1);
  const gx::Frame& first = recorder.frames[0];
  require(first.sequence == 1 && first.draws.empty());
  require(first.copies.size() == 2 && first.commands.size() == 2);
  require(first.commands[0].kind == gx::FrameCommand::Copy && first.commands[0].index == 0);
  require(first.commands[1].kind == gx::FrameCommand::Copy && first.commands[1].index == 1);
  require(!first.copies[0].to_xfb && first.copies[0].clear);
  const gx::EfbCopy& xfb = first.copies[1];
  require(xfb.to_xfb && xfb.clear && xfb.clear_color == 0xFF208040u);
  require(xfb.src_x == 0 && xfb.src_y == 0 && xfb.src_w == 640 && xfb.src_h == 480);
  bp(0x52004000);                          // the next frame starts empty: one copy, no clear
  require(recorder.frames.size() == 2 && recorder.frames[1].sequence == 2);
  require(recorder.frames[1].copies.size() == 1 && !recorder.frames[1].copies[0].clear);
  host::gx_set_backend(nullptr);
  bp(0x52004800); require(recorder.frames.size() == 2);
  require(finishes == 2 && tokens == 2);   // the seam raised no interrupt of its own
  std::puts("FIFO boundaries, masks, draw/XF payloads, display-list interrupts and the renderer seam passed");
}
