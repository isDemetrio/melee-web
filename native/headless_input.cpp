// Script input adapted from pinned port/runtime/host/window.cpp.
// SPDX-License-Identifier: GPL-2.0-or-later
#include "headless.h"
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
namespace host {
enum {
 PAD_LEFT=1, PAD_RIGHT=2, PAD_DOWN=4, PAD_UP=8, PAD_Z=0x10, PAD_R=0x20, PAD_L=0x40,
 PAD_A=0x100, PAD_B=0x200, PAD_X=0x400, PAD_Y=0x800, PAD_START=0x1000
};
namespace {
struct ScriptEntry {
  uint32_t frame;
  uint16_t buttons;
  int8_t sx, sy, cx, cy;
  uint8_t tl, tr;
  int port;
  bool relative = false;
  bool scene_match_relative = false;
  bool match_retrace_relative = false;
};
std::vector<ScriptEntry> g_script;
uint32_t g_script_ports = 1;
// `@match` makes later entries relative to the retrace at which an online match reached frame 1
// (they stay silent until then); `@loop N` repeats the relative section every N frames.
static bool g_script_relative_section = false;
static uint32_t g_script_loop = 0;
static std::atomic<uint32_t> g_match_start_retrace{0};
// `@scene <major>[:<minor>]` starts a menu-relative section at the first matching scene. A later
// `@match` in the same script switches subsequent entries to match-frame-relative timing, leaving
// the menu entries on scene retraces and keeping in-match inputs silent until frame 1.
static bool g_script_has_scene_wait = false;
static bool g_script_scene_match_relative = false;
static uint32_t g_scene_wait_major = 0, g_scene_wait_minor = 0;
static bool g_scene_wait_has_minor = false;
static std::atomic<uint32_t> g_scene_start_retrace{0};   // 0 = not observed yet
// `@matchrt` (after `@scene`): later entries count retraces from the start of each match instead
// of match frames, so they keep advancing while the game is paused (the match frame stops there).
// A match frame lower than the last one seen marks a new match and restarts the count.
static bool g_script_match_retrace = false;
static uint32_t g_match_rt_start = 0, g_match_rt_last = 0;

}
bool input_load_script(const char* path) {
  FILE* f = fopen(path, "r");
  if (!f) return false;
  g_script.clear();
  g_script_ports = 1;
  g_script_relative_section = false;
  g_script_loop = 0;
  g_match_start_retrace.store(0);
  g_script_has_scene_wait = false;
  g_script_scene_match_relative = false;
  g_script_match_retrace = false;
  g_scene_wait_major = g_scene_wait_minor = 0;
  g_scene_wait_has_minor = false;
  g_scene_start_retrace.store(0);
  g_match_rt_start = g_match_rt_last = 0;
  char line[256];
  while (fgets(line, sizeof line, f)) {
    ScriptEntry e{};
    char* p = line;
    if (*p == '#' || *p == '\n' || *p == '\r') continue;
    // `@release N`: N retraces after a match is first seen in progress, the script ends and the
    // real controllers drive every port (a scripted boot into a match, then a person plays).
    if (!strncmp(p, "@release", 8)) { fclose(f); return false; } // No physical controller to release to.
    if (!strncmp(p, "@matchrt", 8)) {
      g_script_relative_section = true;
      g_script_scene_match_relative = false;
      g_script_match_retrace = g_script_has_scene_wait;
      continue;
    }
    if (!strncmp(p, "@match", 6)) {
      g_script_relative_section = true;
      g_script_scene_match_relative = g_script_has_scene_wait;
      g_script_match_retrace = false;
      continue;
    }
    if (!strncmp(p, "@loop", 5)) { g_script_loop = (uint32_t)strtoul(p + 5, nullptr, 10); continue; }
    if (!strncmp(p, "@scene", 6)) {
      char* q = p + 6;
      while (*q == ' ' || *q == '\t') ++q;
      g_scene_wait_major = (uint32_t)strtoul(q, &q, 0);
      g_scene_wait_has_minor = (*q == ':');
      if (g_scene_wait_has_minor) g_scene_wait_minor = (uint32_t)strtoul(q + 1, nullptr, 0);
      g_script_has_scene_wait = true;
      g_script_scene_match_relative = false;
      g_script_match_retrace = false;
      g_script_relative_section = true;
      continue;
    }
    e.relative = g_script_relative_section;
    e.scene_match_relative = g_script_scene_match_relative;
    e.match_retrace_relative = g_script_match_retrace;
    e.frame = (uint32_t)strtoul(p, &p, 10);
    while (*p) {
      while (*p == ' ' || *p == '\t') ++p;
      if (!*p || *p == '\n' || *p == '\r' || *p == '#') break;
      char tok[32]; int n = 0;
      while (*p && *p != ' ' && *p != '+' && *p != '\n' && *p != '\r' && n < 31) tok[n++] = *p++;
      tok[n] = 0;
      if (*p == '+') ++p;
      if (!strcmp(tok, "A")) e.buttons |= PAD_A; else if (!strcmp(tok, "B")) e.buttons |= PAD_B;
      else if (!strcmp(tok, "X")) e.buttons |= PAD_X; else if (!strcmp(tok, "Y")) e.buttons |= PAD_Y;
      else if (!strcmp(tok, "Z")) e.buttons |= PAD_Z; else if (!strcmp(tok, "L")) e.buttons |= PAD_L;
      else if (!strcmp(tok, "R")) e.buttons |= PAD_R; else if (!strcmp(tok, "START")) e.buttons |= PAD_START;
      else if (!strncmp(tok, "l=", 2)) e.tl = (uint8_t)std::min(255, std::max(0, atoi(tok + 2)));
      else if (!strncmp(tok, "r=", 2)) e.tr = (uint8_t)std::min(255, std::max(0, atoi(tok + 2)));
      else if (!strcmp(tok, "DU")) e.buttons |= PAD_UP; else if (!strcmp(tok, "DD")) e.buttons |= PAD_DOWN;
      else if (!strcmp(tok, "DL")) e.buttons |= PAD_LEFT; else if (!strcmp(tok, "DR")) e.buttons |= PAD_RIGHT;
      else if (!strncmp(tok, "sx=", 3)) e.sx = (int8_t)atoi(tok + 3); else if (!strncmp(tok, "sy=", 3)) e.sy = (int8_t)atoi(tok + 3);
      else if (!strncmp(tok, "cx=", 3)) e.cx = (int8_t)atoi(tok + 3); else if (!strncmp(tok, "cy=", 3)) e.cy = (int8_t)atoi(tok + 3);
      else if (!strncmp(tok, "p=", 2)) { e.port = atoi(tok + 2) - 1; if (e.port < 0 || e.port > 3) e.port = 0; g_script_ports |= 1u << e.port; }
    }
    g_script.push_back(e);
  }
  fclose(f);
  return !g_script.empty();
}
void input_mark_match_start() { if (!g_match_start_retrace.load()) g_match_start_retrace.store(retrace_count()); }
bool (*live_input)(PadState out[4]) = nullptr;
void input_poll(PadState out[4]) {
  if (live_input && live_input(out)) return;
  // Replaces keyboard/USB polling: unmentioned ports are disconnected, port 1 neutral.
  for (int i=0; i<4; ++i) { out[i] = {}; out[i].err = i ? -1 : 0; }
  if (!g_script.empty()) {
    // Scripts drive port 1 by default; entries with p=N drive port N (a port with any entry counts as plugged in).
    uint32_t frame = retrace_count();
    // @scene takes over the same "relative section" that @match uses, but starts counting from
    // the retrace where the requested mode/scene was first observed instead of an online match
    // reaching frame 1. Checked every poll (once per retrace) so the wait is not sensitive to
    // when input_poll happens to be called relative to the scene actually changing.
    uint32_t match_frame = 0;
    if (g_script_has_scene_wait) {
      uint32_t major, minor;
      current_scene(&major, &minor, &match_frame);
      if (!g_scene_start_retrace.load() &&
          major == g_scene_wait_major &&
          (!g_scene_wait_has_minor || minor == g_scene_wait_minor))
        g_scene_start_retrace.store(frame);
    }
    uint32_t start = g_script_has_scene_wait ? g_scene_start_retrace.load() : g_match_start_retrace.load();
    bool use_match_frame = g_script_has_scene_wait && start && match_frame != 0;
    if (match_frame == 0) {
      g_match_rt_start = 0;
    } else if (!g_match_rt_start || match_frame < g_match_rt_last) {
      g_match_rt_start = frame;
    }
    g_match_rt_last = match_frame;
    const uint32_t match_rt = g_match_rt_start ? frame - g_match_rt_start : 0;
    bool in_section = start && frame >= start;
    uint32_t scene_rel = in_section ? frame - start : 0;
    uint32_t rel = use_match_frame ? match_frame : (in_section ? frame - start : 0);
    if (in_section && g_script_loop && (!g_script_has_scene_wait || use_match_frame)) rel %= g_script_loop;
    for (int port = 0; port < 4; ++port) {
      if (port && !(g_script_ports & (1u << port))) continue;
      out[port].err = 0;
      const ScriptEntry* cur = nullptr;
      for (const ScriptEntry& e : g_script) {
        if (e.port != port) continue;
        if (e.relative) {
          if (e.match_retrace_relative) {
            if (g_match_rt_start && e.frame <= match_rt) cur = &e;
          } else if (e.scene_match_relative) {
            if (use_match_frame && e.frame <= rel) cur = &e;
          } else if (g_script_has_scene_wait) {
            if (in_section && e.frame <= scene_rel) cur = &e;
          } else if (in_section && e.frame <= rel) {
            cur = &e;
          }
        } else if (!in_section && e.frame <= frame) cur = &e;
      }
      if (cur) {
        PadState& q = out[port];
        q.button = cur->buttons; q.stick_x = cur->sx; q.stick_y = cur->sy; q.sub_x = cur->cx; q.sub_y = cur->cy;
        // A digital L/R press on hardware bottoms the trigger out, so mirror that when the script
        // did not ask for a specific analog value (light shield needs the explicit l=/r= token).
        q.trig_l = cur->tl ? cur->tl : (uint8_t)((cur->buttons & PAD_L) ? 255 : 0);
        q.trig_r = cur->tr ? cur->tr : (uint8_t)((cur->buttons & PAD_R) ? 255 : 0);
      }
    }
  }
}
} // namespace host
