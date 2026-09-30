// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include "host.h"
namespace host {
extern std::string dol_path;
bool input_load_script(const char* path);
void input_mark_match_start();
}
