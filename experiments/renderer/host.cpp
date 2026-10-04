// Minimal host for the existing renderer's synthetic selftest. No guest or game data.
#include "headless.h"
#include "gx_core.h"
#include <cstdlib>
namespace host {
uint8_t* ram=nullptr;
static gx::Backend* backend=nullptr;
void gx_set_backend(gx::Backend* b){backend=b;}
// Only the six BP registers emitted by gx_webgpu_selftest are accepted.
void gx_write(uint32_t v,int bytes){
  static bool pending=false;static uint32_t regs[256]{};
  if(bytes==1 && v==0x61 && !pending){pending=true;return;}
  if(bytes!=4 || !pending)std::abort();pending=false;
  uint32_t id=v>>24;regs[id]=v&0xffffff;
  if(id!=0x49 && id!=0x4a && id!=0x4f && id!=0x50 && id!=0x51 && id!=0x52)std::abort();
  if(id!=0x52)return;
  if(!backend)std::abort();
  gx::Frame f;gx::EfbCopy c{};c.src_w=640;c.src_h=480;c.to_xfb=true;c.clear=true;
  c.clear_color=((regs[0x4f]>>8)<<24)|((regs[0x4f]&255)<<16)|regs[0x50];c.clear_z=regs[0x51];
  f.copies.push_back(c);f.commands.push_back({gx::FrameCommand::Copy,0});backend->submit_frame(f);
}
}
