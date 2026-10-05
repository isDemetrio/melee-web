# Four players in one match: measured load

**Question.** Does the game hold up when four people play at once? The declared goal of the project
is four controllers in one match, and no measurement had ever put four characters on screen. The
project's only reference number came from one browser run: 40.5 fps in a match, 24.67 ms mean
cycle, 10.15 ms core, on an iPhone, in a match with **two** human controllers and **two**
characters.

**Answer.** Four characters cost **1.49x the simulation time** and **1.32x the draw calls** of the
same match with two characters. The extra cost is not rendering-dominated: the simulation is the
part that scales, and it scales by roughly half again. Concretely, in-match means on the CI
machine:

| workload | controllers | characters | `sim_ms` mean | `sim_ms` p95 | draws/frame mean | draws p95 | vertices/frame |
|---|---|---|---|---|---|---|---|
| reference (`parity_vs_onett.txt`) | 2 | 2 | 33.17 | 34.15 | 671.8 | 716 | 30137 |
| two-player control | 2 | 2 | 33.86 | 36.24 | 684.8 | 729 | 30130 |
| **four-player** | **4** | **4** | **50.43** | **53.15** | **903.3** | **985** | **46102** |

Ratios (four-player / two-player control): `sim_ms` **1.489**, draws **1.319**, vertices **1.531**.
Against the project reference: `sim_ms` **1.520**, draws **1.345**.

The split is the point: **+16.57 ms of simulation and +218 draws per frame** for two extra
characters. Draw calls rise 32%; simulation rises 49%. Four players is a real cost increase, not a
rounding error, and it lands on the core, which is the side the project has been optimising.

### This ratio comes from CI on the VPS, not from the phone

Every millisecond above was measured headlessly on the GitHub Actions runner (see `machine.txt` in
the artifact for that machine). The runner is a VPS, not the operator's iPhone, and the browser-side
timers were not measured at all. **Only the ratio transfers. The absolute milliseconds do not.**
The ratio is the part that answers the question, because it is the ratio of the same match, with the
same inputs, on the same machine, differing only in how many characters are on screen.

### Projection onto the operator's phone number -- a projection, not a measurement

The operator's real measurement (40.5 fps, 24.67 ms mean cycle, 10.15 ms core, iPhone, two
characters) was never re-run with four characters, and could not be from CI. If the CI ratio held on
the phone, and if only the core term scaled while the rest of the cycle stayed fixed, the phone's
numbers would move as follows. **This is a projection by arithmetic on a ratio measured on another
machine; it is not a measurement and it must not be reported as one.**

| basis | core | cycle | fps |
|---|---|---|---|
| operator's measurement (2 characters) | 10.15 ms | 24.67 ms | 40.5 |
| projected (4 characters), four/reference ratio 1.520 | 15.43 ms | 29.95 ms | 33.4 |
| projected (4 characters), four/two-control ratio 1.489 | 15.12 ms | 29.64 ms | 33.7 |

The projection assumes the non-core part of the cycle (browser/WebGPU submission, bitmap, ack,
idle) does not itself change with character count. That assumption is **untested**: it is exactly
what the missing browser-side columns would have settled.

### Was it really four characters on screen? Yes -- and an earlier run was not

The first revision of this harness reported a four-controller cost while the oracle certified only
`two_hud_frames: 885, four_hud_frames: 0` -- two characters. That number was wrong and was not
reported as the four-player cost. The cause: ports 3 and 4 were moved the wrong way on the stick and
never actually joined, so the extra milliseconds were pad polling and input replay, not two extra
characters. The sweep below found the working move, the workload was fixed, and the certified run
now reports `four_hud_frames: 838, two_hud_frames: 0, max_hud_present: 4` -- **every in-match frame
had four HUD slots**. The table above is from that run.

## What was already there, and what had to be written

`perf/beyond-core` is a real prior attempt at this, and it was never landed. Recovered from it and
reused:

- `experiments/beyond-core/graphics_oracle.h` -- the idea of an ordered renderer-input oracle and,
  specifically, reading `gx::Frame.hud_players` to count how many characters the renderer actually
  drew. This is what makes the measurement honest: it certifies the character count instead of
  assuming it.
- `experiments/beyond-core/install_oracle.py` -- the CI-only splice pattern: the oracle lives in
  `experiments/` and is injected into the runner's copy of `native/real_fifo.cpp`, never committed
  as a source change.
- `experiments/beyond-core/four-player.txt` -- recovered, **and it does not work**. It drives all
  four ports with the canonical `sx=61 sy=127` move. Ports 3 and 4 then claim their door but never
  pick a character, the character select never advances to the stage select, and the run ends at
  `mode=2 state=0` with no match. Its own harness asserted `four_hud_frames > 600`, which could
  never have passed. This is the trap the task warned about, and it is why the character count is
  certified rather than assumed.

Written new for this measurement:

- `experiments/four-player/four-player.txt` -- the four-controller workload that actually reaches a
  four-character match.
