#!/usr/bin/env python3
"""The Phase 0 go/no-go, made mechanical: read the device JSONs, check them, print the verdict.

`docs/PHASE0_DEVICE_PLAN.md` sections 5 and 6 are the authority here: section 5 is the list of
checks (C1-C8) that decide whether a JSON is evidence at all, and section 6 is the criterion --
the specification's thresholds applied to the worst of three repeats, with the clock's own
resolution `q` subtracted in the unfavourable direction, so a verdict only stands if it survives
moving the numbers by `q`.

Why this tool exists rather than a hand calculation: `docs/PHASE0_DEVICE_PLAN.md` says so
("Fino ad allora i conti della sezione 6 si fanno a mano"), and the manual version has three
failure modes this one does not. It recomputes the statistics with `scripts/phase0/frame_stats.py`
and re-compares the checkpoint trace with `scripts/phase0/compare_checkpoints.py` instead of
trusting the JSON's own `stats_in_match`; it refuses a JSON that fails C1-C4, C6 or C8 rather than
averaging it in; and it never relaxes a threshold to produce a verdict.

The rule that matters most: a trace that differs from the native reference is **NO-GO**, whatever
the timings say. "Unexplained" is not machine-checkable, so every difference counts, and only the
operator can record an explanation next to this tool's output, never inside it.

Usage (see `docs/PHASE0_NEXT.md` S9 for the real invocation):

    python3 scripts/phase0/go_no_go.py \\
        --reference "$D/runs/native-1/trace.csv" --reference-commit "$SHA" \\
        --phone /home/hermes/incoming/phase0/devices/iphone-safari/*.json \\
        --node-trace "$D/runs/wasm-node-1/trace.csv" "$D/runs/wasm-node-2/trace.csv"

A class (`--desktop`, `--phone`) is either absent -- nothing was measured on it, and its
thresholds are then vacuous -- or measured with at least `MIN_REPEATS` runs; one or two runs of a
class are an input error, not a verdict. Exit codes: 0 GO, 1 NO-GO, 2 input error, 3 desktop only,
4 no verdict (the specification does not cover the band, or the clock/heat makes it undecidable).
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sys
import tempfile

# --- The thresholds, named. Section 6 of docs/PHASE0_DEVICE_PLAN.md and S8 of docs/PHASE0_NEXT.md.
PHONE_MEAN_GO = 3.0
PHONE_P99_GO = 6.0
PHONE_MEAN_NOGO = 6.0
PHONE_P99_NOGO = 12.0
DESKTOP_MEAN_GO = 1.5
DESKTOP_MEAN_NOGO = 4.0
MIN_REPEATS = 3
MIN_IN_MATCH_ROWS = 700
MAX_TIMER_RESOLUTION_MS = 0.1
# C7 and C8's stability thresholds: chosen here, not by the specification, and named so that a
# later session can see that they were a choice.
WARMUP_TOLERANCE = 0.15
SPREAD_TOLERANCE = 0.15
# A `max_ms` in the seconds is a tab that was suspended, not a slow frame.
MAX_PLAUSIBLE_MS = 1000.0
# The declared statistics are rounded to two decimals by the page, so equality is within that.
STATS_TOLERANCE_MS = 0.01

EXPECTED_SCHEMA = 'melee-spike-result/1'
EXPECTED_FRAMES = 2400
SHORT_PROOF_FRAMES = 60
EXPECTED_ISO_BYTES = 1459978240
EXPECTED_IN_MATCH_ROWS = 762
EXPECTED_RETRACES = 2400
EXPECTED_FINAL_SCENE = 'final scene: mode=2 state=2 match_frame=762 (retraces=2400)'
FINAL_SCENE_PREFIX = 'final scene: mode=2'
# The trace of the native reference this repository has been comparing against since S5. A trace
# that is identical to the reference cell by cell hashes to this; the hash is recorded for every
# run, and a run whose hash differs while its cells do not is annotated rather than refused (a
# different line ending is not a different simulation).
EXPECTED_TRACE_SHA1 = 'c79c53b9cdf81426fa0277e7497a69e55bc5f571'
# S11: a verdict measured on the `-O1` core is provisional unless it is a GO.
PROVISIONAL_OPTS = ('-O1',)

VERDICT_EXIT_CODES = {'GO': 0, 'NO-GO': 1, 'INPUT-ERROR': 2, 'DESKTOP-ONLY': 3, 'REVIEW': 4,
                      'NOT-DECIDABLE': 4}


class InputError(Exception):
    """A run or an invocation that cannot be turned into a verdict at all (exit code 2)."""


def load_sibling(name: str):
    """Import a module from this file's own directory, so the tests can load it the same way."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), f'{name}.py')
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:  # pragma: no cover - a missing sibling is fatal
        raise InputError(f'{path} cannot be loaded')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


