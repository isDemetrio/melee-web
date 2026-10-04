// Actual PPC helper versus a guarded contiguous RAM loop; all slow paths remain.
#include "ppc.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <vector>
namespace ppc {
std::atomic<uint8_t> g_ram_watched[RAM_WATCH_COUNT];
std::atomic<uint32_t> g_ram_versions[RAM_WATCH_COUNT];
uint8_t* locked_cache(){static uint8_t cache[LC_SIZE+8]{};return cache;}
uint32_t mmio_read(Context&,uint32_t ea,int bytes){return ea^uint32_t(bytes);}
uint64_t mmio_read64(Context& c,uint32_t ea){return mmio_read(c,ea,8);}
}
static volatile uint32_t sink=0;
__attribute__((noinline)) uint32_t ordinary(ppc::Context& c,uint8_t* m,uint32_t address,uint32_t count){
  uint32_t sum=0;for(uint32_t i=0;i<count;++i)sum+=ppc::ld32(c,m,address+4*i);return sum;
}
__attribute__((noinline)) uint32_t hoisted(ppc::Context& c,uint8_t* m,uint32_t address,uint32_t count){
  uint32_t off=address&0x3fffffffu;
  if(off>=ppc::RAM_SIZE || count>(ppc::RAM_SIZE-off)/4)return ordinary(c,m,address,count);
  uint32_t sum=0;for(uint32_t i=0;i<count;++i){uint32_t v;std::memcpy(&v,m+off+4*i,4);sum+=__builtin_bswap32(v);}return sum;
}
__attribute__((noinline)) uint32_t constant(ppc::Context& c,uint8_t* m,uint32_t,uint32_t count){
  uint32_t sum=0;for(uint32_t i=0;i<count;++i)sum+=ppc::ld32(c,m,0x80000100);return sum;
}
__attribute__((noinline)) uint32_t resolved(ppc::Context&,uint8_t* m,uint32_t,uint32_t count){
  uint32_t sum=0;for(uint32_t i=0;i<count;++i){uint32_t v;std::memcpy(&v,m+0x100,4);sum+=__builtin_bswap32(v);}return sum;
}
int main(){
  ppc::Context c{};std::vector<uint8_t> ram(ppc::RAM_SIZE+64);uint32_t rng=7;
  for(auto& b:ram){rng=rng*1664525+1013904223;b=rng>>24;}
  unsigned cases=0;
  for(uint32_t a:{0u,1u,0x80000000u,0xc0000003u,ppc::RAM_SIZE-3,ppc::LC_BASE,0xcc000000u,0xfffffffcu})
    for(uint32_t n:{0u,1u,3u,8u}){if(ordinary(c,ram.data(),a,n)!=hoisted(c,ram.data(),a,n))std::abort();++cases;}
  if(constant(c,ram.data(),0,1024)!=resolved(c,ram.data(),0,1024))std::abort();
  auto measure=[&](auto f){auto t=std::chrono::steady_clock::now();for(int i=0;i<20000;++i)sink+=f(c,ram.data(),0x80000100,1024);return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-t).count();};
  printf("{\"edge_cases\":%u,\"loads\":20480000,\"ordinary_ms\":%.6f,\"hoisted_ms\":%.6f,\"constant_ms\":%.6f,\"resolved_ms\":%.6f}\n",cases,measure(ordinary),measure(hoisted),measure(constant),measure(resolved));
}