- `experiments/four-player/two-player.txt` -- the control: the *same* match, the *same* in-match
  input schedule, with ports 3 and 4 absent.
- `experiments/four-player/oracle.h`, `install_oracle.py` -- the CI-only oracle, reusing the
  beyond-core shape but adding per-frame `draws`, `vertices` and the HUD-slot histogram.
- `experiments/four-player/measure.py` -- runs each workload, joins the two frame clocks, asserts
  the trace gate on the reference, and writes `four-player.json`.
- `experiments/four-player/sweep_css.py` -- the exploratory sweep that found the working hand move.
- `.github/workflows/four-player-load.yml`, `.github/workflows/four-player-sweep.yml`.

## How the four characters are actually obtained

The decompilation (`mncharsel.c`) is what cracked it. Every character-select hand starts at
`y = -21.5`, below the grid, and a port's own door only becomes human while its hand sits on the
grid, at `y` in `(0.2, 22)` (mncharsel.c:3319). The stick's Y sign is the direction: `sy=+127`
drives the hand up into the grid, `sy=-127` drives it further down. Ports 1 and 2 keep the
canonical move (`sx=61 sy=127`) and press A. For ports 3 and 4 the same move leaves the door claimed
with no character, which is exactly the stall described above. A CI sweep of candidate moves
(`sweep_css.py`, artifact `four-player-sweep`) gives:

| ports 3/4 move | final scene | HUD slots |
|---|---|---|
| `sy=127` (up only) | match | **4** |
| `sx=-61 sy=127` | match | **4** |
| `sx=61 sy=127` (the recovered move) | CSS, never advances | 0 |
| `sx=127 sy=127`, `sx=-127 sy=127` | CSS, never advances | 0 |
| `sx=127 sy=0` | match | 2 |

So ports 3/4 need the upward move, and a positive X component on the stick defeats it. The
workload uses `sy=127` alone.

## Method

`four-player-load.yml` builds the shipped node core with the oracle spliced in, reads the private
disc, and runs three workloads of 2400 retraces each:

1. `reference` -- `upstream/melee-unlocked/port/scripts/parity_vs_onett.txt`, unchanged. The trace
   gate.
2. `two-player` -- the control match, two human controllers, two characters.
3. `four-player` -- four human controllers, four characters.

Two clocks are reported and are deliberately **not** joined frame-for-frame: the core's per-retrace
`sim_ms` (from `--sim-times`), and the renderer oracle's per-submitted-frame `draws`, `vertices` and
HUD-slot count (from the oracle hook). They agree on the match window (both are one row per
retrace/frame; the oracle sees fewer frames in menus, where not every retrace presents). Each
workload's `sim_ms` statistics are computed over its own in-match retraces (`match_frame > 0`) and
the renderer statistics over its own in-match frames (`scene_major == 2 && scene_minor == 2`).

The character counts in the table are not assumed. They are the oracle's `max_hud_present`: 2 for
the reference and the control, 4 for the four-player run, in every single match frame
(`four_hud_frames = 838`, `two_hud_frames = 0`).

## Nothing broke

- **Trace gate: IDENTICAL.** The reference workload's 2400-retrace trace SHA-1 is
  `c79c53b9cdf81426fa0277e7497a69e55bc5f571`, the project reference, in the CI run
  ([37297575825](https://github.com/isDemetrio/melee-web/actions/runs/37297575825)). The oracle is a
  reader that cannot touch guest state, and the gate is what proves it: had the splice perturbed the
  core, the job would have failed instead of reporting a number.
- **The graphics path is unchanged.** The only source the branch adds under `upstream/` or `native/`
  is nothing at all: `git diff main...perf/four-player-load` touches no core source. The oracle is
  spliced into the runner's checkout at build time and never committed. The measured renderer input
  is therefore the shipped renderer's, and the draw/vertex counts above are the shipped renderer's
  own counts.

## What could NOT be measured, and why

- **`cycle_ms`, `webgpu_ms`, `bitmap_ms`, `ack_ms`, `idle_ms`.** These are browser-side play-report
  columns (`web/src/play/frame-meter.ts`). They need a real browser with WebGPU and the real disc
  driving the page; CI has the disc but not a browser run of the full match, and the headless node
  module emits neither. Only `sim_ms` (core) and the renderer oracle's `draws`/`vertices` are
  measured here. The ratio to apply to those columns is the `sim_ms` ratio for the core side and the
  draws ratio for the submission side, but the columns themselves are unmeasured.
- **A one-player baseline.** Melee's Vs character select will not start a match with fewer than two
  non-CPU doors: `mncharsel.c` requires `valid_count >= 2` before the PRESS START prompt appears, and
  a one-controller workload run here ends at `mode=2 state=0` with no match at all. The smallest
  measurable match is two characters, which is what the reference and the control both are. The
  comparison is therefore **four characters against two**, not against one.
- **Absolute frame rate on the target device.** The numbers are ratios measured on the CI machine.
  The CI runner is not an iPhone, and the browser-side timers were not measured, so no fps figure is
  claimed for four players on a phone.