frame_stats = load_sibling('frame_stats')
compare_checkpoints = load_sibling('compare_checkpoints')


def sha1_of(text: str) -> str:
    return hashlib.sha1(text.encode('utf-8')).hexdigest()


def number(report: dict, key: str, path: str) -> float:
    """A field that must be a number, or an input error naming the file and the field."""
    value = report.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InputError(f'{path}: {key} is {value!r}, not a number')
    return float(value)


def close_enough(declared, computed) -> bool:
    return isinstance(declared, (int, float)) and abs(float(declared) - float(computed)) <= STATS_TOLERANCE_MS


def load_json(path: str) -> dict:
    try:
        with open(path) as handle:
            report = json.load(handle)
    except OSError as exc:
        raise InputError(f'{path}: {exc}')
    except json.JSONDecodeError as exc:
        raise InputError(f'{path}: not JSON ({exc})')
    if not isinstance(report, dict):
        raise InputError(f'{path}: the result JSON is not an object')
    return report


def evaluate_run(path: str, reference_path: str, reference_commit: str, workdir: str) -> dict:
    """One result JSON, checked in the order C1-C8 of `docs/PHASE0_DEVICE_PLAN.md` section 5.

    Every check that fails is recorded rather than raised, so one report can list all of them at
    once; the caller decides that a JSON with any problem is not evidence for a verdict.
    """
    report = load_json(path)
    problems: list[str] = []
    notes: list[str] = []

    # C1 -- the fields that say this is a 2400-frame run of the real disc that ended well.
    if report.get('schema') != EXPECTED_SCHEMA:
        problems.append(f'schema is {report.get("schema")!r}, not {EXPECTED_SCHEMA!r}')
    frames = report.get('frames')
    if frames not in (EXPECTED_FRAMES, SHORT_PROOF_FRAMES):
        problems.append(f'frames is {frames!r}, not {EXPECTED_FRAMES} '
                        f'(or {SHORT_PROOF_FRAMES} for the short proof)')
    if report.get('iso_bytes') != EXPECTED_ISO_BYTES:
        problems.append(f'iso_bytes is {report.get("iso_bytes")!r}, not {EXPECTED_ISO_BYTES}')
    if report.get('exit_code') != 0:
        problems.append(f'exit_code is {report.get("exit_code")!r}: the run did not finish cleanly, '
                        'diagnose it from the page log')

    # C2 -- a fine clock in an isolated page. Not an error on its own: it only forbids a GO.
    cross_origin_isolated = report.get('cross_origin_isolated') is True
    timer_resolution_ms = number(report, 'timer_resolution_ms', path)
    if not cross_origin_isolated:
        notes.append('the page was not cross-origin isolated: only the net NO-GO rule applies')
    if timer_resolution_ms > MAX_TIMER_RESOLUTION_MS:
        notes.append(f'timer_resolution_ms is {timer_resolution_ms}, coarser than '
                     f'{MAX_TIMER_RESOLUTION_MS}: only the net NO-GO rule applies')
    clock_ok = cross_origin_isolated and timer_resolution_ms <= MAX_TIMER_RESOLUTION_MS

    # C3 -- the core that ran is the core the reference was built from. A different commit is not
    # fatal by itself: `docs/PHASE0_DEVICE_PLAN.md` section 5, "Il commit del riferimento", accepts
    # parity across commits -- annotating both of them -- when the trace is identical cell by cell
    # *and* hashes to the recorded SHA-1, because the same trace has already been produced by builds
    # of different commits. The decision needs C5's result, so it is taken below; here the mismatch
    # is only recorded.
    core_commit = report.get('core_commit')
    commit_mismatch = None
    if core_commit != reference_commit:
        commit_mismatch = (f'core_commit is {core_commit!r}, not the reference commit '
                           f'{reference_commit!r}')

    # C4 -- the match was reached. The full string belongs to the 2400-frame run; a short proof
    # cannot produce it and is held to the prefix instead.
    final_scene = report.get('final_scene')
    if not isinstance(final_scene, str):
        problems.append(f'final_scene is {final_scene!r}, not a string')
        final_scene = ''
    if frames == EXPECTED_FRAMES and final_scene != EXPECTED_FINAL_SCENE:
        problems.append(f'final_scene is {final_scene!r}, not {EXPECTED_FINAL_SCENE!r}')
    if not final_scene.startswith(FINAL_SCENE_PREFIX):
        problems.append(f'final_scene {final_scene!r} does not start with {FINAL_SCENE_PREFIX!r}')

    # C5 -- the trace, re-compared against the native reference rather than believed.
    trace: dict = {}
    trace_text = report.get('trace_csv')
    if not isinstance(trace_text, str) or not trace_text.strip():
        problems.append('trace_csv is missing or empty')
    else:
        trace_path = os.path.join(workdir, os.path.basename(path) + '.trace.csv')
        with open(trace_path, 'w', newline='') as handle:
            handle.write(trace_text)
        try:
            trace = compare_checkpoints.compare(reference_path, trace_path)
        except Exception as exc:  # compare_checkpoints.TraceError and anything a bad CSV raises
            problems.append(f'trace_csv cannot be compared: {exc}')
            trace = {}
        else:
            trace['sha1'] = sha1_of(trace_text)
            trace['sha1_matches_expected'] = trace['sha1'] == EXPECTED_TRACE_SHA1
            if trace['right_rows'] != EXPECTED_RETRACES:
                problems.append(f'trace_csv has {trace["right_rows"]} retraces, '
                                f'not {EXPECTED_RETRACES}')
            if not trace['identical']:
                notes.append('the trace differs from the native reference: NO-GO for correctness')
            if not trace['sha1_matches_expected']:
                notes.append(f'the trace hashes to {trace["sha1"]}, not {EXPECTED_TRACE_SHA1}')

    # C3, decided now that C5 has run. A different commit is accepted only against a trace that is
    # identical cell by cell and hashes to the recorded reference; anything less is refused, so a
    # JSON produced by another core can never be averaged into a verdict on trust.
    commit_accepted = False
    commit_note = None
    if commit_mismatch:
        if trace.get('identical') and trace.get('sha1_matches_expected'):
            commit_accepted = True
            commit_note = (f'{commit_mismatch}; accepted because the trace is identical to the '
                           f'reference cell by cell and hashes to {EXPECTED_TRACE_SHA1}, the '
                           'cross-commit rule of docs/PHASE0_DEVICE_PLAN.md section 5')
            notes.append(commit_note)
        else:
            problems.append(commit_mismatch)

    # C6 -- the statistics, recomputed from the raw per-frame CSV.
    computed: dict = {}
    declared = report.get('stats_in_match') if isinstance(report.get('stats_in_match'), dict) else {}
    sim_text = report.get('sim_times_csv')
    durations: list = []
    if not isinstance(sim_text, str) or not sim_text.strip():
        problems.append('sim_times_csv is missing or empty')
    else:
        try:
            durations = frame_stats.parse_durations(sim_text, in_match=True)
            computed = frame_stats.stats(durations)
        except ValueError as exc:
            problems.append(f'sim_times_csv cannot be read as in-match durations: {exc}')
        else:
            if computed['count'] < MIN_IN_MATCH_ROWS:
                problems.append(f'the in-match run has {computed["count"]} rows, under '
                                f'{MIN_IN_MATCH_ROWS}')
            if frames == EXPECTED_FRAMES and computed['count'] != EXPECTED_IN_MATCH_ROWS:
                problems.append(f'the in-match run has {computed["count"]} rows, not the '
                                f'{EXPECTED_IN_MATCH_ROWS} of the expected run')
            for key in ('mean_ms', 'p95_ms', 'p99_ms', 'max_ms'):
                if not close_enough(declared.get(key), computed[key]):
                    problems.append(f'stats_in_match.{key} is {declared.get(key)!r} but the CSV '
                                    f'says {computed[key]!r}')

    # C7 -- did the engine warm up inside the run? Recorded either way; a large drift is one of
    # the reasons the criterion calls undecidable.
    warmup = None
    if len(durations) >= 200:
        first = sum(durations[:100]) / 100
        last = sum(durations[-100:]) / 100
        warmup = (last - first) / first if first else None
        if warmup is not None and abs(warmup) > WARMUP_TOLERANCE:
            notes.append(f'the first and last 100 in-match frames differ by {warmup:+.1%}, over '
                         f'the {WARMUP_TOLERANCE:.0%} this tool tolerates')

    # C8 -- internal coherence: the frames cannot have taken longer than the wall clock, and a
    # suspension is not a slow frame.
    wall_ms = number(report, 'wall_ms', path)
    all_durations: list = []
    if durations:
        try:
            all_durations = frame_stats.parse_durations(sim_text, in_match=False)
        except ValueError as exc:
            problems.append(f'sim_times_csv cannot be read as durations: {exc}')
    sum_sim_ms = sum(all_durations) if all_durations else None
    if sum_sim_ms is not None and sum_sim_ms >= wall_ms:
        problems.append(f'the {sum_sim_ms:.1f} ms of simulated frames do not fit in the '
                        f'{wall_ms:.1f} ms of wall clock')
    if computed and computed['max_ms'] >= MAX_PLAUSIBLE_MS:
        problems.append(f'max_ms is {computed["max_ms"]}, which is a suspension and not a frame')

    return {
        'file': path,
        'user_agent': report.get('user_agent'),
        'created': report.get('created'),
        'core_commit': core_commit,
        'core_commit_accepted': commit_accepted,
        'core_commit_note': commit_note,
        'core_opt': report.get('core_opt'),
        'frames': frames,
        'exit_code': report.get('exit_code'),
        'final_scene': final_scene,
        'wall_ms': wall_ms,
        'timer_resolution_ms': timer_resolution_ms,
        'cross_origin_isolated': cross_origin_isolated,
        'clock_ok': clock_ok,
        'disc_source': report.get('disc_source'),
        'stats_in_match_recomputed': computed or None,
        'stats_in_match_declared': declared or None,
        'trace': trace or None,
        'trace_identical': bool(trace.get('identical')) if trace else False,
        'warmup': warmup,
        'sum_sim_ms': sum_sim_ms,
        'problems': problems,
        'notes': notes,
    }


