#!/usr/bin/env python3
"""Attribute the extra simulation time of a four-character match to who spends it.

Input: two V8 .cpuprofile files of the web core with function names (the harness and build are
described in docs/FOUR_PLAYER_ATTRIBUTION.md), one of the two-player control and one of the
four-player match, each covering the same match frames. Optionally the un-profiled in-match
`sim_ms` mean of each workload, to turn shares into milliseconds (the profiler itself inflates
the time; shares are taken from the profile, milliseconds from runs without it).

Every sample is classified three independent ways, each by its stack, never by its leaf alone:

  zone   who the time is spent for: guest code, the CPU emulation around it (memory helpers,
         software FMA, entry bookkeeping), the emulated GPU (GX FIFO decode, entered from guest
         stores), HLE, host. Same rule as cpuprofile_split.py (first guest frame or host entry
         point from the leaf), except that host entry points are matched on the function's
         qualified name with its argument list removed: matching `gx::` on the whole demangled
         signature filed renderer functions taking a `gx::Frame&` as FIFO decode (the 10-point
         error of PR #119, found in PR #122).
  phase  which part of Melee's frame: the GObj update pass (HSD_GObj_80390CFC), the GObj render
         pass (HSD_GObj_80390FC0), the end-of-frame copy (HSD_VICopyXFBAsync), anything else.
  owner  whose GObj callback it is: the guest frame right after the innermost per-GObj iterator
         (HSD_GObj_80390ED0 in render, HSD_GObj_80390CFC in update), mapped to an entity class by
         its symbol name (fighter, stage, item, HUD, ...). The shadow pass is its own owner.
  kind   what the work is, decided from the leaf upwards by the first guest frame that names a
         system: animation, collision/hit, display lists and their matrices, bone matrices.

Only names are read; output is aggregates and function names.
"""
import argparse
import collections
import json
import re
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cpuprofile_split as cs  # noqa: E402

PHASES = [('update', 'HSD_GObj_80390CFC'), ('render', 'HSD_GObj_80390FC0'), ('xfb_copy', 'HSD_VICopyXFBAsync')]
RENDER_ITER = 'HSD_GObj_80390ED0'
UPDATE_ITER = 'HSD_GObj_80390CFC'

# Owner: the GObj callback's symbol. Ordered, first match wins.
OWNERS = [
    ('fighter', r'^(?:Fighter_|ft[A-Z]|ft_|ftCo|ftCommon|ftDrawCommon|ftLib|ftParts|ftAnim|ftColl|pl_)'),
    ('shadow', r'^(?:lbShadow|HSD_Shadow)'),
    ('item', r'^(?:Item_|it_|it[A-Z])'),
    ('stage', r'^(?:Ground_|gr[A-Z]|grDisplay|grLib|grZako|mpLib|mpColl)'),
    ('hud', r'^(?:if[A-Z]|NameTag|fn_802F|fn_8030)'),
    ('effect', r'^(?:ef[A-Z]|efLib|ps[A-Z]|Effect)'),
    ('camera', r'^(?:Camera_|fn_8002F360|fn_8003)'),
]
OWNERS_C = [(k, re.compile(r)) for k, r in OWNERS]

# Kind: from the leaf up, the first guest frame matching. Generic math (PSMTX*, HSD_Mtx*) and
# libc are skipped so they land on the system that called them.
KINDS = [
    ('animation', r'^(?:ftAnim|HSD_JObjAnim|HSD_AObj|HSD_FObj|HSD_TObjAnim|HSD_MObjAnim|HSD_DObjAnim|HSD_LObjAnim|HSD_CObjAnim|lbAnim|HSD_RObjAnim|HSD_JObjAddAnim|HSD_ForeachAnim)'),
    ('collision_hit', r'(?:Coll|^mpLib|^mpColl|^lbColl|Hit|Hurt|^ftColl)'),
    ('display', r'^(?:HSD_JObjDisp|HSD_DObjDisp|HSD_PObjDisp|HSD_PObj_|HSD_MObj|HSD_TObj|HSD_Setup|HSD_State|HSD_LObjSetup|SetupEnvelopeModelMtx|SetupRigidModelMtx|SetupSharedVtxModelMtx|GX|__GX|ftDrawCommon|grDisplay|HSD_ShadowStartRender)'),
    ('bone_matrices', r'^(?:HSD_JObjSetupMatrix|HSD_JObjMakeMatrix|HSD_JObj_SetupMatrix|lb_8000B|HSD_MtxSRT|HSD_JObjGetMtx)'),
]
KINDS_C = [(k, re.compile(r)) for k, r in KINDS]


