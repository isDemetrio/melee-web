#!/usr/bin/env python3
"""Split a V8 .cpuprofile of the core into guest code, emulator runtime and the rest.

Input: a profile written by the Node harness described in docs/CORE_COST_BROWSER.md, taken of
the web core built with function names (phase0-build.yml, input `profiling_funcs`). The profile
covers exactly the retraces given with --frames, so totals are also reported per frame.

Only names are read. Output is aggregates and function names (no game data). Every sample is
weighted by the time to the next sample; the last sample gets the median interval.

Self time goes to the function on top of the stack. A guest function is a translated one,
`f_XXXXXXXX(ppc::Context&, unsigned char*)` (port/recomp/recomp.py names them so); its self time
contains the code the compiler inlined into it -- memory helpers, enter(), backedge polls --
which a sampling profiler cannot separate. Everything else is classified by the first matching
rule in RULES; a function no rule matches is reported as `unclassified`, by name, never folded.
"""
import argparse
import collections
import json
import re
import statistics
import subprocess
import sys
from pathlib import Path

GUEST = re.compile(r'(?:^|\b)f_([0-9A-F]{8})\b')
# Ordered: first match wins. (category, regex over the demangled name or JS function name)
RULES = [
    ('guest_memory_slow', r'\bmmio_read|\bmmio_write|\blocked_cache\b|\bslowptr\b'),
    ('guest_dispatch', r'\bppc::call\b|\bppc::lookup|\bguest_registry|\bdispatch'),
    ('guest_interpreter', r'\bInterp\b|\binterp'),
    ('guest_events', r'\bloop_poll\b|\bhang_check\b|\bmtmsr\b|\bdeliver|\binterrupt|\bhost::.*(?:event|alarm|tick)'),
    ('guest_memory_helper', r'\bppc::(?:ld|st)(?:8|16|32|64)r?\b|\bmark_ram_write\b'),
    ('gx_backend_cpp', r'\bgxw::|WebGpuBackend|gx_webgpu|\bdraw_segment\b|\bsubmit_frame\b|\bupload_textures\b|texture_decode'),
    ('gx_backend_js', r'^gxw_|^__benchDraw$|^mocked$|^(?:createCommandEncoder|beginRenderPass|writeBuffer|setBindGroup|drawIndexed)$'),
    ('gx_decode', r'\bgx::|\bGX[A-Z_]|\bgx_|render_observer|RenderObserver|\bdrain_fifo\b|\brun_display_list\b|\bdecode_vertices\b|\bfifo'),
    ('hle', r'\bhle::|\baudio_core::|\bax::|\bgecko::|\bdsp'),
    ('host', r'\bhost::|\bheadless|\blcancel::|\bretrace\b|\bsim_time|\bheartbeat'),
    ('libc', r'^(?:memcpy|memmove|memset|__memcpy|__memset|emscripten_memcpy|strlen|malloc|free|dlmalloc|dlfree|operator new|operator delete|__cxa|std::__2::)'),
    ('js_runtime', r'^\((?:program|garbage collector|idle|root)\)$'),
]
COMPILED = [(k, re.compile(r)) for k, r in RULES]