def summarise_class(name: str, paths: list, reference_path: str, reference_commit: str,
                    workdir: str) -> dict:
    """One device class: its runs, and the worst of them.

    A class with no runs is not an error -- it is a row nobody measured, and its thresholds are
    then vacuous. A class with runs but fewer than `MIN_REPEATS` of them is an input error: the
    criterion is defined over three repeats, and two repeats cannot be read as three.
    """
    runs = [evaluate_run(path, reference_path, reference_commit, workdir) for path in paths]
    problems: list[str] = []
    if runs and len(runs) < MIN_REPEATS:
        problems.append(f'{name}: {len(runs)} run(s), but the criterion needs at least {MIN_REPEATS}')
    problems.extend(f'{os.path.basename(run["file"])}: {problem}'
                    for run in runs for problem in run['problems'])
    notes = [f'{os.path.basename(run["file"])}: {note}'
             for run in runs for note in run['notes']]
    means = [run['stats_in_match_recomputed']['mean_ms'] for run in runs
             if run['stats_in_match_recomputed']]
    p99s = [run['stats_in_match_recomputed']['p99_ms'] for run in runs
            if run['stats_in_match_recomputed']]
    return {
        'name': name,
        'measured': bool(runs),
        'count': len(runs),
        'worst_mean_ms': max(means) if means else None,
        'worst_p99_ms': max(p99s) if p99s else None,
        'timer_resolution_ms': max((run['timer_resolution_ms'] for run in runs), default=None),
        'spread': (max(means) - min(means)) / min(means) if len(means) > 1 and min(means) else 0.0,
        'clock_ok': all(run['clock_ok'] for run in runs),
        'warmup_max': max((abs(run['warmup']) for run in runs if run['warmup'] is not None),
                          default=None),
        'runs': runs,
        'problems': problems,
        'notes': notes,
    }


