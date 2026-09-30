// Minimal guest-visible FIFO decoder, derived from pinned gx_core.cpp.
// SPDX-License-Identifier: GPL-2.0-or-later
#include "headless.h"
#include <vector>
#include <array>
#include <algorithm>
#include <cmath>
#include <cstring>
namespace {
uint32_t bits(uint32_t v, unsigned shift, unsigned n) { return (v >> shift) & ((1u << n)-1); }
uint32_t be32(const uint8_t* p) { return uint32_t(p[0])<<24 | uint32_t(p[1])<<16 | uint32_t(p[2])<<8 | p[3]; }
uint16_t be16(const uint8_t* p) { return uint16_t(p[0])<<8 | p[1]; }
struct CP {
  uint32_t reg[256]{};
  uint32_t vcd_lo() const { return reg[0x50]; }
  uint32_t vcd_hi() const { return reg[0x60]; }
  uint32_t vat_a(uint32_t f) const { return reg[0x70+f]; }
  uint32_t vat_b(uint32_t f) const { return reg[0x80+f]; }
  uint32_t vat_c(uint32_t f) const { return reg[0x90+f]; }
} g_cp;
uint32_t bp[256]{}, bp_mask = 0xFFFFFF;
std::vector<uint8_t> fifo;
struct AttrDesc {
  uint32_t type;      // 0 none, 1 direct, 2 index8, 3 index16
  uint32_t format;    // component format
  uint32_t count;     // elements flag
  uint32_t frac;
  uint32_t array;     // CP array index for indexed
};

struct VertexDesc {
  bool posmtx;
  bool texmtx[8];
  AttrDesc pos, nrm, col[2], tex[8];
  uint32_t nrm_index3;
  uint32_t size;      // bytes per vertex in the stream
};

uint32_t comp_bytes(uint32_t format) { static const uint32_t b[] = {1, 1, 2, 2, 4, 4, 4, 4}; return b[format & 7]; }

VertexDesc build_desc(uint32_t fmt) {
  VertexDesc d{};
  uint32_t lo = g_cp.vcd_lo(), hi = g_cp.vcd_hi();
  uint32_t a = g_cp.vat_a(fmt), b = g_cp.vat_b(fmt), c = g_cp.vat_c(fmt);
  d.posmtx = lo & 1;
  for (int i = 0; i < 8; ++i) d.texmtx[i] = (lo >> (1 + i)) & 1;
  d.pos = {bits(lo, 9, 2), bits(a, 1, 3), bits(a, 0, 1), bits(a, 4, 5), 0};
  d.nrm = {bits(lo, 11, 2), bits(a, 10, 3), bits(a, 9, 1), 0, 1};
  d.nrm_index3 = bits(a, 31, 1);
  d.col[0] = {bits(lo, 13, 2), bits(a, 14, 3), bits(a, 13, 1), 0, 2};
  d.col[1] = {bits(lo, 15, 2), bits(a, 18, 3), bits(a, 17, 1), 0, 3};
  d.tex[0] = {bits(hi, 0, 2), bits(a, 22, 3), bits(a, 21, 1), bits(a, 25, 5), 4};
  d.tex[1] = {bits(hi, 2, 2), bits(b, 1, 3), bits(b, 0, 1), bits(b, 4, 5), 5};
  d.tex[2] = {bits(hi, 4, 2), bits(b, 10, 3), bits(b, 9, 1), bits(b, 13, 5), 6};
  d.tex[3] = {bits(hi, 6, 2), bits(b, 19, 3), bits(b, 18, 1), bits(b, 22, 5), 7};
  d.tex[4] = {bits(hi, 8, 2), bits(b, 28, 3), bits(b, 27, 1), bits(c, 0, 5), 8};
  d.tex[5] = {bits(hi, 10, 2), bits(c, 6, 3), bits(c, 5, 1), bits(c, 9, 5), 9};
  d.tex[6] = {bits(hi, 12, 2), bits(c, 15, 3), bits(c, 14, 1), bits(c, 18, 5), 10};
  d.tex[7] = {bits(hi, 14, 2), bits(c, 24, 3), bits(c, 23, 1), bits(c, 27, 5), 11};
  uint32_t size = 0;
  if (d.posmtx) size += 1;
  for (int i = 0; i < 8; ++i) if (d.texmtx[i]) size += 1;
  auto attr = [&](const AttrDesc& x, uint32_t direct) {
    if (x.type == 1) size += direct; else if (x.type == 2) size += 1; else if (x.type == 3) size += 2;
  };
  attr(d.pos, comp_bytes(d.pos.format) * (d.pos.count ? 3 : 2));
  if (d.nrm.type == 1) size += comp_bytes(d.nrm.format) * (d.nrm.count ? 9 : 3);
  else if (d.nrm.type == 2) size += (d.nrm.count && d.nrm_index3) ? 3 : 1;
  else if (d.nrm.type == 3) size += (d.nrm.count && d.nrm_index3) ? 6 : 2;
  static const uint32_t csize[] = {2, 3, 4, 2, 3, 4, 4, 4};
  for (int i = 0; i < 2; ++i) attr(d.col[i], csize[d.col[i].format]);
  for (int i = 0; i < 8; ++i) attr(d.tex[i], comp_bytes(d.tex[i].format) * (d.tex[i].count ? 2 : 1));
  d.size = size;
  return d;
}


bool guest_object(uint32_t address, uint32_t bytes) {
  return address >= 0x80000000u && address <= 0x81800000u - bytes;
}
float guest_float(uint32_t address) {
  const uint32_t bits = host::rd32(address);
  float value;
  std::memcpy(&value, &bits, sizeof value);
  return value;
}
void write_guest_float(uint32_t address, float value) {
  uint32_t bits;
  std::memcpy(&bits, &value, sizeof bits);
  host::wr32(address, bits);
}
struct HudRootScale { uint32_t root = 0; float base_x = 1, base_y = 1; };
std::array<HudRootScale, 4> g_stock_roots{}, g_damage_roots{};

void scale_hud_root(uint32_t gobj, int percent, HudRootScale& cached) {
  if (!guest_object(gobj, 0x2C)) { cached = {}; return; }
  const uint32_t root = host::rd32(gobj + 0x28);
  if (!guest_object(root, 0x44)) { cached = {}; return; }
  if (cached.root != root) {
    cached = {root, guest_float(root + 0x2C), guest_float(root + 0x30)};
    if (!std::isfinite(cached.base_x) || !std::isfinite(cached.base_y) ||
        cached.base_x <= 0.0f || cached.base_y <= 0.0f) { cached = {}; return; }
  }
  const float factor = std::clamp(percent, 75, 175) / 100.0f;
  const float x = cached.base_x * factor, y = cached.base_y * factor;
  if (guest_float(root + 0x2C) == x && guest_float(root + 0x30) == y) return;
  write_guest_float(root + 0x2C, x);
  write_guest_float(root + 0x30, y);
  host::wr32(root + 0x14, host::rd32(root + 0x14) | (1u << 6)); // JOBJ_MTX_DIRTY
}

// Preserve the default-scale HUD writes even without constructing a render frame.
void capture_default_hud() {
  const uint8_t major = host::rd8(0x80479D30), minor = host::rd8(0x80479D33);
  const bool match_mode = major == 2 || major == 3 || major == 4 || major == 5 ||
      major == 0x0F || (major >= 0x10 && major <= 0x13) || major == 0x1B || major == 0x1C;
  const bool in_match = major == 8 ? minor == 2 : match_mode && minor >= 2;
  if (!in_match) { g_stock_roots = {}; g_damage_roots = {}; return; }
  for (uint32_t slot=0; slot<4; ++slot) {
    const uint32_t status = 0x804A10C8u + slot*0x64u;
    const uint32_t stock = 0x804A1380u + slot*0x50u;
    const uint32_t damage_gobj = host::rd32(status), stock_gobj = host::rd32(stock);
    const int damage = int16_t(host::rd16(status+0xA)), stocks = int32_t(host::rd32(stock+0x4C));
    if (guest_object(damage_gobj, 0x2C) && guest_object(stock_gobj, 0x2C) &&
        damage >= 0 && damage <= 999 && stocks >= 0 && stocks <= 99) {
      scale_hud_root(stock_gobj, 100, g_stock_roots[slot]);
      scale_hud_root(damage_gobj, 100, g_damage_roots[slot]);
    }
  }
}

void bp_write(uint32_t value) {
  const uint32_t r = value >> 24, v = value & 0xFFFFFF;
  if (r == 0xFE) { bp_mask = v; return; }
  bp[r] = (bp[r] & ~bp_mask) | (v & bp_mask);
  bp_mask = 0xFFFFFF;
  if (r == 0x45 && (bp[r] & 2)) host::set_pe_finish_pending();
  if (r == 0x48) host::set_pe_token_pending(uint16_t(bp[r]));
  if (r == 0x52 && (bp[r] & (1u << 14))) {
    capture_default_hud();
    // Replaces gx_core's completed-XFB UI handling; preserve its one guest-memory write.
    if (host::rd8(0x804A04F0) == 4 && host::rd16(0x804A04F2) == 3 &&
        (host::rd32(0x804A04FC) & 0x10)) host::wr8(0x804A0501, 0);
  }
  // Replaces renderer-only BP state, TLUT copies and EFB submissions. Windows with a null
  // backend queues/discards EFB copies; it does not rasterize or copy pixels into guest RAM.
  // HUD scaling uses the Windows defaults: 100%, PAL stock mode disabled.
}
size_t parse(const uint8_t* p, size_t len, unsigned depth) {
  if (!len) return 0;
  const uint8_t op = *p;
  if (op == 0 || op == 0x48) return 1;
  if (op == 8) {
    if (len < 6) return 0;
    g_cp.reg[p[1]] = be32(p+2); return 6;
  }
  if (op == 0x10) {
    if (len < 5) return 0;
    const size_t need = 5 + ((be16(p+1) & 15)+1)*4;
    // Replaces XF matrix loads: matrices only affect discarded rendering.
    return len < need ? 0 : need;
  }
  if (op == 0x20 || op == 0x28 || op == 0x30 || op == 0x38) return len < 5 ? 0 : 5;
  if (op == 0x40) {
    if (len < 9) return 0;
    if (depth >= 16) host::die("GX display list recursion limit");
    const uint32_t addr = be32(p+1), size = be32(p+5);
    const uint8_t* list = host::ptr(addr, size);
    size_t used = 0;
    while (used < size) {
      size_t n = parse(list+used, size-used, depth+1);
      if (!n) host::die("truncated GX display list at %08X", addr+uint32_t(used));
      used += n;
    }
    return 9;
  }
  if (op == 0x61) { if (len < 5) return 0; bp_write(be32(p+1)); return 5; }
  if (op >= 0x80 && op < 0xC0) {
    if (len < 3) return 0;
    size_t need = 3 + size_t(be16(p+1)) * build_desc(op & 7).size;
    // Replaces vertex decoding, texture snapshots and draw observation. Consume exactly
    // the same bytes so embedded data cannot be mistaken for PE interrupt commands.
    return len < need ? 0 : need;
  }
  // TODO(portability): add any further FIFO command with its real length/side effects.
  // Fail rather than guessing command boundaries (upstream merely logs unknown opcodes).
  host::die("TODO(portability): unsupported GX FIFO opcode %02X", op);
}
} // namespace
namespace host {
void gx_write(uint32_t value, int bytes) {
  if (bytes < 1 || bytes > 4) die("invalid FIFO write size");
  for (int i=bytes-1; i>=0; --i) fifo.push_back(uint8_t(value >> (8*i)));
  size_t used = 0;
  while (used < fifo.size()) {
    size_t n = parse(fifo.data()+used, fifo.size()-used, 0);
    if (!n) break;
    used += n;
  }
  if (used) fifo.erase(fifo.begin(), fifo.begin()+used);
  if (fifo.size() > 16*1024*1024) die("GX FIFO command exceeds bounded buffer");
}
}