# Zones: who the sample's time is spent for, decided by the stack rather than the leaf. Walking
# from the leaf towards the root, the first frame that is either a guest function or one of these
# host entry points decides. A guest store into the GX FIFO (st32 -> mmio_write -> gx_write ->
# parse_command) is therefore emulated-GPU time, not guest time, although every guest frame that
# led to it -- HSD_JObjDisp included -- has it in its inclusive time.
HOST_ENTRIES = [
    ('render_backend', r'\bsubmit_and_recycle\b|\bBackend::|\bgxw::|^gxw_|^wasm-to-js$'),
    ('gx_fifo_decode', r'\bgx_write\b|\bparse_command\b|\bgx::|\bfifo'),
    ('mmio_other', r'\bmmio_(?:read|write)'),
    ('hle', r'\bhle::|\baudio_core::|\bax::'),
    ('host_events', r'\bloop_poll\b|\bhang_check\b'),
    ('host_retrace', r'\bhost::retrace\b|\bheartbeat'),
]
HOST_COMPILED = [(k, re.compile(r)) for k, r in HOST_ENTRIES]
# Inside the guest zone, what the leaf is. The compiler-inlined part of each helper stays in
# `guest_body`; only out-of-line helpers can be seen.
GUEST_LEAF = [
    ('fp_emulation', r'^(?:fma|fmaf|normalize)$|\bppc::f(?:madd|msub|nmadd|nmsub|s|25|ctiw|res|rsqrte)\b|\bwasm_compat::f'),
    ('memory_helpers', r'\bppc::(?:ld|st)(?:8|16|32|64)r?\b|\bppc::psq_(?:load|store)\b|\bmark_ram_write\b|\bhost::(?:ptr|try_ptr|rd(?:8|16|32)|wr(?:8|16|32))\b|\bslowptr\b|\blocked_cache\b'),
    ('entry_bookkeeping', r'\bppc::(?:enter|trace_enter|backedge|hang_check|local_return)\b'),
    ('dispatch', r'\bppc::call\b|\blookup\b'),
    ('libc', r'^(?:memcpy|memmove|memset|memcmp|emscripten_builtin_\w+|__memcpy|strlen)$'),
]
GUEST_LEAF_COMPILED = [(k, re.compile(r)) for k, r in GUEST_LEAF]


def zone_of(stack):
    """stack: demangled names, leaf first. Returns (zone, guest_leaf_kind or None)."""
    for i, name in enumerate(stack):
        if GUEST.search(name):
            if i == 0:
                return 'guest', 'guest_body'
            leaf = stack[0]
            for k, rx in GUEST_LEAF_COMPILED:
                if rx.search(leaf):
                    return 'guest', k
            return 'guest', 'other_helper'
        for k, rx in HOST_COMPILED:
            if rx.search(name):
                return k, None
    return 'outside_guest', None


def demangle(names):
    names = list(names)
    if not names:
        return {}
    try:
        out = subprocess.run(['c++filt'], input='\n'.join(names), capture_output=True, text=True,
                             check=True).stdout.split('\n')
        return dict(zip(names, out))
    except (OSError, subprocess.CalledProcessError):
        return {n: n for n in names}


def load_symbols(path):
    sym = {}
    if path and path.exists():
        for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
            m = re.match(r'(\S+) = \.text:0x([0-9A-Fa-f]{8});', line)
            if m:
                sym[m.group(2).upper()] = m.group(1)
    return sym


def classify(name, url):
    if GUEST.search(name):
        return 'guest_code'
    for key, rx in COMPILED:
        if rx.search(name):
            return key
    if url and not url.startswith('wasm://') and name:
        return 'js_other'
    if re.match(r'^wasm-function\[\d+\]$', name):
        return 'unnamed_wasm'
    return 'unclassified'


