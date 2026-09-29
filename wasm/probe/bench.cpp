#include "ppc.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace ppc {
std::atomic<uint8_t> g_ram_watched[RAM_WATCH_COUNT]{};
std::atomic<uint32_t> g_ram_versions[RAM_WATCH_COUNT]{};
uint8_t* locked_cache() { std::abort(); }
uint32_t mmio_read(Context&, uint32_t, int) { std::abort(); }
void mmio_write(Context&, uint32_t, uint32_t, int) { std::abort(); }
}
// Barriers retain the arithmetic and actual memory round trips without volatile RAM.
static inline void retain(double& x) { asm volatile("" : "+m"(x) : : "memory"); }
static inline void memory_barrier() { asm volatile("" : : : "memory"); }
using Clock=std::chrono::steady_clock;
static double ns(Clock::time_point start, Clock::time_point end) {
  return std::chrono::duration<double,std::nano>(end-start).count();
}
int main() {
  constexpr unsigned N=10000000;
  ppc::Context cpu{};
  std::vector<uint8_t> ram(ppc::RAM_SIZE);
  double value=1.0;
  const auto f0=Clock::now();
  for (unsigned i=0;i<N;++i) {
    value=ppc::fmadd(value,0.999999999,0.000000002);
    retain(value);
  }
  const auto f1=Clock::now();
  uint32_t sum=0;
  const auto m0=Clock::now();
  for (unsigned i=0;i<N;++i) {
    const uint32_t address=ppc::RAM_BASE+((i&16383u)*4);
    // port/runtime/ppc/ppc.h:179-183,200-205 swaps guest big-endian words on a little-endian host.
    ppc::st32(cpu,ram.data(),address,i);
    memory_barrier();
    sum+=ppc::ld32(cpu,ram.data(),address);
    memory_barrier();
  }
  const auto m1=Clock::now();
  if (sum!=uint32_t(uint64_t(N)*(N-1)/2)) return 1;
  std::printf("{\"iterations\":%u,\"fmadd_ns_per_op\":%.6f,"
              "\"ld32_st32_ns_per_roundtrip\":%.6f,\"fma_sink\":%.17g,\"memory_sink\":%u}\n",
              N,ns(f0,f1)/N,ns(m0,m1)/N,value,unsigned(sum));
}
