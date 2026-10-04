// Synthetic immutable textures; no game data. All timings include observable output.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <thread>
#include "rgba8.h"
using Clock=std::chrono::steady_clock;
static volatile uint64_t sink=0;
struct Task { uint32_t w,h,fmt,pf; std::vector<uint8_t> src,pal,out,ref; };
static void decode(Task& t,bool simd) {
  if(simd) decode_candidate(t.src.data(),t.w,t.h,t.fmt,t.pal.data(),t.pf,t.out);
  else gx::decode_texture(t.src.data(),t.w,t.h,t.fmt,t.pal.data(),t.pf,t.out);
}
// Persistent pool. Workers own disjoint destinations and only read immutable sources.
// The caller joins the batch before consuming results in original draw order.
class Pool {
  std::mutex m; std::condition_variable begin,end;
  std::vector<std::thread> workers; std::vector<Task>* tasks=nullptr;
  std::atomic<size_t> next{0}; unsigned generation=0,done=0; bool stop=false,simd=false;
public:
  explicit Pool(unsigned n) { for(unsigned i=0;i<n;++i) workers.emplace_back([this] {
    unsigned seen=0;
    for(;;) {
      std::unique_lock<std::mutex> lock(m);
      begin.wait(lock,[&]{return stop||generation!=seen;});
      if(stop) return;
      seen=generation; auto* batch=tasks; bool use=simd; lock.unlock();
      for(size_t i;(i=next.fetch_add(1))<batch->size();) decode((*batch)[i],use);
      lock.lock(); if(++done==workers.size()) end.notify_one();
    }
  }); }
  void run(std::vector<Task>& batch,bool use) {
    std::unique_lock<std::mutex> lock(m); tasks=&batch; simd=use; next=0; done=0; ++generation;
    begin.notify_all(); end.wait(lock,[&]{return done==workers.size();});
  }
  ~Pool() { {std::lock_guard<std::mutex> lock(m);stop=true;} begin.notify_all(); for(auto& t:workers)t.join(); }
};
static uint32_t rnd=12345;
static uint8_t byte() { rnd=rnd*1664525u+1013904223u; return rnd>>24; }
static Task task(uint32_t w,uint32_t h,uint32_t fmt,uint32_t pf) {
  Task t{w,h,fmt,pf,{},{},{},{}}; t.src.resize(gx::texture_level_bytes(w,h,fmt)); t.pal.resize(32768);
  for(auto& b:t.src)b=byte(); for(auto& b:t.pal)b=byte();
  gx::decode_texture(t.src.data(),w,h,fmt,t.pal.data(),pf,t.ref); return t;
}
int main() {
  // Differential edge dimensions, every supported format and palette interpretation.
  size_t cases=0;
  for(uint32_t fmt:{0u,1u,2u,3u,4u,5u,6u,8u,9u,10u,14u})
    for(uint32_t pf=0;pf<3;++pf) for(uint32_t w:{1u,3u,4u,7u,8u,17u,64u})
      for(uint32_t h:{1u,4u,5u,8u,19u,64u}) {
        auto t=task(w,h,fmt,pf);decode(t,true);if(t.out!=t.ref)std::abort();++cases;
      }
  printf("{\"differential_cases\":%zu,\"batches\":[",cases);
  Pool pool(2); bool comma=false;
  for(uint32_t fmt:{6u,4u,14u}) for(uint32_t count:{1u,8u,64u}) {
    std::vector<Task> batch; for(uint32_t i=0;i<count;++i)batch.push_back(task(128,128,fmt,0));
    double times[4]{};
    for(int mode=0;mode<4;++mode) {
      auto run=[&]{if(mode>=2)pool.run(batch,mode==3);else for(auto& t:batch)decode(t,mode==1);};
      for(int i=0;i<10;++i)run();
      for(int trial=0;trial<5;++trial) {
        auto start=Clock::now(); for(int i=0;i<100;++i)run();
        times[mode]+=std::chrono::duration<double,std::milli>(Clock::now()-start).count()/500;
        for(auto& t:batch){if(t.out!=t.ref)std::abort();sink+=t.out[trial];}
      }
    }
    if(comma)printf(",");comma=true;
    printf("{\"format\":%u,\"textures\":%u,\"pixels_each\":16384,\"serial_ms\":%.6f,\"simd_ms\":%.6f,\"threads_ms\":%.6f,\"both_ms\":%.6f}",fmt,count,times[0],times[1],times[2],times[3]);
  }
  printf("]}\n");return sink==0;
}
