// Linux entry point following port/app/main.cpp's translated-guest boot path.
// SPDX-License-Identifier: GPL-2.0-or-later
#include "headless.h"
#include "gecko_data.h"
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <stdexcept>
#include <string>

static uint64_t number(const std::string& text) {
  if (text.empty() || text[0] == '-') throw std::runtime_error("expected a nonnegative integer");
  size_t used = 0;
  auto n = std::stoull(text, &used, 0);
  if (used != text.size()) throw std::runtime_error("invalid integer: " + text);
  return n;
}
static void usage() {
  std::puts("melee_core_headless --iso PATH [--dol PATH] --frames N [--script PATH]\n"
            "  [--headless] [--fast] [--time-base N] [--volume 0]\n"
            "  [--state-trace PATH|-] [--state-digest PATH] [--card-dir PATH]\n"
            "  --check-dol PATH validates the DOL without claiming to run the game.\n"
            "Requires a --no-slippi translation. CSV trace defaults to stdout.");
}
namespace hle { void dvd_shutdown(); }
int main(int argc, char** argv) {
  struct DvdShutdown { ~DvdShutdown() { hle::dvd_shutdown(); } } shutdown;
  try {
    auto& o = host::options;
    o.state_trace = "-";
    bool check_dol = false;
    for (int i=1; i<argc; ++i) {
      const std::string a = argv[i];
      auto next = [&]() -> std::string {
        if (++i >= argc) throw std::runtime_error("missing value for " + a);
        return argv[i];
      };
      if (a == "--help") { usage(); return 0; }
      else if (a == "--iso") o.iso = next();
      else if (a == "--dol") host::dol_path = next();
      else if (a == "--check-dol") { host::dol_path = next(); check_dol = true; }
      else if (a == "--frames") {
        const auto n = number(next());
        if (!n || n > std::numeric_limits<uint32_t>::max()) throw std::runtime_error("frames must be 1..4294967295");
        o.frames = uint32_t(n);
      }
      else if (a == "--time-base") o.time_base = number(next());
      else if (a == "--headless") {} // No window or renderer is ever created.
      else if (a == "--fast") o.fast = true;
      else if (a == "--state-trace") o.state_trace = next();
      else if (a == "--state-digest") o.state_digest = next();
      else if (a == "--card-dir") o.card_dir = next();
      else if (a == "--volume") {
        if (number(next()) != 0) throw std::runtime_error("headless output supports only --volume 0");
      }
      else if (a == "--script") {
        const auto path = next();
        if (!host::input_load_script(path.c_str())) throw std::runtime_error("cannot load script (or unsupported @release)");
      }
      else if (a == "--log-file") {
        const auto path = next();
        if (!std::freopen(path.c_str(), "w", stderr)) throw std::runtime_error("cannot open log file");
      }
      // Accepted by validate_native.py's headless invocation; those services do not exist here.
      else if (a == "--user-dir" || a == "--shader-cache" || a == "--replay-dir") { (void)next(); }
      else if (a == "--hidden" || a == "--threaded-renderer" || a == "--frame-mode" || a == "--fps")
        throw std::runtime_error("renderer-isolation modes are unavailable in the headless reference");
      else throw std::runtime_error("unknown option: " + a);
    }
    if (check_dol) {
      if (!host::disc_has_vanilla_dol()) throw std::runtime_error("DOL is not retail NTSC 1.02");
      std::puts("DOL SHA-1 verified; no simulation was run.");
      return 0;
    }
    if (o.iso.empty() || !o.frames) throw std::runtime_error("--iso and positive --frames required; a DOL alone has no game assets/FST");
    if (o.state_trace == o.state_digest && !o.state_digest.empty()) throw std::runtime_error("trace and digest must use different paths");
    // TODO(portability): default recomp.py output needs a real Slippi EXI port.
    if (gecko::codehandler_bin_size || gecko::slippi_gct_size)
      throw std::runtime_error("TODO(portability): regenerate with --no-slippi; default Slippi translation unsupported");
    if (!host::disc_open(o.iso)) throw std::runtime_error("cannot open ISO " + o.iso);
    // Replaces window, D3D backend, cosmetic setup and audio-device creation. Guest audio
    // processing remains in hle_stubs/AX; FIFO completion remains in headless_fifo.cpp.
    ppc::init_dispatch();
    ppc::add_entry_hook(0x8016D800u, [](ppc::Context&) { host::input_mark_match_start(); });
    host::boot_setup();
    try {
      ppc::call(*host::cpu, host::ram, 0x8000522Cu); // same __start as app/main.cpp
    } catch (const ExitRequested& stop) {
      if (stop.code) return stop.code;
    } catch (const LoadContextUnwind&) {
      throw std::runtime_error("OSLoadContext reached top level before frame limit");
    }
    if (host::retrace_count() != o.frames) throw std::runtime_error("guest stopped before requested checkpoints");
    host::log_flush();
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "FATAL: %s\n", e.what());
    return 1;
  }
}
