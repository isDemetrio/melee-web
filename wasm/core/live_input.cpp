// Browser-only host input adapter. The offline script path remains the default.
// SPDX-License-Identifier: GPL-2.0-or-later
#include "headless.h"
#include <emscripten/emscripten.h>

EM_JS(int, read_live_pad, (unsigned char* bytes), {
  const read = Module['livePad'];
  if (!read) return 0;
  const pad = read();
  HEAPU8.set(pad, bytes);
  return 1;
});

extern "C" EMSCRIPTEN_KEEPALIVE int melee_live_input_version() { return 1; }

namespace {
[[maybe_unused]] const bool installed = [] {
  host::live_input = [](host::PadState out[4]) {
    unsigned char bytes[12];
    if (!read_live_pad(bytes)) return false;
    for (int i = 0; i < 4; ++i) { out[i] = {}; out[i].err = -1; }
    auto& p = out[0];
    p.button = (uint16_t(bytes[0]) << 8) | bytes[1];
    p.stick_x = int8_t(bytes[2]); p.stick_y = int8_t(bytes[3]);
    p.sub_x = int8_t(bytes[4]); p.sub_y = int8_t(bytes[5]);
    p.trig_l = bytes[6]; p.trig_r = bytes[7];
    p.analog_a = bytes[8]; p.analog_b = bytes[9]; p.err = int8_t(bytes[10]);
    return true;
  };
  return true;
}();
}