def strip_args(name):
    """`ns::f(gx::Frame&, int) const` -> `ns::f`: the qualified name only, for host entry matching.

    The argument list is the balanced parenthesised group that ends the name (after removing a
    trailing cv/ref qualifier); `(anonymous namespace)` inside the qualified name is kept.
    """
    s = re.sub(r'(?:\s*(?:const|volatile|&&|&|noexcept))+$', '', name)
    if not s.endswith(')'):
        return name
    depth = 0
    for i in range(len(s) - 1, -1, -1):
        depth += {')': 1, '(': -1}.get(s[i], 0)
        if depth == 0:
            return s[:i] if i > 0 else name
    return name


def strip_templates(name):
    """`std::vector<gx::Vertex>::__append` -> `std::vector::__append`. A type named in a template
    argument says nothing about who runs the function; matching it is the same error as matching
    the argument list."""
    out, depth = [], 0
    for ch in name:
        if ch == '<' and not name.endswith('operator<'):
            depth += 1
        elif ch == '>' and depth:
            depth -= 1
        elif depth == 0:
            out.append(ch)
    return ''.join(out)


def zone_of(stack_stripped):
    for i, name in enumerate(stack_stripped):
        if cs.GUEST.search(name):
            if i == 0:
                return 'guest_body'
            for k, rx in cs.GUEST_LEAF_COMPILED:
                if rx.search(stack_stripped[0]):
                    return 'guest_' + k
            return 'guest_other_helper'
        for k, rx in cs.HOST_COMPILED:
            if rx.search(name):
                return k
    return 'outside_guest'


def owner_of(name):
    for k, rx in OWNERS_C:
        if rx.search(name):
            return k
    return 'other:' + name


class Profile:
    def __init__(self, path, frames, symbols):
        p = json.loads(Path(path).read_text())
        self.frames = frames
        self.nodes = {n['id']: n for n in p['nodes']}
        self.parent = {c: n['id'] for n in p['nodes'] for c in n.get('children', [])}
        raw = {n['callFrame']['functionName'] for n in p['nodes']}
        dem = cs.demangle(sorted(r for r in raw if r.startswith('_Z')))
        self.name = {}
        self.full = {}
        self.guest = {}
        for nid, n in self.nodes.items():
            fn = n['callFrame']['functionName']
            full = dem.get(fn, fn)
            self.full[nid] = full
            self.name[nid] = strip_templates(strip_args(full)) if full else '(anonymous)'
            m = cs.GUEST.search(fn)
            self.guest[nid] = symbols.get(m.group(1), 'f_' + m.group(1)) if m else None
        samples, deltas = p['samples'], p['timeDeltas']
        dur = [deltas[i + 1] for i in range(len(samples) - 1)]
        dur.append(statistics.median(dur) if dur else 0)
        self.samples = list(zip(samples, dur))
        self.total_us = sum(dur)

    def stack(self, leaf):
        out, nid = [], leaf
        while nid is not None:
            out.append(nid)
            nid = self.parent.get(nid)
        return out  # leaf first


def classify(prof, leaf):
    st = prof.stack(leaf)
    zone = zone_of([prof.name[n] for n in st])
    old, _ = cs.zone_of([prof.full[n] for n in st])
    chain = [prof.guest[n] for n in reversed(st) if prof.guest[n]]  # root first
    phase = 'other'
    for k, anchor in PHASES:
        if anchor in chain:
            phase = k
            break
    owner = 'none'
    for it in (RENDER_ITER, UPDATE_ITER):
        if it in chain:
            i = len(chain) - 1 - chain[::-1].index(it)
            owner = owner_of(chain[i + 1]) if i + 1 < len(chain) else 'iterator_itself'
            break
    if phase == 'render' and owner == 'none':
        # Render callbacks outside the per-GObj iterator, e.g. the shadow pass.
        i = chain.index('HSD_GObj_80390FC0')
        for name in chain[i + 1:]:
            o = owner_of(name)
            if not o.startswith('other:'):
                owner = o
                break
    kind = 'other_guest' if chain else 'no_guest_frame'
    for name in reversed(chain):  # leaf first
        hit = next((k for k, rx in KINDS_C if rx.search(name)), None)
        if hit:
            kind = hit
            break
    return zone, phase, owner, kind, chain, old


