// The page's heartbeat (web/src/spike/heartbeat.ts): the browser module only.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// host::retrace_heartbeat is called at the end of every retrace; this hands the retraces completed
// to Module.heartbeat, which the spike worker installs and which posts the page a beat at most every
// 500 ms. Nothing here reads or writes guest state, so the simulation and its trace are the same with
// or without it. A module whose page sets no Module.heartbeat does one property lookup per retrace.
#include "headless.h"
#include <cstdint>
#include <emscripten/emscripten.h>

namespace host {
extern uint32_t timing_retrace;
extern double timing_sim_ms, timing_csv_ms;
}

EM_JS(void, melee_heartbeat, (int retraces, int timing_retrace, double sim_ms, double csv_ms), {
  const beat = Module["heartbeat"];
  if (beat) beat(retraces, timing_retrace, sim_ms, csv_ms);
  // Runs after the callback returns, including cycleEnd accounting and postMessage.
  const returned = Module["heartbeatReturned"];
  if (returned) returned(retraces);
});

namespace {
[[maybe_unused]] const bool installed = [] {
  host::retrace_heartbeat = [](uint32_t retraces) { melee_heartbeat(int(retraces), int(host::timing_retrace),
      host::timing_sim_ms, host::timing_csv_ms); };
  return true;
}();
}  // namespace