def analyse(profile, frames, symbols, watch, top):
    nodes = {n['id']: n for n in profile['nodes']}
    parent = {}
    for n in profile['nodes']:
        for c in n.get('children', []):
            parent[c] = n['id']
    raw = {n['callFrame']['functionName'] for n in profile['nodes']}
    dem = demangle(sorted(r for r in raw if r.startswith('_Z')))

    def pretty(n):
        name = n['callFrame']['functionName']
        name = dem.get(name, name)
        m = GUEST.search(name)
        if m:
            return 'f_%s %s' % (m.group(1), symbols.get(m.group(1), '?'))
        return name or '(anonymous %s)' % n['callFrame']['url'][-40:]

    samples, deltas = profile['samples'], profile['timeDeltas']
    dur = [deltas[i + 1] for i in range(len(samples) - 1)]
    dur.append(statistics.median(dur) if dur else 0)
    total_us = sum(dur)

    cat = collections.Counter()
    self_t = collections.Counter()
    incl = collections.Counter()
    under_guest = collections.Counter()  # self category of samples with a guest frame below them
    watch_incl = collections.Counter()
    watch_guest = collections.Counter()
    zones = collections.Counter()
    guest_kinds = collections.Counter()
    other_helpers = collections.Counter()
    info = {}
    raw_name = lambda nid: dem.get(nodes[nid]['callFrame']['functionName'], nodes[nid]['callFrame']['functionName'])
    for s, d in zip(samples, dur):
        n = nodes[s]
        name = pretty(n)
        c = classify(dem.get(n['callFrame']['functionName'], n['callFrame']['functionName']),
                     n['callFrame']['url'])
        info[name] = c
        cat[c] += d
        self_t[name] += d
        seen = set()
        guest_below = False
        nid = s
        while nid is not None:
            nn = nodes[nid]
            pn = pretty(nn)
            if pn not in seen:
                seen.add(pn)
                incl[pn] += d
            if nid != s and GUEST.search(dem.get(nn['callFrame']['functionName'], nn['callFrame']['functionName'])):
                guest_below = True
            nid = parent.get(nid)
        if guest_below or c == 'guest_code':
            under_guest[c] += d
        stack = []
        nid = s
        while nid is not None:
            stack.append(raw_name(nid))
            nid = parent.get(nid)
        z, kind = zone_of(stack)
        zones[z] += d
        if kind:
            guest_kinds[kind] += d
            if kind == 'other_helper':
                other_helpers[name] += d
        for w in watch:
            if any(w == p.split(' ', 1)[-1] for p in seen):
                watch_incl[w] += d
                if z == 'guest':
                    watch_guest[w] += d

    per = lambda us: round(us / 1000 / frames, 3) if frames else None
    pct = lambda us: round(100 * us / total_us, 2) if total_us else None
    return {
        'schema': 'melee-cpuprofile-split/1',
        'frames': frames,
        'samples': len(samples),
        'window_ms': round(total_us / 1000, 1),
        'ms_per_frame': per(total_us),
        'median_interval_us': statistics.median(dur) if dur else None,
        'categories': {k: {'ms_per_frame': per(v), 'percent': pct(v)} for k, v in cat.most_common()},
        'with_a_guest_caller': {k: {'ms_per_frame': per(v), 'percent': pct(v)} for k, v in under_guest.most_common()},
        'zones': {k: {'ms_per_frame': per(v), 'percent': pct(v)} for k, v in zones.most_common()},
        'guest_zone_by_leaf': {k: {'ms_per_frame': per(v), 'percent': pct(v)} for k, v in guest_kinds.most_common()},
        'guest_zone_other_helpers': [{'name': k, 'percent': pct(v)} for k, v in other_helpers.most_common(top)],
        'watch_inclusive': {w: {'ms_per_frame': per(watch_incl[w]), 'percent': pct(watch_incl[w]),
                                'guest_zone_ms_per_frame': per(watch_guest[w]),
                                'guest_zone_percent': pct(watch_guest[w])} for w in watch},
        'top_self': [{'name': k, 'category': info.get(k), 'ms_per_frame': per(v), 'percent': pct(v)}
                     for k, v in self_t.most_common(top)],
        'top_inclusive': [{'name': k, 'ms_per_frame': per(v), 'percent': pct(v)} for k, v in incl.most_common(top)],
        'unclassified': [{'name': k, 'percent': pct(v)} for k, v in self_t.most_common()
                         if info.get(k) in ('unclassified', 'unnamed_wasm')][:top],
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('profile', type=Path)
    ap.add_argument('--frames', type=int, required=True, help='retraces the profile covers')
    ap.add_argument('--symbols', type=Path,
                    default=Path(__file__).resolve().parents[2] / 'upstream/melee-unlocked/port/recomp/GALE01_symbols.txt')
    ap.add_argument('--watch', action='append', default=[],
                    help='guest symbol whose inclusive time to report (repeatable)')
    ap.add_argument('--top', type=int, default=40)
    a = ap.parse_args(argv)
    out = analyse(json.loads(a.profile.read_text()), a.frames, load_symbols(a.symbols), a.watch, a.top)
    json.dump(out, sys.stdout, indent=1)
    print()


if __name__ == '__main__':
    main()
