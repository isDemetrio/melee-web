// Experiment-only ordered renderer-input oracle, enabled by MELEE_GFX_ORACLE path.
// Excludes host pointers, padding and wall-clock timing. Never exports guest data.
#pragma once
#include <cstdio>
#include <cstdlib>
#include <map>
#include <chrono>
#include <tuple>
#include "gx_core.h"
#include "wasm/compat/sha1.h"
namespace experiment {
class GraphicsOracle {
  FILE* file=nullptr;
  double decode_ms=0,match_decode_ms=0,max_frame_decode_ms=0;
  uint64_t decode_bytes=0,frames=0,match_frames=0,four_hud_frames=0,match_keys=0,match_zero_keys=0,max_frame_keys=0;
  std::array<uint64_t,16> format_bytes{};std::array<double,16> format_ms{};
  std::vector<uint8_t> bytes;
  using TextureKey=std::tuple<std::shared_ptr<const gx::TextureSnapshot>,uint32_t,uint32_t,uint32_t,uint32_t,uint32_t>;
  std::map<TextureKey,std::array<uint8_t,20>> cache;
  template<class T> void add(const T& v) {
    auto* p=reinterpret_cast<const uint8_t*>(&v);bytes.insert(bytes.end(),p,p+sizeof(v));
  }
  void blob(const std::vector<uint8_t>& v) {add(uint64_t(v.size()));bytes.insert(bytes.end(),v.begin(),v.end());}
public:
  GraphicsOracle() {if(auto* p=std::getenv("MELEE_GFX_ORACLE")){file=std::fopen(p,"w");if(!file)std::abort();}}
  ~GraphicsOracle() {
    if(!file)return;std::fclose(file);
    std::printf("graphics decode: {\"decode_ms\":%.6f,\"decoded_bytes\":%llu,\"unique_keys\":%zu,\"frames\":%llu,\"match_frames\":%llu,\"four_hud_frames\":%llu,\"match_decode_ms\":%.6f,\"match_keys\":%llu,\"match_zero_keys\":%llu,\"max_frame_keys\":%llu,\"max_frame_decode_ms\":%.6f,\"formats\":[",
      decode_ms,(unsigned long long)decode_bytes,cache.size(),(unsigned long long)frames,
      (unsigned long long)match_frames,(unsigned long long)four_hud_frames,match_decode_ms,
      (unsigned long long)match_keys,(unsigned long long)match_zero_keys,(unsigned long long)max_frame_keys,max_frame_decode_ms);
    for(int i=0;i<16;++i)std::printf("%s{\"format\":%d,\"bytes\":%llu,\"ms\":%.6f}",i?",":"",i,(unsigned long long)format_bytes[i],format_ms[i]);
    std::printf("]}\n");
  }
  void frame(const gx::Frame& f) {
    if(!file)return;
    const bool in_match=f.scene_major==2 && f.scene_minor==2;
    const double before_ms=decode_ms;const size_t before_keys=cache.size();
    ++frames;if(in_match)++match_frames;
    if(f.scene_major==2 && f.scene_minor==2 && std::all_of(f.hud_players.begin(),f.hud_players.end(),[](const auto& h){return h.present;}))++four_hud_frames;
    bytes.clear();add(f.sequence);add(f.scene_major);add(f.scene_minor);add(f.discontinuous);
    add(uint64_t(f.vertices.size()));
    for(auto& v:f.vertices){add(v.pos);add(v.nrm);add(v.col0);add(v.col1);add(v.uv);add(v.posmtx);add(v.texmtx);}
    add(uint64_t(f.segments.size()));for(auto& s:f.segments){add(s.first_vertex);add(s.vertex_count);add(s.primitive);}
    add(uint64_t(f.commands.size()));for(auto& c:f.commands){add(c.kind);add(c.index);}
    add(uint64_t(f.copies.size()));for(auto& c:f.copies){
      add(c.dest_addr);add(c.dest_stride);add(c.src_x);add(c.src_y);add(c.src_w);add(c.src_h);add(c.format);
      add(c.to_xfb);add(c.clear);add(c.intensity);add(c.half_scale);add(c.is_depth);add(c.clear_color);add(c.clear_z);add(c.y_scale);
    }
    add(uint64_t(f.draws.size()));for(auto& d:f.draws){
      add(d.primitive);add(d.first_vertex);add(d.vertex_count);add(d.first_segment);add(d.segment_count);add(d.components);
      add(d.bp.reg);add(d.posMatrices);add(d.normalMatrices);
      // SkipInit deliberately leaves disabled post transforms/lights undefined.
      // Only hash initialized state, under the exact capture predicates in gx_core.cpp.
      if(d.xf_regs[0x12]&1)add(d.postMatrices);
      bool lit=false;for(uint32_t j=0;j<(d.xf_regs[0x09]&3);++j)lit=lit||gx::lit_enable(d.xf_regs[0x0e+j])||gx::lit_enable(d.xf_regs[0x10+j]);
      if(lit)add(d.lights);add(d.xf_regs);
      add(d.matrix_index_a);add(d.matrix_index_b);add(d.tev_colors);add(d.tev_kcolors);
      add(d.identity);add(d.object_generation);add(d.owner_player);add(d.skinned);
      // Authored subframe captures are disabled in this offline host; fail if that changes.
      if(d.authored_pose)std::abort();
      for(auto& t:d.textures){
        add(t.used);if(!t.used)continue;
        add(t.addr);add(t.width);add(t.height);add(t.format);add(t.tlut_addr);add(t.tlut_format);add(t.mode0);add(t.mode1);add(t.mip_levels);
        add(bool(t.data));if(!t.data)continue;
        // Metadata belongs to the key too: same bytes may be decoded in different formats.
        // Do not cache decoded data by snapshot pointer alone.
        TextureKey key{t.data,t.width,t.height,t.format,t.tlut_format,t.mip_levels};
        auto found=cache.find(key);
        if(found!=cache.end()){add(found->second);continue;}
        auto saved=std::move(bytes);bytes={};
        blob(t.data->image);blob(t.data->palette);
        size_t offset=0;uint32_t w=t.width,h=t.height;
        for(uint32_t level=0;level<t.mip_levels;++level){
          auto n=gx::texture_level_bytes(w,h,t.format);if(offset+n>t.data->image.size())std::abort();
          std::vector<uint8_t> rgba;
          auto start=std::chrono::steady_clock::now();
          gx::decode_texture(t.data->image.data()+offset,w,h,t.format,t.data->palette.data(),t.tlut_format,rgba);
          const double dt=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
          decode_ms+=dt;if(t.format<16){format_ms[t.format]+=dt;format_bytes[t.format]+=rgba.size();}
          decode_bytes+=rgba.size();
          blob(rgba);offset+=n;w=std::max(1u,w/2);h=std::max(1u,h/2);
        }
        auto digest=wasm_compat::sha1(bytes.data(),bytes.size());cache.emplace(key,digest);
        bytes=std::move(saved);add(digest);
      }
    }
    for(auto& h:f.hud_players){add(h.damage);add(h.stocks);add(h.tag_x);add(h.tag_y);add(h.present);add(h.tag_visible);}
    for(auto& s:f.player_names){add(uint64_t(s.size()));bytes.insert(bytes.end(),s.begin(),s.end());}
    const double frame_ms=decode_ms-before_ms;const size_t frame_keys=cache.size()-before_keys;
    max_frame_keys=std::max<uint64_t>(max_frame_keys,frame_keys);max_frame_decode_ms=std::max(max_frame_decode_ms,frame_ms);
    if(in_match){match_decode_ms+=frame_ms;match_keys+=frame_keys;if(!frame_keys)++match_zero_keys;}
    const auto hash=wasm_compat::sha1(bytes.data(),bytes.size());
    std::fprintf(file,"%llu,",(unsigned long long)f.sequence);for(auto b:hash)std::fprintf(file,"%02x",b);std::fputc('\n',file);std::fflush(file);
  }
};
inline void graphics_oracle(const gx::Frame& f) {static GraphicsOracle oracle;oracle.frame(f);}
}
