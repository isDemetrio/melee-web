// CI-only ordered renderer-input oracle for the four-player load test. Enabled by MELEE_GFX_ORACLE.
// Derived from experiments/texture-simd/oracle.h (itself derived from
// experiments/beyond-core/graphics_oracle.h on perf/beyond-core), with the texture half removed:
// this experiment measures the character cost, not the decoder.
//
// It reads only what the shipped gx::Frame already carries -- vertices, segments, draws, copies,
// commands, hud_players, player_names -- so nothing in wasm/ or native/ has to change to get a
// number. Two things it answers that sim_ms alone cannot:
//
//   - how many characters are actually on screen: capture_match_hud (gx_core.cpp) sets
//     hud_players[slot].present for every slot whose HUD elements exist, so the number of present
//     slots is the number of fighters in the match. `four_hud_frames` counts the match frames
//     where all four are present; that is the certification that the four-player workload really
//     put four characters in a match, and not four connected pads with two characters on screen
//     (the trap perf/beyond-core/four-player.txt fell into).
//   - how the render workload scales: draws, vertices and segments per frame. The simulation is
//     shared, so if the four-player cost is mostly higher, this is where it shows.
//
// Writes digests, counts and timings only. Never writes guest data.
#pragma once
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>
#include "gx_core.h"
#include "wasm/compat/sha1.h"

namespace fourplayer {

class Oracle {
  FILE* digest_file = nullptr;
  FILE* frames_file = nullptr;
  std::vector<uint8_t> bytes;
  // Totals.
  uint64_t frames = 0, match_frames = 0;
  uint64_t four_hud_frames = 0, three_hud_frames = 0, two_hud_frames = 0, one_hud_frames = 0, zero_hud_frames = 0;
  uint64_t all_draws = 0, match_draws = 0, all_vertices = 0, match_vertices = 0;
  uint64_t max_hud_present = 0;

  template <class T> void add(const T& v) {
    auto* p = reinterpret_cast<const uint8_t*>(&v);
    bytes.insert(bytes.end(), p, p + sizeof(v));
  }

 public:
  Oracle() {
    if (auto* p = std::getenv("MELEE_GFX_ORACLE")) { digest_file = std::fopen(p, "w"); if (!digest_file) std::abort(); }
    if (auto* p = std::getenv("MELEE_FRAME_TIMES")) {
      frames_file = std::fopen(p, "w");
      if (!frames_file) std::abort();
      std::fprintf(frames_file, "sequence,scene_major,scene_minor,hud_present,draws,vertices,segments,copies\n");
    }
  }
  ~Oracle() {
    if (!digest_file) return;
    std::fclose(digest_file);
    if (frames_file) std::fclose(frames_file);
    std::printf("four-player oracle: {\"frames\":%llu,\"match_frames\":%llu,\"four_hud_frames\":%llu,"
                "\"three_hud_frames\":%llu,\"two_hud_frames\":%llu,\"one_hud_frames\":%llu,"
                "\"zero_hud_frames\":%llu,\"max_hud_present\":%llu,\"all_draws\":%llu,"
                "\"match_draws\":%llu,\"all_vertices\":%llu,\"match_vertices\":%llu}\n",
                (unsigned long long)frames, (unsigned long long)match_frames,
                (unsigned long long)four_hud_frames, (unsigned long long)three_hud_frames,
                (unsigned long long)two_hud_frames, (unsigned long long)one_hud_frames,
                (unsigned long long)zero_hud_frames, (unsigned long long)max_hud_present,
                (unsigned long long)all_draws, (unsigned long long)match_draws,
                (unsigned long long)all_vertices, (unsigned long long)match_vertices);
  }