def decide(desktop: dict, phone: dict, node: list) -> tuple:
    """The criterion of `docs/PHASE0_DEVICE_PLAN.md` section 6, as code.

    The order is deliberate and is the order the specification implies: correctness first (a trace
    that differs is NO-GO whatever the timings say), then the net NO-GO bands, then GO, then the
    two "no verdict" outcomes -- desktop only, when the phone row sits clearly in the middle band
    and the desktop row is fine, and no verdict at all for everything else.

    `q` is the clock's resolution, the largest of the runs in the class. Every threshold is applied
    to `m - q` or `p - q` in the direction that makes the verdict harder to obtain, because a
    measurement can be wrong by `q` in either direction and a verdict must survive that.
    """
    reasons: list[str] = []
    differing = [run['file'] for group in (desktop, phone) for run in group['runs']
                 if not run['trace_identical']]
    node_differing = [entry['right'] for entry in node if not entry['identical']]
    if differing or node_differing:
        for path in differing:
            reasons.append(f'{os.path.basename(path)}: the checkpoint trace differs from the native '
                           'reference, so Safari does not run the same game')
        for path in node_differing:
            reasons.append(f'{path}: the trace differs from the native reference')
        return 'NO-GO', 1, reasons

    # A run whose commit was accepted against the reference (C3's exception) is annotated in the
    # reasons, in one short line each: whoever reads a verdict has to see which commit produced the
    # numbers, without wading through the full note the run itself carries.
    for group in (desktop, phone):
        for run in group['runs']:
            if run.get('core_commit_accepted'):
                reasons.append(f'{os.path.basename(run["file"])}: ran the core at '
                               f'{run["core_commit"]} against a reference trace from another '
                               'commit; accepted by the cross-commit rule of '
                               'docs/PHASE0_DEVICE_PLAN.md section 5, the trace being identical '
                               f'and hashing to {EXPECTED_TRACE_SHA1}')

    if phone['measured']:
        m, p, q = phone['worst_mean_ms'], phone['worst_p99_ms'], phone['timer_resolution_ms']
        if m - q > PHONE_MEAN_NOGO or p - q > PHONE_P99_NOGO:
            reasons.append(f'the worst phone repeat is {m:.4f} ms mean and {p:.2f} ms p99 with a '
                           f'{q} ms clock: {m - q:.4f} > {PHONE_MEAN_NOGO} or {p - q:.2f} > '
                           f'{PHONE_P99_NOGO} even after the clock is subtracted')
            return 'NO-GO', 1, reasons
    if desktop['measured']:
        d, dq = desktop['worst_mean_ms'], desktop['timer_resolution_ms']
        if d - dq > DESKTOP_MEAN_NOGO:
            reasons.append(f'the worst desktop repeat is {d:.4f} ms mean with a {dq} ms clock, over '
                           f'{DESKTOP_MEAN_NOGO}')
            return 'NO-GO', 1, reasons

    go = True
    if phone['measured']:
        m, p, q = phone['worst_mean_ms'], phone['worst_p99_ms'], phone['timer_resolution_ms']
        go = go and phone['clock_ok'] and m + q <= PHONE_MEAN_GO and p + q <= PHONE_P99_GO
        if not go:
            reasons.append(f'the worst phone repeat is {m:.4f} ms mean and {p:.2f} ms p99 with a '
                           f'{q} ms clock: {m + q:.4f} against the {PHONE_MEAN_GO} ms GO line and '
                           f'{p + q:.2f} against the {PHONE_P99_GO} ms one')
            if not phone['clock_ok']:
                reasons.append('the page was not cross-origin isolated or its clock is coarser '
                               f'than {MAX_TIMER_RESOLUTION_MS} ms, which forbids a GO on its own')
    if desktop['measured']:
        d, dq = desktop['worst_mean_ms'], desktop['timer_resolution_ms']
        go = go and d + dq <= DESKTOP_MEAN_GO
        if d + dq > DESKTOP_MEAN_GO:
            reasons.append(f'the worst desktop repeat is {d:.4f} ms mean with a {dq} ms clock, over '
                           f'{DESKTOP_MEAN_GO}')
    if go:
        reasons.append('every trace is identical to the native reference and the worst repeat of '
                       'every measured class is inside the GO band with the clock subtracted')
        return 'GO', 0, reasons

    if phone['measured']:
        m, p, q = phone['worst_mean_ms'], phone['worst_p99_ms'], phone['timer_resolution_ms']
        middle = 3.0 < m - q and m + q <= PHONE_MEAN_NOGO and p + q <= PHONE_P99_NOGO
        desktop_fine = not desktop['measured'] or desktop['worst_mean_ms'] + desktop['timer_resolution_ms'] <= DESKTOP_MEAN_GO
        if middle and desktop_fine:
            reasons.append(f'the phone row is in the band the specification calls desktop only: '
                           f'{m - q:.4f} ms > 3 and {m + q:.4f} ms <= {PHONE_MEAN_NOGO} mean, '
                           f'{p + q:.2f} ms <= {PHONE_P99_NOGO} p99')
            reasons.append('the mobile target is re-evaluated in Phase 4, on the Android row the '
                           'specification asks for')
            return 'DESKTOP-ONLY', 3, reasons

    if desktop['measured']:
        d, dq = desktop['worst_mean_ms'], desktop['timer_resolution_ms']
        if DESKTOP_MEAN_GO < d + dq <= DESKTOP_MEAN_NOGO:
            reasons.append(f'the desktop row is {d + dq:.4f} ms with the clock added, inside the '
                           f'({DESKTOP_MEAN_GO}, {DESKTOP_MEAN_NOGO}] band the specification does '
                           'not cover')
            return 'REVIEW', 4, reasons

    reasons.append('no verdict: the numbers are not in a band the criterion covers')
    if not phone['clock_ok'] or not desktop['clock_ok']:
        reasons.append('the clock or the page context forbids a GO: serve the page over HTTPS or '
                       'from localhost and repeat the three runs')
    if phone['warmup_max'] is not None and phone['warmup_max'] > WARMUP_TOLERANCE:
        reasons.append(f'the phone runs warm up inside the match ({phone["warmup_max"]:.1%}), so '
                       'the mean is pessimistic and both it and the last 100 frames belong in the '
                       'report')
    if max(phone['spread'], desktop['spread']) > SPREAD_TOLERANCE:
        reasons.append(f'the repeats scatter by {max(phone["spread"], desktop["spread"]):.1%}, over '
                       f'the {SPREAD_TOLERANCE:.0%} this tool tolerates: cool the device, wait ten '
                       'minutes, run three new repeats')
    return 'NOT-DECIDABLE', 4, reasons


