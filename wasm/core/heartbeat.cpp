// The page's heartbeat (web/src/spike/heartbeat.ts): the browser module only.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// host::retrace_heartbeat is called at the end of every retrace; this hands the retraces completed
// to Module.heartbeat, which the spike worker installs and which posts the page a beat at most every
// 500 ms. Nothing here reads or writes guest state, so the simulation and its trace are the same with
// or without it. A module whose page sets no Module.heartbeat does one property lookup per retrace.
#include "headless.h"
#include <cstdint>
#include <chrono>
#include <emscripten/emscripten.h>

namespace host {
extern uint32_t timing_retrace;
extern double timing_sim_ms, timing_csv_ms, timing_native_pre_ms, timing_native_roundtrip_ms;
extern uint32_t timing_roundtrip_retrace;
}

EM_JS(void, melee_heartbeat, (int retraces, int timing_retrace, double sim_ms, double csv_ms,
    double native_pre_ms, int previous_retrace, double native_roundtrip_ms), {
  const bridgeEntered = performance.now();
  const beat = Module["heartbeat"];
  if (beat) beat(retraces, timing_retrace, sim_ms, csv_ms,
      native_pre_ms, previous_retrace, native_roundtrip_ms, bridgeEntered);
  // Runs after the callback returns, including cycleEnd accounting and postMessage.
  const returned = Module["heartbeatReturned"];
  if (returned) returned(retraces);
  // Last JS observation before returning to native; no yield or synchronization added.
  const resuming = Module["heartbeatResuming"];
  if (resuming) resuming(retraces);
});

namespace {
[[maybe_unused]] const bool installed = [] {
  host::retrace_heartbeat = [](uint32_t retraces) { melee_heartbeat(int(retraces), int(host::timing_retrace),
      host::timing_sim_ms, host::timing_csv_ms, host::timing_native_pre_ms,
      int(host::timing_roundtrip_retrace), host::timing_native_roundtrip_ms); };
  return true;
}();
}  // namespace

// Startup-only calibration of the actual native clock path, including the WASM import.
extern "C" EMSCRIPTEN_KEEPALIVE double melee_residual_clock_cost_ns() {
  constexpr int reads = 100000;
  const double start = emscripten_get_now();
  for (int i = 0; i < reads; ++i) {
    volatile auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
    (void)stamp;
  }
  return (emscripten_get_now() - start) * 1e6 / reads;
}
