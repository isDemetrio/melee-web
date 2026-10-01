// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include "host.h"
namespace gx { struct Backend; }
namespace host {
// Renderer seam (docs/RENDERER_MAP.md priority 1). Null -- the default, and the only value the
// native reference and the Node module ever set -- keeps the FIFO decoder exactly headless. A
// backend receives one gx::Frame per XFB copy, holding the frame's EFB copies and nothing else:
// draws are not recorded yet. Recording reads BP registers only, never guest memory.
void gx_set_backend(gx::Backend* backend);
extern std::string dol_path;
// --sim-times: per-retrace simulation wall time. Empty means the option was not given.
extern std::string sim_times_path;
bool input_load_script(const char* path);
void input_mark_match_start();
}