def analyse(prof):
    tables = {k: collections.Counter() for k in ('zone', 'phase', 'owner', 'kind', 'phase_owner', 'owner_kind', 'owner_zone', 'callback', 'leaf_self', 'zone_disagreement')}
    examples = collections.defaultdict(collections.Counter)  # zone -> leaf names, to check the classifier
    for leaf, d in prof.samples:
        zone, phase, owner, kind, chain, old = classify(prof, leaf)
        oclass = owner.split(':')[0]
        tables['zone'][zone] += d
        tables['phase'][phase] += d
        tables['owner'][owner if not owner.startswith('other:') else 'other'] += d
        tables['kind'][kind] += d
        tables['phase_owner'][f'{phase}/{oclass}'] += d
        tables['owner_kind'][f'{oclass}/{kind}'] += d
        tables['owner_zone'][f'{oclass}/{zone}'] += d
        if owner.startswith('other:'):
            tables['callback'][f'{phase}/{owner}'] += d
        # Callback-level detail for every owner: the frame after the iterator.
        for it in (RENDER_ITER, UPDATE_ITER):
            if it in chain:
                i = len(chain) - 1 - chain[::-1].index(it)
                if i + 1 < len(chain):
                    tables['callback'][f'{phase}/{chain[i + 1]}'] += d
                break
        leafname = prof.guest[leaf] or prof.name[leaf]
        tables['leaf_self'][leafname] += d
        examples[zone][leafname] += d
        # Classifier check: where the cpuprofile_split.py rule (whole signature) disagrees.
        new_coarse = 'guest' if zone.startswith('guest_') else zone
        if old != new_coarse:
            tables['zone_disagreement'][f'{old} -> {new_coarse}: {leafname}'] += d
    return tables, examples


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('two', type=Path)
    ap.add_argument('four', type=Path)
    ap.add_argument('--frames', type=int, required=True, help='match frames each profile covers')
    ap.add_argument('--sim-two', type=float, help='un-profiled in-match sim_ms mean, two-player')
    ap.add_argument('--sim-four', type=float, help='un-profiled in-match sim_ms mean, four-player')
    ap.add_argument('--symbols', type=Path,
                    default=Path(__file__).resolve().parents[2] / 'upstream/melee-unlocked/port/recomp/GALE01_symbols.txt')
    ap.add_argument('--top', type=int, default=25)
    a = ap.parse_args(argv)
    sym = cs.load_symbols(a.symbols)
    out = {'schema': 'melee-fourcore-attribution/1', 'frames': a.frames}
    res = {}
    for label, path, sim in (('two', a.two, a.sim_two), ('four', a.four, a.sim_four)):
        prof = Profile(path, a.frames, sym)
        tables, examples = analyse(prof)
        prof_ms = prof.total_us / 1000 / a.frames
        scale = (sim / prof_ms) if sim else 1.0  # shares onto un-profiled ms
        res[label] = (tables, prof.total_us, scale)
        out[label] = {'profile_ms_per_frame': round(prof_ms, 3), 'sim_ms_unprofiled': sim, 'samples': len(prof.samples),
                      'zone_examples': {z: [n for n, _ in c.most_common(8)] for z, c in examples.items()}}
    for t in res['two'][0]:
        rows = []
        keys = set(res['two'][0][t]) | set(res['four'][0][t])
        for k in keys:
            v2 = res['two'][0][t][k] / res['two'][1]
            v4 = res['four'][0][t][k] / res['four'][1]
            ms2 = v2 * res['two'][1] / 1000 / a.frames * res['two'][2]
            ms4 = v4 * res['four'][1] / 1000 / a.frames * res['four'][2]
            rows.append({'key': k, 'two_pct': round(100 * v2, 2), 'four_pct': round(100 * v4, 2),
                         'two_ms': round(ms2, 3), 'four_ms': round(ms4, 3), 'delta_ms': round(ms4 - ms2, 3),
                         'ratio': round(ms4 / ms2, 3) if ms2 > 0 else None})
        rows.sort(key=lambda r: -abs(r['delta_ms']))
        out[t] = rows[:a.top] if t in ('callback', 'leaf_self', 'owner_kind', 'owner_zone', 'zone_disagreement') else rows
    total_delta = sum(r['delta_ms'] for r in out['zone'])
    out['total_delta_ms'] = round(total_delta, 3)
    json.dump(out, sys.stdout, indent=1)
    print()


if __name__ == '__main__':
    main()