def sha1_of_file(path: str) -> str:
    with open(path, 'rb') as handle:
        return hashlib.sha1(handle.read()).hexdigest()


def parse_args(argv: list) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='The Phase 0 go/no-go over the device result JSONs '
                    '(docs/PHASE0_DEVICE_PLAN.md sections 5 and 6).')
    parser.add_argument('--reference', required=True,
                        help='the native reference trace CSV every run is compared against')
    parser.add_argument('--reference-commit', required=True,
                        help='the commit that reference trace was produced from')
    parser.add_argument('--desktop', nargs='+', default=[], metavar='RESULT.json',
                        help='the desktop repeats (three or more, or none at all)')
    parser.add_argument('--phone', nargs='+', default=[], metavar='RESULT.json',
                        help='the phone repeats (three or more, or none at all)')
    parser.add_argument('--node-trace', nargs='*', default=[], metavar='TRACE.csv',
                        help='traces produced outside a browser (the Node module), compared only '
                             'for identity: a difference is NO-GO')
    return parser.parse_args(argv)


def node_comparisons(paths: list, reference_path: str) -> list:
    entries = []
    for path in paths:
        try:
            result = compare_checkpoints.compare(reference_path, path)
        except Exception as exc:
            raise InputError(f'{path}: cannot be compared against the reference ({exc})')
        entries.append(result)
    return entries


