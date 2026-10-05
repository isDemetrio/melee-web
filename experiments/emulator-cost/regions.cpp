#include "regions.h"
extern "C" {
EMSCRIPTEN_KEEPALIVE void emulator_regions_begin() {
  using namespace emulator_measure;
  for (auto& s : stats) s = {};
  ++epoch; enabled = true;
}
EMSCRIPTEN_KEEPALIVE void emulator_regions_end() {
  using namespace emulator_measure;
  enabled = false;
  std::printf("EMULATOR_REGIONS {\"regions\":[");
  for (unsigned i = 0; i < COUNT; ++i) {
    const auto& s = stats[i];
    std::printf("%s{\"name\":\"%s\",\"calls\":%u,\"inclusive_ms\":%.6f,\"exclusive_ms\":%.6f}",
      i ? "," : "", names[i], s.calls, s.inclusive, s.exclusive);
  }
  std::printf("]}\n");
}
}
