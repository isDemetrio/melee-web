// Offline diagnostic storage; no authored animation sampling or subframe solver.
// SPDX-License-Identifier: GPL-2.0-or-later
#include "authored_pose.h"

namespace gx {
// Same counter storage as authored_pose.cpp, which is not in the offline source set.
// GX and RenderObserver only increment these counters; capture decisions do not
// depend on their values. Keep actual counts without pulling in the desktop solver.
AuthoredStats& authored_stats() {
  static AuthoredStats stats;
  return stats;
}
}
