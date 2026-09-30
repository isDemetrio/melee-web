// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include "host.h"
namespace host {
extern std::string dol_path;
// --sim-times: per-retrace simulation wall time. Empty means the option was not given.
extern std::string sim_times_path;
bool input_load_script(const char* path);
void input_mark_match_start();
}