  void frame(const gx::Frame& f) {
    if (!digest_file) return;
    const bool in_match = f.scene_major == 2 && f.scene_minor == 2;
    uint64_t hud = 0;
    for (auto& h : f.hud_players) if (h.present) ++hud;
    ++frames;
    if (in_match) ++match_frames;
    if (hud > max_hud_present) max_hud_present = hud;
    if (in_match) {
      if (hud == 4) ++four_hud_frames;
      else if (hud == 3) ++three_hud_frames;
      else if (hud == 2) ++two_hud_frames;
      else if (hud == 1) ++one_hud_frames;
      else ++zero_hud_frames;
    }
    all_draws += f.draws.size();
    all_vertices += f.vertices.size();
    if (in_match) { match_draws += f.draws.size(); match_vertices += f.vertices.size(); }

    // Ordered renderer input, the same field set the beyond-core oracle hashed, minus textures.
    bytes.clear();
    add(f.sequence); add(f.scene_major); add(f.scene_minor); add(f.discontinuous);
    add(uint64_t(f.vertices.size()));
    for (auto& v : f.vertices) { add(v.pos); add(v.nrm); add(v.col0); add(v.col1); add(v.uv); add(v.posmtx); add(v.texmtx); }
    add(uint64_t(f.segments.size()));
    for (auto& s : f.segments) { add(s.first_vertex); add(s.vertex_count); add(s.primitive); }
    add(uint64_t(f.commands.size()));
    for (auto& c : f.commands) { add(c.kind); add(c.index); }
    add(uint64_t(f.copies.size()));
    for (auto& c : f.copies) {
      add(c.dest_addr); add(c.dest_stride); add(c.src_x); add(c.src_y); add(c.src_w); add(c.src_h); add(c.format);
      add(c.to_xfb); add(c.clear); add(c.intensity); add(c.half_scale); add(c.is_depth); add(c.clear_color); add(c.clear_z); add(c.y_scale);
    }
    add(uint64_t(f.draws.size()));
    for (auto& d : f.draws) {
      add(d.primitive); add(d.first_vertex); add(d.vertex_count); add(d.first_segment); add(d.segment_count); add(d.components);
      add(d.bp.reg); add(d.posMatrices); add(d.normalMatrices);
      if (d.xf_regs[0x12] & 1) add(d.postMatrices);
      bool lit = false;
      for (uint32_t j = 0; j < (d.xf_regs[0x09] & 3); ++j) lit = lit || gx::lit_enable(d.xf_regs[0x0e + j]) || gx::lit_enable(d.xf_regs[0x10 + j]);
      if (lit) add(d.lights);
      add(d.xf_regs);
      add(d.matrix_index_a); add(d.matrix_index_b); add(d.tev_colors); add(d.tev_kcolors);
      add(d.identity); add(d.object_generation); add(d.owner_player); add(d.skinned);
      if (d.authored_pose) std::abort();
    }
    for (auto& h : f.hud_players) { add(h.damage); add(h.stocks); add(h.tag_x); add(h.tag_y); add(h.present); add(h.tag_visible); }
    for (auto& s : f.player_names) { add(uint64_t(s.size())); bytes.insert(bytes.end(), s.begin(), s.end()); }

    const auto hash = wasm_compat::sha1(bytes.data(), bytes.size());
    std::fprintf(digest_file, "%llu,", (unsigned long long)f.sequence);
    for (auto b : hash) std::fprintf(digest_file, "%02x", b);
    std::fputc('\n', digest_file);
    std::fflush(digest_file);
    if (frames_file) {
      std::fprintf(frames_file, "%llu,%u,%u,%llu,%zu,%zu,%zu,%zu\n", (unsigned long long)f.sequence,
                   unsigned(f.scene_major), unsigned(f.scene_minor), (unsigned long long)hud,
                   f.draws.size(), f.vertices.size(), f.segments.size(), f.copies.size());
      std::fflush(frames_file);
    }
  }
};

inline void graphics_oracle(const gx::Frame& f) { static Oracle oracle; oracle.frame(f); }

}  // namespace fourplayer
