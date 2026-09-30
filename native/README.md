# Linux headless reference — unverified offline implementation

This is an **honest partial port, not yet an end-to-end proof**. No compilation or
execution was performed on the VPS. The new Actions workflow must establish that
it builds; an operator ISO run must establish that it boots, reaches the requested
frames, and matches a Windows reference. Nothing was pushed.

The target links actual generated guest functions, PPC dispatch/interpreter,
OS/DVD/PAD/card HLE, ARAM DMA, and AX audio mixing. It calls the same `__start`
(`0x8000522C`) as `port/app/main.cpp`. It does not replace the game with a frame loop.
Boot layout, interrupt/alarm/completion order, and hashes are adapted from the
pinned `port/runtime/host/host.cpp`; input parsing is from `window.cpp`.

## CI commands

Run only in GitHub Actions (Ubuntu 24.04, GCC, Ninja, OpenSSL development headers):

```sh
scripts/apply_patches.sh
python3 upstream/melee-unlocked/port/recomp/recomp.py \
  --dol "$RUNNER_TEMP/main.dol" --out "$RUNNER_TEMP/generated-native" --no-slippi
cmake -S native -B "$RUNNER_TEMP/build-native" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=g++ \
  -DPORT_GEN="$RUNNER_TEMP/generated-native"
cmake --build "$RUNNER_TEMP/build-native" --target melee_core_headless --parallel 2
```

The workflow fetches/verifies the private DOL using `DOL_REPO_TOKEN`, builds the
whole target, builds/runs `native_fifo_test`, and checks CLI rejection paths and
`--check-dol`. It does **not** run the game: CI has no ISO. It uploads no executable,
DOL, or generated code. `--check-dol` only validates the retail DOL SHA-1.

After transferring a CI-built executable through an approved private mechanism,
an operator can run (not compile) it with the ISO:

```sh
melee_core_headless --iso /absolute/path/melee.iso --headless --fast \
  --frames 2400 --time-base 1 --volume 0 \
  --script upstream/melee-unlocked/port/scripts/vs_match.txt \
  --card-dir /tmp/melee-reference/trial/card \
  --state-trace /tmp/melee-reference/trace.csv \
  --state-digest /tmp/melee-reference/digest.csv
```

Create the trace directory first. Use fresh, isolated card directories **and their
parent directories** per trial (upstream persists `sram.bin` beside the card).
A supplied `--dol PATH` overrides DOL loading, but still requires `--iso` for FST
and assets. A standalone DOL is insufficient for a match.

The default stdout trace is the upstream `retrace,cpu,ram,aram,events` CSV with
uppercase 16-digit hexadecimal hashes. `--state-trace PATH` writes it to a file;
`--state-digest PATH` retains the separate gameplay digest schema, not an alias for
the CPU hash. CPU fields/hash order and checkpoint timing are unchanged.

## Differences, substitutes, and unresolved assumptions

- **Slippi remains unported.** Default recompiler output requires Slippi EXI and
  code-table installation. This executable rejects it at boot with
  `TODO(portability)`. Use `--no-slippi`; the existing 144-TU/20,076-function default
  pipeline is not replaced and its counts must not be asserted for this variant.
  EXI Slippi calls fail explicitly rather than returning invented responses.
- No Windows host implementation, launcher, network service, renderer, or GX source
  is linked. A small FIFO decoder retains CP/VAT framing, display-list traversal,
  masked BP writes, PE finish/token events, default HUD scale writes, and the PC
  Settings-row guest write. It discards vertices, matrices, textures and EFB
  submissions as presentation work. Like the Windows **null backend**, it does
  not rasterize EFB copies into RAM. Unsupported opcodes/truncated display lists
  fail instead of upstream's diagnostic-and-continue behavior. This boundary has
  not been validated against real guest traces.
- Render identity/pose observers are explicit no-ops. HUD defaults are fixed at
  100%, PAL stock mode off. Cosmetic overrides, saved graphics/UI settings,
  controller overlays/UI input capture, optional L-cancel injection, user Gecko
  codes, replay recording, lobby publishing and network polling are absent.
- AI/DSP/AX and ARAM processing are real; only PCM output is discarded (no WinMM,
  sound device or WAV output). Volume must be zero. Existing upstream OS/SI/EXI
  hardware HLE stubs remain; no extra simulation success stubs were added.
- Scripts use upstream button/axis/trigger, port, scene, match and loop semantics.
  Physical inputs/calibration/rumble are absent; without a script, port 1 is
  neutral and other ports disconnected. `@release` is rejected. The match-start
  hook is installed unconditionally (Windows installs it with its optional RNG
  hook); no RNG override is provided here. The existing `vs_match.txt` assumes
  Slippi boot timing: its success on this offline guest is **not established**.
- `--hidden`, threaded and authored rendering modes fail explicitly. The headless
  invocation produced by `validate_native.py` is accepted, but that script's full
  five-renderer isolation sweep cannot run on this target. Compare against a
  Windows executable built from the **same offline translation**, not default
  Slippi output. User/cache/replay directory flags are accepted but unused.
- Linux stdio/64-bit file seeks and OpenSSL EVP replace Windows file/SHA APIs.
  Diagnostics use stderr (or `--log-file`); no asynchronous log/profiler threads.
  Non-fast pacing uses `sleep_until`; virtual time is unchanged. `--time-base 0`
  keeps upstream wall-clock epoch behavior; use `1` for reproducibility.
- Linux x86-64 only: retain MXCSR through patch 0002 and the existing 0001 FMA
  shim. Full-game floating-point parity is unmeasured. Patch 0002 also drains and
  joins the DVD worker on normal exit; fatal errors flush and terminate directly.

## Files and verification

Created: `native/CMakeLists.txt`, `native/headless.h`, `native/headless_main.cpp`,
`native/headless_host.cpp`, `native/headless_input.cpp`, `native/headless_fifo.cpp`,
`native/headless_services.cpp`, `native/tests/fifo_test.cpp`, this `native/README.md`,
`patches/0002-native-linux-runtime.patch`, and
`.github/workflows/phase0-native-headless.yml`.
Changed: `docs/PORT_CHANGES.md` (two patch-table entries).

Local checks are source-only: patch series applies in a temporary tree, selected
HLE implementations cover every HLE-list name present in the pinned symbol map,
whitespace and staged game-data hygiene checked. FIFO tests cover fragmented
commands, BP masks, draw/XF payload framing, and display-list interrupts; **these
are scheduled for CI, not run here**. Submodule contents and `docs/PHASE0_TASKS.md`
were not edited. Build, boot, 2400 checkpoints, scripted match entry, and Windows
parity remain unverified.
