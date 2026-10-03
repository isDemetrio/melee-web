# Attributing the retrace residual

This change measures; it does not reduce simulation/render work or promise 60 fps.
The external cycle/core boundaries and all existing CSV columns remain unchanged.
`wasm/render/gx_webgpu.cpp` is unchanged.

For retrace **r**, the added frame columns are:

| Column | Interval |
| --- | --- |
| `sim_ms` | Unrounded native simulation duration passed through the heartbeat, tagged r; same interval as the existing sim CSV |
| `previous_heartbeat_tail_ms` | `cycleEnd()`'s clock at r−1 through return of that callback, sampled by the WASM bridge; includes frame accounting, totals, flush/postMessage |
| `csv_write_ms` | Native sim end stamp through completion of sim CSV flush, including scene lookup, formatting, decoder CSV and its flush |
| `heartbeat_read_ms` | JS callback entry at r through both CSV tails; includes the existing heartbeat sender |
| `heartbeat_finish_ms` | End of tails through `coreEnd()`'s existing clock; parsing, joining and argument preparation |
| `core_unattributed_ms` | core minus the five durations above, signed and never clamped |

Thus `cycle = sim + previous_tail + csv_write + heartbeat_read + heartbeat_finish
+ core_unattributed + bitmap + ack + idle`, up to independent 0.001 ms rounding.
GPU API and disc measurements overlap these terms: do not add them again.
The seven profiler phases already sum to sim; do not add sim to those phases.

The first frame has no previous callback. Missing/old-core telemetry, mismatched
retrace IDs and missing returns leave reconciliation null, not zero. Summary
`reconciliation` uses only fully matched rows for **every** mean, and reports the
excluded count and absolute mean/p95/max residual so positive and negative errors
cannot cancel unnoticed. Its residual still includes native reset/hash/digest work,
bridge overhead and the gap from the post-callback sample to native sim resume.
These are not assigned to CSV or callback without measurement. Live play requests
no hashes; a tracing run will legitimately have a larger residual.

Instrumentation adds three JS clock reads and one native steady_clock read per
retrace. `estimated_residual_clock_ms` estimates their combined cost with the JS
clock calibration: the native bridge cost is not independently calibrated. It is
an estimate, not a subtraction. Wrapper/accounting costs and internal profiler
clock reads remain included in their actual intervals; the older
`estimated_meter_ms` still estimates only two JS reads per observed API call.

Queue interception covers the queue prototype in this dedicated worker, forwards
the actual receiver, and retains instance interception for plain own-method mocks.
This covers a getter returning different wrappers without declaring that this was
the cause on the operator's phone. Before attach/play, `queue_probe` performs one
4-byte buffer write, one 1×1 texture write and one real command-buffer submit,
reading `device.queue` afresh each time. It records expected/observed counts,
unrounded times, validation errors and pass/fail; probe resources are destroyed.
It awaits completion before entering the synchronous game. `start()` excludes
probe/attach calls from gameplay totals. A failed probe is explicitly noted; zero
time with a positive count can simply mean timer quantization.

Verification runs only in Actions: unit tests exercise retrace joins, signed and
missing residuals, fresh queue wrappers, receiver identity and missing hooks. The
real page test downloads its report and checks the known submission and subsequent
renderer queue calls. The workflow retains only that synthetic JSON report as
`play-instrumentation-report`; it contains no ISO/DOL/guest state.

A synthetic renderer report does **not** measure the 16–24 ms live-game gap. The
operator must produce the new phone report and inspect `summary.in_match.reconciliation`
and `queue_probe` (plus gameplay method totals). No live residual value or checkpoint
parity is claimed until the relevant replay has actually run. The required 2400-row
reference remains SHA-1 `c79c53b9cdf81426fa0277e7497a69e55bc5f571`.


The optional `ci.yml` dispatch input `checkpoint_build_run` reuses the private Node
artifact from a successful core build, checks that its source matches the code
under test, and downloads the existing private R2 disc on the runner using CI
credentials. The runner verifies disc revision, full trace SHA-1, 2400 rows and
final scene, then removes the disc/module/replay files without uploading them.
This checks the full reference digest, not a cell-by-cell reference-file diff.
R2 access must succeed; a Pages-only token cannot silently skip the gate.
The read uses the documented [Wrangler R2 get command](https://developers.cloudflare.com/r2/reference/wrangler-commands/#r2-object-get).
