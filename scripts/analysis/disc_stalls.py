#!/usr/bin/env python3
"""Disc stalls in melee-play-report/1 files (the Game screen's Save report).

For every frame whose disc reads took at least --threshold ms (250 by default: the report's own
freeze threshold), prints the retrace, the match frame, the disc time and bytes, and how long the
game had gone without reading the disc before it. Then, for all frames that read the disc, how
many were slow after a gap of under one second, one to two, and two or more: the evidence that the
cost is paid by the first read after an idle period (docs/PROGRESS.md, "Disc stalls").

Exit status 1 when any report has a disc stall, so a report can be checked against the criterion
"no disc stall over 250 ms" in one command. Reads timing only; prints no game data.
"""
import argparse
import csv
import io
import json
import sys

GAP_BUCKETS = ((0.0, 1.0, 'under 1 s'), (1.0, 2.0, '1 to 2 s'), (2.0, float('inf'), '2 s or more'))


def disc_frames(report):
    """(retrace, match_frame, disc_ms, disc_bytes, wall_s, gap_s) for each frame that read the disc.

    The wall clock is the sum of cycle_ms before the frame; the gap is from the end of the last
    frame's core part that read the disc to the start of this frame, on that clock.
    """
    rows = list(csv.DictReader(io.StringIO(report['frames_csv'])))
    wall, last_read_end, out = 0.0, None, []
    for row in rows:
        disc_bytes = int(row['disc_bytes'])
        if disc_bytes:
            gap = (wall - last_read_end) / 1000 if last_read_end is not None else None
            out.append((int(row['retrace']), int(row['match_frame'] or 0), float(row['disc_ms']), disc_bytes,
                        wall / 1000, gap))
            last_read_end = wall + float(row['core_ms'])
        wall += float(row['cycle_ms'])
    return out


def disc_note(report):
    """The worker's note on how the disc was read, if the report has one."""
    for note in report.get('notes', []):
        if note.startswith('disc read'):
            return note
    return 'no note on the disc read path (a report from before the OPFS handle)'


def analyse(report, threshold):
    frames = disc_frames(report)
    stalls = [frame for frame in frames if frame[2] >= threshold]
    buckets = []
    for low, high, label in GAP_BUCKETS:
        inside = [frame for frame in frames if frame[5] is not None and low <= frame[5] < high]
        buckets.append((label, len(inside), sum(1 for frame in inside if frame[2] >= threshold),
                        max((frame[2] for frame in inside), default=0.0)))
    return {'frames': len(frames), 'stalls': stalls, 'buckets': buckets, 'note': disc_note(report)}


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('reports', nargs='+')
    parser.add_argument('--threshold', type=float, default=250.0)
    args = parser.parse_args(argv[1:])
    stalled = False
    for path in args.reports:
        with open(path, encoding='utf-8') as handle:
            report = json.load(handle)
        if report.get('schema') != 'melee-play-report/1':
            print(f'{path}: not a melee-play-report/1 file', file=sys.stderr)
            return 2
        result = analyse(report, args.threshold)
        stalled = stalled or bool(result['stalls'])
        print(f"== {path}\ncore {report.get('core_commit')}; {result['note']}")
        print(f"{result['frames']} frames read the disc; {len(result['stalls'])} took {args.threshold:g} ms or more")
        for retrace, match_frame, disc_ms, disc_bytes, wall_s, gap_s in result['stalls']:
            gap = 'first read' if gap_s is None else f'{gap_s:.2f} s without a read before'
            print(f'  retrace {retrace} match_frame {match_frame}: {disc_ms:.1f} ms for {disc_bytes} bytes '
                  f'at {wall_s:.1f} s, {gap}')
        for label, count, slow, worst in result['buckets']:
            print(f'  gap {label}: {count} reading frames, {slow} slow, longest {worst:.1f} ms')
    return 1 if stalled else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
