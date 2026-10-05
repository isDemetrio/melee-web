#include "memory_counts.h"
#include <emscripten.h>
#include <cstdio>
extern "C" {
EMSCRIPTEN_KEEPALIVE void emulator_memory_begin() {
  using namespace memory_measure;
  for (auto& c : counters) c = 0;
  enabled = true;
}
EMSCRIPTEN_KEEPALIVE void emulator_memory_end() {
  using namespace memory_measure;
  enabled = false;
  std::printf("EMULATOR_MEMORY {");
  for (unsigned i = 0; i < COUNT; ++i)
    std::printf("%s\"%s\":%llu", i ? "," : "", names[i], (unsigned long long)counters[i]);
  std::printf("}\n");
}
}
