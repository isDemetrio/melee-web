#!/usr/bin/env python3
"""Expose mark_ram_write as a sampling boundary; count its paths separately.

Actions-only, after the normal port patches, on an otherwise uninstrumented core.
This is a diagnostic perturbation, not an optimization or production timing.
"""
import os
from pathlib import Path


def instrument(root):
    p = root / 'upstream/melee-unlocked/port/runtime/ppc/ppc.h'
    text = p.read_text()
    first = text.index('inline void mark_ram_write(uint32_t ea, uint32_t bytes) {')
    last = text.index('\ninline uint64_t watch_ram_range', first)
    old = text[first:last]
    new = old
    changes = [
        ('inline void mark_ram_write', '__attribute__((noinline)) inline void mark_ram_write'),
        ('  if (!bytes) return;', '''  memory_measure::count(memory_measure::CALLS);
  if (!bytes) { memory_measure::count(memory_measure::ZERO_BYTES); return; }'''),
        ('  if (off >= RAM_SIZE || bytes > RAM_SIZE - off) return;', '''  if (off >= RAM_SIZE || bytes > RAM_SIZE - off) {
    memory_measure::count(memory_measure::OUT_OF_RANGE); return;
  }
  if (memory_measure::enabled) ++memory_measure::counters[
    bytes == 1 ? memory_measure::BYTES_1 : bytes == 2 ? memory_measure::BYTES_2 :
    bytes == 4 ? memory_measure::BYTES_4 : bytes == 8 ? memory_measure::BYTES_8 : memory_measure::BYTES_OTHER];'''),
        ('  for (uint32_t block = first; block <= last; ++block)', '''  memory_measure::count(first == last ? memory_measure::SINGLE_BLOCK : memory_measure::MULTI_BLOCK);
  if (memory_measure::enabled) memory_measure::counters[memory_measure::BLOCK_CHECKS] += last - first + 1;
  for (uint32_t block = first; block <= last; ++block)'''),
        ('      g_ram_versions[block].fetch_add(1, std::memory_order_relaxed);', '''      memory_measure::count(memory_measure::WATCHED_HITS);
      g_ram_versions[block].fetch_add(1, std::memory_order_relaxed);'''),
    ]
    for before, after in changes:
        if new.count(before) != 1:
            raise ValueError(f'expected one memory probe anchor: {before!r}')
        new = new.replace(before, after)
    header = (root / 'experiments/emulator-cost/memory_counts.h').resolve()
    p.write_text(f'#include "{header}"\n' + text[:first] + new + text[last:])
    with (root / 'wasm/core/CMakeLists.txt').open('a') as f:
        f.write('\ntarget_sources(melee_core_web PRIVATE "${REPO}/experiments/emulator-cost/memory_counts.cpp")\n')


if __name__ == '__main__':
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise SystemExit('measurement instrumentation is Actions-only')
    instrument(Path(__file__).resolve().parents[2])
