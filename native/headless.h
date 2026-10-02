// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include "host.h"
namespace gx { struct Backend; }
namespace host {
// Renderer seam: the Q10(a) spike always runs the real GX decoder, including draw and
// texture capture. Null (native/Node default) discards completed frames. The web backend
// receives complete gx::Frames; attaching/detaching must not reset GX register state.
void gx_set_backend(gx::Backend* backend);
extern std::string dol_path;
// --sim-times: per-retrace simulation wall time. Empty means the option was not given.
extern std::string sim_times_path;
// Called at the end of every retrace with the retraces completed; null (the default) does
// nothing. It must only observe: the web core uses it for the page's heartbeat
// (wasm/core/heartbeat.cpp), which reads no guest state.
extern void (*retrace_heartbeat)(uint32_t retraces);
// Optional live host input. Null keeps the offline oracle on its original script path.
extern bool (*live_input)(PadState out[4]);
bool input_load_script(const char* path);
void input_mark_match_start();
}
