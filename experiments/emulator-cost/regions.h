// Measurement-only scopes. Included by instrument.py on the CI runner, never shipped.
#pragma once
#include <emscripten.h>
#include <cstdio>
namespace emulator_measure {
enum Region { MMIO_GX, MMIO_OTHER, FIFO, FIFO_APPEND, PARSE, DESC, VERTICES,
              RECORD, STATE_COPY, SNAPSHOT, COMMAND_APPEND, RENDERER, COUNT };
inline const char* names[] = {"mmio_gx", "mmio_other", "fifo", "fifo_append", "parse",
  "vertex_descriptor", "vertices", "record", "state_copy", "texture_snapshot",
  "command_append", "renderer_excluded"};
struct Stat { unsigned calls = 0; double inclusive = 0, exclusive = 0; };
inline Stat stats[COUNT];
inline bool enabled = false;
inline unsigned epoch = 0;
struct Scope;
inline Scope* current = nullptr;
struct Scope {
  Region region;
  bool active;
  unsigned generation;
  double start = 0, children = 0;
  Scope* parent = nullptr;
  explicit Scope(Region r) : region(r), active(enabled), generation(epoch) {
    if (!active) return;
    parent = current; current = this; start = emscripten_get_now();
  }
  ~Scope() {
    if (!active) return;
    const double elapsed = emscripten_get_now() - start;
    current = parent;
    if (!enabled || generation != epoch) return;
    if (parent && parent->generation == generation) parent->children += elapsed;
    auto& s = stats[region]; ++s.calls; s.inclusive += elapsed; s.exclusive += elapsed - children;
  }
};
}
