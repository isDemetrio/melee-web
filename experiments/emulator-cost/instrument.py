#!/usr/bin/env python3
"""Apply measurement-only scopes on the Actions runner, after the normal patch series.

No guest code is rewritten. Each source anchor must occur exactly once. This is
not an optimization: clocks and scope bookkeeping perturb the measured regions.
"""
import os
from pathlib import Path


def instrument(root):
    header = (root / 'experiments/emulator-cost/regions.h').resolve()
    def edit(relative, changes):
        p = root / relative
        text = p.read_text()
        for old, new in changes:
            if text.count(old) != 1:
                raise ValueError(f'{relative}: expected exactly one {old[:100]!r}')
            text = text.replace(old, new)
        p.write_text(f'#include "{header}"\n' + text)

    def entry(signature, region):
        return signature, signature + f'\n  emulator_measure::Scope measure_scope(emulator_measure::{region});'

    def block(text, region):
        return text, '{ emulator_measure::Scope measure_block(emulator_measure::' + region + ');\n' + text + '\n}'

    edit('upstream/melee-unlocked/port/runtime/gx/gx_core.cpp', [
        entry('void write_fifo(uint32_t value, int bytes) {', 'FIFO'),
        block('  const size_t at = g_buf.size();\n  g_buf.resize(at + (size_t)bytes);   // one size update per write instead of a push_back per byte\n  for (int i = 0; i < bytes; ++i) g_buf[at + i] = (uint8_t)(value >> (8 * (bytes - 1 - i)));', 'FIFO_APPEND'),
        entry('size_t parse_command(const uint8_t* d, size_t len) {', 'PARSE'),
        entry('VertexDesc build_desc(uint32_t fmt) {', 'DESC'),
        entry('uint32_t decode_vertices(const VertexDesc& d, const uint8_t* src, uint32_t count, uint32_t fmt) {', 'VERTICES'),
        entry('void record_draw(uint32_t primitive, uint32_t first, uint32_t count, uint32_t components) {', 'RECORD'),
        entry('void snapshot_textures(DrawCall& dc) {', 'SNAPSHOT'),
        ('  dc.bp = g_bp;', '  { emulator_measure::Scope measure_copy(emulator_measure::STATE_COPY);\n  dc.bp = g_bp;'),
        ('  snapshot_textures(dc);', '  }\n  snapshot_textures(dc);'),
        block('  g_frame.draws.push_back(std::move(dc));\n  g_frame.segments.push_back({first, count, primitive});\n  g_frame.commands.push_back({FrameCommand::Draw, (uint32_t)g_frame.draws.size() - 1});', 'COMMAND_APPEND'),
        block('      g_frame.segments.push_back({first, count, primitive});', 'COMMAND_APPEND'),
    ])
    edit('native/headless_host.cpp', [
        entry('void mmio_write(uint32_t addr, uint32_t value, int bytes) {',
              'Region((addr & 0xFFFFC000u) == 0xCC008000u ? emulator_measure::MMIO_GX : emulator_measure::MMIO_OTHER)'),
    ])
    edit('native/real_fifo.cpp', [
        entry('  void submit_and_recycle(gx::Frame& frame) override {', 'RENDERER'),
    ])
    cmake = root / 'wasm/core/CMakeLists.txt'
    with cmake.open('a') as f:
        f.write('\ntarget_sources(melee_core_web PRIVATE "${REPO}/experiments/emulator-cost/regions.cpp")\n')


if __name__ == '__main__':
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise SystemExit('measurement instrumentation is Actions-only')
    instrument(Path(__file__).resolve().parents[2])
