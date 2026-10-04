// CI-only ordered renderer-input oracle for the texture SIMD integration. Enabled by MELEE_GFX_ORACLE.
// Derived from experiments/beyond-core/graphics_oracle.h on perf/beyond-core (same hashed fields,
// same SkipInit predicates); what is new is the texture half:
//   - textures are decoded by gxw::decode_texture_level, the renderer's own decoder, so the baseline
//     build (GXW_TEXTURE_DECODE_REFERENCE) hashes the reference and the candidate hashes SIMD;
//   - every decode is also run through gx::decode_texture and compared byte for byte, every mip;
//     any difference aborts the replay;
//   - decodes happen when the renderer would decode: on a miss of a simulated texture pool with
//     gxw_bind's limits (LRU, 1024 textures, 64 MiB), skipping EFB-copy addresses as upload_textures
//     does, in command order. Both decoders are timed on every miss, alternating which goes first.
// Writes digests and timings only. Never writes guest data.
#pragma once
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <list>
#include <map>
#include <set>
#include <tuple>
#include <unordered_set>
#include "gx_core.h"
#include "wasm/compat/sha1.h"
#include "wasm/render/texture_decode.h"
namespace texsimd {
using Clock = std::chrono::steady_clock;
class Oracle {
  FILE* file = nullptr;
  FILE* times = nullptr;
  std::vector<uint8_t> bytes;
  using Key = std::tuple<std::shared_ptr<const gx::TextureSnapshot>, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t>;
  std::map<Key, std::array<uint8_t, 20>> digests;
  // Simulated gxw_bind pool: LRU order, front = least recent.
  std::list<Key> lru;
  std::map<Key, std::pair<std::list<Key>::iterator, uint64_t>> pool;
  uint64_t pool_bytes = 0;
  std::unordered_set<uint32_t> efb_copy_addrs;
  // Totals.
  uint64_t frames = 0, misses = 0, evictions = 0, levels = 0, simd_levels = 0, table_levels = 0, flip = 0;
  std::array<uint64_t, 16> fmt_misses{}, fmt_levels{}, fmt_simd_levels{}, fmt_table_levels{}, fmt_bytes{};
  std::array<double, 16> fmt_ref_ms{}, fmt_cand_ms{};
  // This frame.
  double frame_ref_ms = 0, frame_cand_ms = 0;
  uint64_t frame_misses = 0, frame_simd_levels = 0, frame_table_levels = 0;
  template <class T> void add(const T& v) {
    auto* p = reinterpret_cast<const uint8_t*>(&v); bytes.insert(bytes.end(), p, p + sizeof(v));
  }
  void blob(const std::vector<uint8_t>& v) { add(uint64_t(v.size())); bytes.insert(bytes.end(), v.begin(), v.end()); }
  static uint64_t chain_size(uint32_t w, uint32_t h, uint32_t n) {
    uint64_t s = 0; for (uint32_t l = 0; l < n; ++l) s += uint64_t(std::max(1u, w >> l)) * std::max(1u, h >> l) * 4; return s;
  }
  static bool renderer_supports(const gx::TextureRef& t) {
    const bool fmt = t.format <= 6 || t.format == 8 || t.format == 9 || t.format == 10 || t.format == 14;
    return fmt && t.data && t.width && t.height && t.width <= 1024 && t.height <= 1024;
  }
  // Decodes every level with `candidate` (the renderer's decoder) or the reference.
  double decode_chain(const gx::TextureRef& t, bool candidate, std::vector<std::vector<uint8_t>>& out) {
    out.resize(t.mip_levels);
    size_t offset = 0; uint32_t w = t.width, h = t.height;
    const auto start = Clock::now();
    for (uint32_t level = 0; level < t.mip_levels; ++level) {
      const auto n = gx::texture_level_bytes(w, h, t.format);
      if (offset + n > t.data->image.size()) std::abort();
      if (candidate) gxw::decode_texture_level(t.data->image.data() + offset, w, h, t.format, t.data->palette.data(), t.tlut_format, out[level]);
      else gx::decode_texture(t.data->image.data() + offset, w, h, t.format, t.data->palette.data(), t.tlut_format, out[level]);
      offset += n; w = std::max(1u, w / 2); h = std::max(1u, h / 2);
    }
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
  }
  // A miss of the simulated pool: what upload_textures decodes.
  void miss(const Key& key, const gx::TextureRef& t) {
    std::vector<std::vector<uint8_t>> ref, cand;
    double ref_ms, cand_ms;
    if (flip++ & 1) { ref_ms = decode_chain(t, false, ref); cand_ms = decode_chain(t, true, cand); }
    else { cand_ms = decode_chain(t, true, cand); ref_ms = decode_chain(t, false, ref); }
    if (ref != cand) { std::fprintf(stderr, "texsimd: decoded texture differs from reference (format %u %ux%u)\n", t.format, t.width, t.height); std::abort(); }
    uint32_t w = t.width, h = t.height; uint64_t simd = 0, table = 0;
    for (uint32_t l = 0; l < t.mip_levels; ++l) {
      simd += gxw::texture_level_simd(w, h, t.format); table += gxw::texture_level_table(w, h, t.format);
      w = std::max(1u, w / 2); h = std::max(1u, h / 2);
    }
    ++misses; ++frame_misses; levels += t.mip_levels; simd_levels += simd; frame_simd_levels += simd; table_levels += table; frame_table_levels += table;
    frame_ref_ms += ref_ms; frame_cand_ms += cand_ms;
    const uint32_t f = t.format & 15;
    ++fmt_misses[f]; fmt_levels[f] += t.mip_levels; fmt_simd_levels[f] += simd; fmt_table_levels[f] += table;
    for (auto& l : cand) fmt_bytes[f] += l.size();
    fmt_ref_ms[f] += ref_ms; fmt_cand_ms[f] += cand_ms;
    // Same content decoded before (evicted then reused): it must give the same digest.
    std::vector<uint8_t> saved = std::move(bytes); bytes = {};
    blob(t.data->image); blob(t.data->palette); for (auto& l : cand) blob(l);
    const auto digest = wasm_compat::sha1(bytes.data(), bytes.size());
    bytes = std::move(saved);
    auto found = digests.find(key);
    if (found == digests.end()) digests.emplace(key, digest);
    else if (found->second != digest) { std::fprintf(stderr, "texsimd: re-decode differs\n"); std::abort(); }
  }
  void bind(const gx::TextureRef& t) {
    const Key key{t.data, t.width, t.height, t.format, t.tlut_format, t.mip_levels};
    auto hit = pool.find(key);
    if (hit != pool.end()) { lru.splice(lru.end(), lru, hit->second.first); return; }
    const uint64_t size = chain_size(t.width, t.height, t.mip_levels);
    while (!lru.empty() && (pool.size() >= 1024 || pool_bytes + size > (64u << 20))) {
      auto old = pool.find(lru.front()); pool_bytes -= old->second.second; pool.erase(old); lru.pop_front(); ++evictions;
    }
    lru.push_back(key); pool.emplace(key, std::make_pair(std::prev(lru.end()), size)); pool_bytes += size;
    miss(key, t);
  }

