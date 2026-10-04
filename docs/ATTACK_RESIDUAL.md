# Retrace residual: native and JS boundaries

Instrumentation only, based on `b97787c`. No renderer, pacing, input or guest changes.
The requested worktree/branch already existed clean at origin/main and was reused.

## Existing phone evidence (not a new measurement)

Read the three supplied private JSONs with `csv.DictReader(frames_csv)`, retaining
`match_frame > 0` and `hidden == 0`. Means in ms:

| Session | Frames | cycle | core | sim | old residual | JS clock ns/read |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| D | 3803 | 35.888993 | 33.228188 | 18.279837 | 14.831091 | 55 |
| E | 1437 | 45.600988 | 43.815644 | 28.793848 | 14.893528 | 51 |
| F | 1577 | 46.026646 | 44.153963 | 29.087153 | 14.936576 | 51 |

The old four-read estimate is 0.000220 / 0.000204 / 0.000204 ms, not 14.9 ms.
It used a JS proxy for the native clock, so it cannot exclude an expensive native
clock import. The new page calibrates the actual native steady_clock path too.
No phone time is inferred from Chromium or from the constancy of the residual.

## Boundaries and joins

Native timestamps: C = existing CSV-end clock; B = new clock immediately before
`retrace_heartbeat`; R = existing `g_sim_resume` clock immediately after its return.
JS timestamps: E = bridge entry; H = existing heartbeat entry; T = existing
`heartbeatReturned` sample; P = new `heartbeatResuming` sample just before bridge
return. `B..R` includes the synchronous JS callback and its Atomics waits.

For frame r, append these columns (all old columns and schema are preserved):

| Field | Definition |
| --- | --- |
| `native_pre_heartbeat_ms` | B(r) − C(r): telemetry assignments, trace/digest and profiler reset before JS |
| `previous_native_roundtrip_ms` | R(r−1) − B(r−1), published by native at r, tagged r−1 |
| `previous_js_heartbeat_ms` | T(r−1) − E(r−1); includes presentation, ACK/pacing and callback tail |
| `previous_js_return_to_resume_probe_ms` | P(r−1) − T(r−1), measured entirely on JS clock |
| `previous_bridge_outside_js_ms` | native roundtrip − JS heartbeat − JS return-to-probe; **sum** of B→E ingress and P→R egress, with clock disagreement |
| `bridge_entry_ms` | H(r) − E(r) |
| `residual_unexplained_ms` | old residual − native pre − previous return-to-probe − previous bridge outside JS − bridge entry |

Durations, not epochs, are compared between native and JS. No common clock origin
is assumed. Negative differences remain negative. All previous-frame terms require
matching consecutive retrace IDs, core data and both JS probes. First frames,
old modules, missing probes and skipped IDs are null, never zero. The native result
for the final retrace is deliberately not joined without a following frame.

`summary.{all,in_match}.residual_attribution` reports means on one matched cohort,
matched/excluded counts, and absolute p95/max of the still-unexplained term.
The old reconciliation uses its original cohort. Hidden frames remain excluded.

## How to test the wait hypothesis

Compare **same-retrace** `previous_native_roundtrip_ms` and
`previous_js_heartbeat_ms`. Time present in both is native blocked in the synchronous
JS callback; it is not evidence of native CPU work. That callback contains measured
ACK/pacing waits, already charged to previous frame phases. Do not add these two
roundtrip fields to the cycle or subtract them twice.

A large `previous_js_return_to_resume_probe_ms` locates time after callback return
but before the final JS probe. A large `native_pre_heartbeat_ms` locates time in
native bookkeeping before entry. A large `previous_bridge_outside_js_ms` locates
time in the two small bridge boundary intervals **jointly**; this instrumentation
cannot distinguish ingress from egress. P precedes R: calling P the native resume
would be false. A large `residual_unexplained_ms` leaves cross-clock disagreement,
clock-read latency and omitted boundary accounting unresolved, with signed and
absolute numbers printed rather than assigned to a function.

These are wall clocks, not thread CPU clocks. GC, descheduling or hidden WebKit
synchronization within an interval require a Safari/WebKit runtime trace correlated
with retraces to distinguish from executing work. No timer/event-loop yield,
Atomics wait or synchronization was added. There is no optimisation proposal yet:
we do not know which interval contains the phone's 14.9 ms.

## Instrument cost

Prior residual probes: three JS reads + one extra native read per retrace.
This change adds two JS reads (E, P) and one native read (B). Total: five JS + two
native extra reads. The existing sim-start/end and FrameMeter clocks are unchanged.
The startup-only `melee_residual_clock_cost_ns` measures 100,000 steady_clock reads
through the actual WASM clock import; its loop/store overhead is included. The
existing JS calibration is separate. Both are estimates and may be quantized.

The report keeps `estimated_residual_clock_ms` unchanged for compatibility and adds
`native_clock_cost_ns`, `estimated_total_residual_clock_ms = (5*JS + 2*native)/1e6`
and `estimated_added_residual_clock_ms = (2*JS + native)/1e6`. Missing calibration
produces null. Nothing is subtracted from measured durations. Wrapper calls,
objects, reporting and runtime scheduling remain uncalibrated and included in
the actual intervals (including simulation after the native resume timestamp).
At the old phone JS calibration, the **two new JS reads alone** estimate
0.000110 / 0.000102 / 0.000102 ms; the native term awaits the new report.

## Verification and remaining verdict

Unit tests use known clocks to separate 100 ms inside JS from 0/15 ms after its
return, test the additive identity, and keep old-core measurements unavailable.
The real renderer-only page test downloads a report: it must explicitly say
attribution is unavailable because that selftest never runs native retraces.
It does exercise the native clock calibration. This is not a phone-game report.

Builds/tests and the full 2400-checkpoint replay run only in Actions. The required
reference is `c79c53b9cdf81426fa0277e7497a69e55bc5f571`. Results are recorded in the PR
and PROGRESS after completion. The operator's new iPhone game report is still
required to place the 14.9 ms in one of these intervals; the old JSONs cannot do so.
