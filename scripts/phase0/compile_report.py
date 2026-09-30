#!/usr/bin/env python3
"""Summarize numeric-only compiler telemetry, including failed compiles."""
import csv
import pathlib
import sys

rows = list(csv.DictReader(pathlib.Path(sys.argv[1]).open()))
print(f"Build wall seconds: {sys.argv[2]}")
print(f"Compile invocations: {len(rows)}; failures: {sum(r['status'] != '0' for r in rows)}")
print(f"Highest compiler peak RSS KiB: {max((int(r['max_rss_kb']) for r in rows), default=0)}")
print(f"Total object bytes: {sum(int(r['object_bytes']) for r in rows)}")
print("Five slowest translation units:")
for variant in sorted({r['variant'] for r in rows}):
    group = [r for r in rows if r['variant'] == variant]
    print(f"{variant}: {len(group)} objects; {sum(int(r['object_bytes']) for r in group)} bytes; peak RSS {max(int(r['max_rss_kb']) for r in group)} KiB")
for r in sorted(rows, key=lambda r: float(r['seconds']), reverse=True)[:5]:
    print(f"- {r['variant']}/{r['tu']}: {r['seconds']} s, {r['max_rss_kb']} KiB RSS, {r['object_bytes']} bytes, exit {r['status']}")
