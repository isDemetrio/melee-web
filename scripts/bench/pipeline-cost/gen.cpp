// Emits, for synthetic draw states, the specialized WGSL and the uniform rows 106+ (TEV, uid, lights)
// of the lit-channels generator, plus its one shader, as JSON on stdout.
#include "gx_wgsl.h"
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>
static std::string esc(const std::string& s) {
  std::string o; for (char c : s) { if (c == '"' || c == '\\') { o += '\\'; o += c; } else if (c == '\n') o += "\\n"; else o += c; } return o;
}
int main(int argc, char** argv) {
  const bool uber_only = argc > 1 && !std::strcmp(argv[1], "uber");
  if (uber_only) { std::printf("\"%s\"\n", esc(gxw::generate_uber_wgsl()).c_str()); return 0; }
  std::vector<std::pair<std::string, std::unique_ptr<gx::DrawCall>>> states;
  auto base = [] {
    auto dc = std::make_unique<gx::DrawCall>();
    dc->components = gx::VB_HAS_COL0 | gx::VB_HAS_UV0;
    dc->xf_regs[0x09] = 1; dc->xf_regs[0x0E] = 1; dc->xf_regs[0x10] = 1;   // vertex colour
    dc->xf_regs[0x3F] = 1; dc->xf_regs[0x40] = 5u << 7;                   // texgen 0 from tex0, 2x4
    dc->bp.reg[gx::BP_GENMODE] = 1 | 1u << 4;
    dc->bp.reg[gx::BP_TREF] = 1u << 6;                                    // stage 0: map 0, coord 0, chan 0
    dc->bp.reg[gx::BP_ALPHACOMPARE] = 7u << 16 | 7u << 19;                // always
    return dc;
  };
  {  // 1 stage: texture x vertex colour (modulate), the commonest game draw
    auto dc = base();
    dc->bp.reg[gx::BP_TEV_COLOR_ENV] = 15 | 10u << 4 | 8u << 8 | 15u << 12 | 1u << 19;
    dc->bp.reg[gx::BP_TEV_ALPHA_ENV] = 7u << 4 | 5u << 7 | 4u << 10 | 7u << 13 | 1u << 19;
    states.emplace_back("modulate", std::move(dc));
  }
  {  // 1 stage, lit channel 0 (one light, diffuse clamped, spot attenuation), texture x channel
    auto dc = base();
    dc->components |= gx::VB_HAS_NRM0;
    dc->xf_regs[0x0E] = 1u << 1 | 1u << 2 | 2u << 7 | 1u << 9; dc->xf_regs[0x10] = 1;
    dc->xf_regs[0x0A] = 0x323232FFu; dc->xf_regs[0x0C] = 0xC8C8C8FFu;
    const uint32_t colour = 0x646464FFu; std::memcpy(dc->lights[0] + 12, &colour, 4);
    const float light[12] = {1, 0, 0, 1, 0, 0, 0, 0, 1000, 0, 0, 1}; std::memcpy(dc->lights[0] + 16, light, sizeof light);
    dc->bp.reg[gx::BP_TEV_COLOR_ENV] = 15 | 10u << 4 | 8u << 8 | 15u << 12 | 1u << 19;
    dc->bp.reg[gx::BP_TEV_ALPHA_ENV] = 7u << 4 | 5u << 7 | 4u << 10 | 7u << 13 | 1u << 19;
    states.emplace_back("lit", std::move(dc));
  }
  // 48 pseudo-random states, the grammar of selftest geometry 49 (same generator and seed).
  uint32_t seed = 0x2545F491u;
  auto next = [&] { seed = seed * 1664525u + 1013904223u; return seed >> 8; };
  for (int k = 0; k < 48; k++) {
    auto r = base();
    const uint32_t stages = 1 + next() % 16;
    r->bp.reg[gx::BP_GENMODE] = 1 | 1u << 4 | (stages - 1) << 10;
    for (uint32_t i = 0; i < stages; i++) { r->bp.reg[gx::BP_TEV_COLOR_ENV + 2 * i] = next(); r->bp.reg[gx::BP_TEV_ALPHA_ENV + 2 * i] = next(); }
    for (int i = 0; i < 8; i++) { r->bp.reg[gx::BP_TREF + i] = next(); r->bp.reg[gx::BP_TEV_KSEL + i] = next(); }
    r->bp.reg[gx::BP_ALPHACOMPARE] = next();
    r->bp.reg[gx::BP_FOGPARAM3] = next(); r->bp.reg[gx::BP_FOGRANGE] = next() & 0x7FF;
    r->bp.reg[gx::BP_FOGPARAM0] = next(); r->bp.reg[gx::BP_FOGBMAGNITUDE] = next(); r->bp.reg[gx::BP_FOGBEXPONENT] = next() & 31;
    r->xf_regs[0x09] = next() % 3;
    for (int i = 0x0E; i <= 0x11; i++) r->xf_regs[i] = next() & 0x7FFF;
    r->xf_regs[0x3F] = next() % 9; r->xf_regs[0x12] = next() & 1;
    for (int i = 0; i < 8; i++) { r->xf_regs[0x40 + i] = next() & 0x3FFFF; r->xf_regs[0x50 + i] = next() & 0x13F; }
    r->components = next() & (gx::VB_HAS_COL0 | gx::VB_HAS_COL1 | gx::VB_HAS_NRM0 | 0xFFu * gx::VB_HAS_UV0 | 0x1FEu);
    for (auto& c : r->tev_colors) for (auto& v : c) v = int32_t(next() % 2048) - 1024;
    for (auto& c : r->tev_kcolors) for (auto& v : c) v = int32_t(next() % 256);
    states.emplace_back("random" + std::to_string(k), std::move(r));
  }
  std::printf("[\n");
  for (size_t s = 0; s < states.size(); s++) {
    const auto uid = gxw::make_uid(*states[s].second);
    static float u[gxw::MAX_ROWS][4];
    std::memset(u, 0, sizeof u);
    gxw::fill_tev_rows(*states[s].second, u);
    gxw::fill_uid_rows(uid, u);
    std::printf("{\"name\":\"%s\",\"stages\":%u,\"wgsl\":\"%s\",\"rows\":[", states[s].first.c_str(), uid.w[24], esc(gxw::generate_wgsl(uid)).c_str());
    for (int r = gxw::ROW_TEV_COLORS; r < gxw::MAX_ROWS; r++) for (int c = 0; c < 4; c++) { uint32_t b; std::memcpy(&b, &u[r][c], 4); std::printf("%s%u", r == gxw::ROW_TEV_COLORS && !c ? "" : ",", b); }
    std::printf("]}%s\n", s + 1 < states.size() ? "," : "");
  }
  std::printf("]\n");
}
