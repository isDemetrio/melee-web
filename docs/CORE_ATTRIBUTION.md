# Core attribution — experiment in progress

Baseline: 1844f42. No optimization has been applied. Renderer and web play code are excluded.
The 14.9 ms unassigned phone interval is outside this investigation.

Method: `.github/workflows/core-profile.yml` builds the existing native offline core, single
threaded like WASM, with an opt-in interval logger. Linux perf samples at 499 Hz with DWARF
call stacks and CLOCK_MONOTONIC. Only the 762 in-match simulation intervals are retained;
checkpoint hashing, menus and startup are excluded by timestamps, not guessed by symbol.
Every replay must retain SHA-1 `c79c53b9cdf81426fa0277e7497a69e55bc5f571`.
Only aggregate symbol counts and machine metadata leave the runner; stack memory, generated
C++, DOL, disc and traces stay in RUNNER_TEMP and are removed. Three trials quantify stability.
Native attribution is evidence about this workload, not an iPhone timing prediction or a
four-player benchmark. Inclusive stack percentages must not be summed.

Pending: measured attribution, reducibility bounds, and project decision. The existing
600-frame unnamed V8 hotspot (53%, PROGRESS.md) is insufficient to name the simulation bottleneck.
