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

EM_JS(void, melee_heartbeat, (int retraces), {
  const beat = Module["heartbeat"];
  if (beat) beat(retraces);
});

namespace {
[[maybe_unused]] const bool installed = [] {
  host::retrace_heartbeat = [](uint32_t retraces) { melee_heartbeat(int(retraces)); };
  return true;
}();
}  // namespace