 public:
  Oracle() {
    if (auto* p = std::getenv("MELEE_GFX_ORACLE")) { file = std::fopen(p, "w"); if (!file) std::abort(); }
    if (auto* p = std::getenv("MELEE_TEX_TIMES")) {
      times = std::fopen(p, "w"); if (!times) std::abort();
      std::fprintf(times, "sequence,scene_major,scene_minor,misses,simd_levels,table_levels,ref_ms,cand_ms\n");
    }
  }
  ~Oracle() {
    if (!file) return;
    std::fclose(file); if (times) std::fclose(times);
    std::printf("texsimd summary: {\"frames\":%llu,\"misses\":%llu,\"unique\":%zu,\"evictions\":%llu,\"levels\":%llu,\"simd_levels\":%llu,\"table_levels\":%llu,\"formats\":[",
                (unsigned long long)frames, (unsigned long long)misses, digests.size(), (unsigned long long)evictions,
                (unsigned long long)levels, (unsigned long long)simd_levels, (unsigned long long)table_levels);
    bool comma = false;
    for (int i = 0; i < 16; ++i) {
      if (!fmt_misses[i]) continue;
      std::printf("%s{\"format\":%d,\"misses\":%llu,\"levels\":%llu,\"simd_levels\":%llu,\"table_levels\":%llu,\"bytes\":%llu,\"ref_ms\":%.6f,\"cand_ms\":%.6f}",
                  comma ? "," : "", i, (unsigned long long)fmt_misses[i], (unsigned long long)fmt_levels[i],
                  (unsigned long long)fmt_simd_levels[i], (unsigned long long)fmt_table_levels[i], (unsigned long long)fmt_bytes[i], fmt_ref_ms[i], fmt_cand_ms[i]);
      comma = true;
    }
    std::printf("]}\n");
  }
  void frame(const gx::Frame& f) {
    if (!file) return;
    ++frames; frame_ref_ms = frame_cand_ms = 0; frame_misses = frame_simd_levels = frame_table_levels = 0;
    bytes.clear(); add(f.sequence); add(f.scene_major); add(f.scene_minor); add(f.discontinuous);
    add(uint64_t(f.vertices.size()));
    for (auto& v : f.vertices) { add(v.pos); add(v.nrm); add(v.col0); add(v.col1); add(v.uv); add(v.posmtx); add(v.texmtx); }
    add(uint64_t(f.segments.size())); for (auto& s : f.segments) { add(s.first_vertex); add(s.vertex_count); add(s.primitive); }
    add(uint64_t(f.commands.size())); for (auto& c : f.commands) { add(c.kind); add(c.index); }
    add(uint64_t(f.copies.size())); for (auto& c : f.copies) {
      add(c.dest_addr); add(c.dest_stride); add(c.src_x); add(c.src_y); add(c.src_w); add(c.src_h); add(c.format);
      add(c.to_xfb); add(c.clear); add(c.intensity); add(c.half_scale); add(c.is_depth); add(c.clear_color); add(c.clear_z); add(c.y_scale);
    }
    // Command order, as WebGpuBackend::submit_frame: copies register EFB-copy addresses before
    // later draws bind them.
    add(uint64_t(f.draws.size()));
    size_t drawn = 0;
    for (auto& cmd : f.commands) {
      if (cmd.kind != gx::FrameCommand::Draw) {
        const auto& c = f.copies[cmd.index];
        if (!c.to_xfb && !c.is_depth && c.dest_addr) efb_copy_addrs.insert(c.dest_addr);
        continue;
      }
      const auto& d = f.draws[cmd.index];
      ++drawn; add(cmd.index);
      add(d.primitive); add(d.first_vertex); add(d.vertex_count); add(d.first_segment); add(d.segment_count); add(d.components);
      add(d.bp.reg); add(d.posMatrices); add(d.normalMatrices);
      // SkipInit deliberately leaves disabled post transforms/lights undefined.
      // Only hash initialized state, under the exact capture predicates in gx_core.cpp.
      if (d.xf_regs[0x12] & 1) add(d.postMatrices);
      bool lit = false;
      for (uint32_t j = 0; j < (d.xf_regs[0x09] & 3); ++j) lit = lit || gx::lit_enable(d.xf_regs[0x0e + j]) || gx::lit_enable(d.xf_regs[0x10 + j]);
      if (lit) add(d.lights);
      add(d.xf_regs);
      add(d.matrix_index_a); add(d.matrix_index_b); add(d.tev_colors); add(d.tev_kcolors);
      add(d.identity); add(d.object_generation); add(d.owner_player); add(d.skinned);
      // Authored subframe captures are disabled in this offline host; fail if that changes.
      if (d.authored_pose) std::abort();
      for (auto& t : d.textures) {
        add(t.used); if (!t.used) continue;
        add(t.addr); add(t.width); add(t.height); add(t.format); add(t.tlut_addr); add(t.tlut_format); add(t.mode0); add(t.mode1); add(t.mip_levels);
        add(bool(t.data)); if (!t.data) continue;
        if (efb_copy_addrs.count(t.addr) || !renderer_supports(t)) continue;
        const Key key{t.data, t.width, t.height, t.format, t.tlut_format, t.mip_levels};
        bind(t);
        add(digests.at(key));
      }
    }
    // Every draw is reached through exactly one command.
    if (drawn != f.draws.size()) std::abort();
    for (auto& h : f.hud_players) { add(h.damage); add(h.stocks); add(h.tag_x); add(h.tag_y); add(h.present); add(h.tag_visible); }
    for (auto& s : f.player_names) { add(uint64_t(s.size())); bytes.insert(bytes.end(), s.begin(), s.end()); }
    const auto hash = wasm_compat::sha1(bytes.data(), bytes.size());
    std::fprintf(file, "%llu,", (unsigned long long)f.sequence); for (auto b : hash) std::fprintf(file, "%02x", b);
    std::fputc('\n', file); std::fflush(file);
    if (times) std::fprintf(times, "%llu,%u,%u,%llu,%llu,%llu,%.6f,%.6f\n", (unsigned long long)f.sequence, unsigned(f.scene_major),
                            unsigned(f.scene_minor), (unsigned long long)frame_misses, (unsigned long long)frame_simd_levels, (unsigned long long)frame_table_levels,
                            frame_ref_ms, frame_cand_ms);
  }
};
inline void graphics_oracle(const gx::Frame& f) { static Oracle oracle; oracle.frame(f); }
}  // namespace texsimd