def thresholds() -> dict:
    return {
        'phone_mean_go_ms': PHONE_MEAN_GO, 'phone_p99_go_ms': PHONE_P99_GO,
        'phone_mean_nogo_ms': PHONE_MEAN_NOGO, 'phone_p99_nogo_ms': PHONE_P99_NOGO,
        'desktop_mean_go_ms': DESKTOP_MEAN_GO, 'desktop_mean_nogo_ms': DESKTOP_MEAN_NOGO,
        'min_repeats': MIN_REPEATS, 'min_in_match_rows': MIN_IN_MATCH_ROWS,
        'max_timer_resolution_ms': MAX_TIMER_RESOLUTION_MS,
        'warmup_tolerance': WARMUP_TOLERANCE, 'spread_tolerance': SPREAD_TOLERANCE,
        'max_plausible_ms': MAX_PLAUSIBLE_MS, 'stats_tolerance_ms': STATS_TOLERANCE_MS,
        'expected_frames': EXPECTED_FRAMES, 'expected_in_match_rows': EXPECTED_IN_MATCH_ROWS,
        'expected_trace_sha1': EXPECTED_TRACE_SHA1,
    }


def run(argv: list = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    reference_sha1 = None
    try:
        reference_sha1 = sha1_of_file(args.reference)
    except OSError as exc:
        print(json.dumps({'schema': 'melee-phase0-verdict/1', 'verdict': 'INPUT-ERROR',
                          'reasons': [f'{args.reference}: {exc}']}, indent=2))
        print('VERDICT: INPUT-ERROR')
        return VERDICT_EXIT_CODES['INPUT-ERROR']

    with tempfile.TemporaryDirectory(prefix='melee-go-no-go-') as workdir:
        try:
            if not args.desktop and not args.phone:
                raise InputError('no result JSONs: pass --desktop and/or --phone (three or more '
                                 'per class, docs/PHASE0_NEXT.md S9)')
            desktop = summarise_class('desktop', args.desktop, args.reference,
                                      args.reference_commit, workdir)
            phone = summarise_class('phone', args.phone, args.reference, args.reference_commit,
                                    workdir)
            node = node_comparisons(args.node_trace, args.reference)
        except InputError as exc:
            print(json.dumps({'schema': 'melee-phase0-verdict/1', 'verdict': 'INPUT-ERROR',
                              'reasons': [str(exc)]}, indent=2))
            print('VERDICT: INPUT-ERROR')
            return VERDICT_EXIT_CODES['INPUT-ERROR']

        # A trace that differs is a NO-GO, not an input error: `decide()` owns that rule, because
        # it is a result about the port rather than a defect in the evidence.
        problems = [f'{problem}' for group in (desktop, phone) for problem in group['problems']]
        if problems:
            verdict, code, reasons = 'INPUT-ERROR', 2, problems
        else:
            verdict, code, reasons = decide(desktop, phone, node)

        opts = [run['core_opt'] for group in (desktop, phone) for run in group['runs']]
        provisional = verdict != 'GO' and any(opt in PROVISIONAL_OPTS for opt in opts)
        if provisional:
            reasons.append(f'the core is {opts[0]} (docs/PHASE0_NEXT.md S11): every verdict other '
                           'than GO is provisional until the runs are repeated on the level that '
                           'will ship')

        output = {
            'schema': 'melee-phase0-verdict/1',
            'reference': {'path': args.reference, 'commit': args.reference_commit,
                          'sha1': reference_sha1},
            'classes': {'desktop': desktop, 'phone': phone},
            'node_traces': node,
            'verdict': verdict,
            'reasons': reasons,
            'provisional': provisional,
            'thresholds': thresholds(),
        }
        print(json.dumps(output, indent=2, sort_keys=False))
        print(f'VERDICT: {verdict}')
        return code


def main() -> int:
    try:
        return run()
    except InputError as exc:
        print(json.dumps({'schema': 'melee-phase0-verdict/1', 'verdict': 'INPUT-ERROR',
                          'reasons': [str(exc)]}, indent=2))
        print('VERDICT: INPUT-ERROR')
        return VERDICT_EXIT_CODES['INPUT-ERROR']


if __name__ == '__main__':
    sys.exit(main())
