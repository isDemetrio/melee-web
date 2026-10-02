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
bool input_load_script(const char* path);
void input_mark_match_start();
}
