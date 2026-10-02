# Open questions — operator decisions required

These are decisions the agent cannot take alone: they need the operator's own accounts,
hardware, files, or a judgement call about scope. Each entry says what is blocked until
it is answered.

## Q1 — The game disc — **ANSWERED 2026-09-30**

The operator supplied the disc image. Both artifacts are verified against independent
public sources, not against our own expectations:

| Artifact | Size (bytes) | SHA-1 | Where it is |
| --- | --- | --- | --- |
| Disc image (ISO) | 1,459,978,240 | `d4e70c064cc714ba8400a849cf299dbd1aa326fc` | `/home/hermes/incoming/melee-ntsc102.iso` (VPS, not in any repo) |
| `main.dol` | 4,425,184 | `08e0bf20134dfcb260699671004527b2d6bb1a45` | `github.com/isDemetrio/melee-orig-dol` (private) |

The ISO SHA-1 is the Redump entry for *Super Smash Bros. Melee (USA) (En,Ja) (v1.02)* and
the value `999sian/melee-pc` requires; the DOL SHA-1 is what `doldecomp/melee` documents for
GALE01 1.02. Extraction: DOL offset read from the disc header's own field at `0x420`
(`0x1e800`), range truncated at the end of the last section (`0x4385e0`), disc magic
`c2339f3d` confirmed at `0x1C`.

**The ISO stays out of the repositories** (1.36 GB, and the client build needs it for
assets, not for code generation).

## Q2 — Where the DOL lives for CI — **ANSWERED 2026-09-30**

Option 1 of the three below: a **separate private repository**, `isDemetrio/melee-orig-dol`,
holding `main.dol` and a README with its provenance and both hashes. Verified after the
push: remote blob `54ebe2fbcd23c3031f2cb0948ccd9e7350407897`, 4,425,184 bytes, identical to
the local `git hash-object`.

Still open inside Q2: the credential the build job uses to read that repository, and the
machine the game build runs on. Both need the operator (a token, or a Codespaces
authorisation) and are recorded in the Phase 0 section of `docs/PROGRESS.md`.

Options, in order of preference:

1. A **separate private repository** holding `main.dol`, pulled by the build job with a
   fine-grained PAT scoped to that one repository.
2. A **private release asset** in this repository, fetched with the workflow's own token.
3. A **Codespace** for the game build only, with the repository's Actions used for
   everything else.

Note the specification's own constraint that generated code must never be committed:
option 1 and 2 keep the DOL out of the working tree of the main repository; the build
job deletes it and the generated tree at the end of the run.

## Q3 — Cloudflare and Supabase

Deploy needs: a Cloudflare API token (Pages + R2 + Realtime TURN permissions), the
account ID, the domain, and a Supabase project URL plus anon and service keys. The TURN
key ID and API token are needed for `/api/turn-credentials`.

**Blocked until answered**: any real deployment. Everything is written to be deployed
with one command once the credentials exist.

## Q4 — Scope of the first playable milestone

The specification's Phase 1 exit criteria are "boot, intro, menus, character select, a CPU
match on five stages, 60 fps, no visible artefacts". That is the first point at which the
project produces something the operator can actually look at. Confirm that Phase 0 then
Phase 1 is the right order of investment, rather than, say, proving online play first.

## Q5 — iOS

The specification allows declaring iOS out of scope if WebGPU, `SharedArrayBuffer` with
COOP/COEP, AudioWorklet or OPFS turn out to be missing or unstable. The decision point is
Phase 4. No action needed now.

## Q6 — Upstream contains DOL-derived code in its public tree

`upstream/melee-unlocked` tracks 453 files under `port/generated.before-{0563,pal,shake}/`
(67 MB each), which are recompiler output derived from the Nintendo disc, despite its
`.gitignore` listing `/port/generated*/`. This repository does not copy them (the upstream
is a submodule), and `scripts/check_no_game_data.py` rejects those paths. Noting it because
it is relevant to how much the upstream can be relied on as a clean base, and it is not the
agent's call whether to raise it upstream.

## Q7 — Policy for NaN bit differences in FMA — **closed by measurement, no decision needed**

**Status: not blocking anything any more.** Run 36677219860 (2026-09-30 06:15 UTC) measured
8,000,000 results with **0 divergences** between the native x86-intrinsic build and the WASM
build: `nan-sign` 0, `nan-payload` 0, `zero-sign` 0, `subnormal` 0, `value` 0,
`nan-vs-number` 0, identical digests on both sides, strict gate passing with no exemption.

What happened to the question. It was opened when the probe's first classified runs showed
`zero-sign` and then NaN-class divergences, and the residual was attributed to the platform:
the WASM specification does leave the sign and payload of a NaN produced by arithmetic to
the engine. That attribution was wrong both times it was used. The `zero-sign` class was
musl's `fma.c` zero-addend shortcut; the NaN classes were this shim's own behaviour —
negating a NaN operand in the three wrappers, and then `fmadd` simply having no NaN guard
while its three sibling wrappers did. With a guard on all four operations, nothing diverges,
including NaN payloads, on a corpus that feeds 51,656 NaN operands
(`wasm/README.md`, "Finding"; `docs/PORT_CHANGES.md`, "The NaN-sign class").

So there is nothing to exempt, and the four options below are recorded as the reasoning that
was superseded, not as choices still open. The `--allow-nan-payload-differences` switch
still exists in the probe and is unused in CI; the gate is strict.

What is *not* settled by this, and stays open as a later question rather than as Q7:

- browser-to-browser determinism: the peers are engines, not this one Node build. The
  WASM-x86 vs WASM-arm64 comparison is the measurement that speaks to it, and ARM's default
  NaN is positive, so NaN sign is a candidate there (`wasm/README.md`, next measurements 2).
- whether the guards cost anything on the hot path: the benchmark shows native 3.06 ns/op
  against WASM 21.26 ns/op for a dependent `fmadd` chain, with no threshold and no baseline
  from before the guards, so it does not say. `docs/PROGRESS.md`, "Measured numbers".
- whether the game ever feeds NaN into these four operations: still unmeasured, still needs
  the running build (Q1). It no longer decides a policy, but it would say how much of the
  corpus's NaN density resembles gameplay.

The original options, kept for the record:

1. **Keep bit-exact** and make the runtime canonicalize NaN results of the FP helpers on
   every platform. Costs a compare per FP op on the hot path and makes the port
   deliberately differ from Jit64 NaN bits.
2. **Accept NaN-payload differences** (enable `--allow-nan-payload-differences`
   in CI), only after the running build shows the game never feeds NaN into these
   operations. A NaN *sign* difference would still fail; it needs option 1.
3. **Emulate the reference's NaN rule in the shim**: return the first NaN operand quieted
   and unnegated, and the x86 invalid-operation default NaN for `0*inf`. Deterministic on
   every engine, closest to the native reference, and it costs the same kind of per-op
   check as option 1 — but it pins x86 NaN bits into the port's contract on purpose.
   **This is what was implemented** (options 1 and 3 differ only in what a NaN result with
   no NaN operand does, and that case measures 0 divergent), and it is why the question is
   closed rather than deferred.
4. **Defer** until the WASM-x86 vs WASM-arm64 comparison exists, since browsers,
   not native Dolphin, are the netcode peers.

## Q8 — S7 browser device and private spike artifact

S6 adds an off-by-default `upload_spike` dispatch input to `phase0-build.yml`, separate
from the existing Node-only `upload_module`. Before S7, the operator must confirm that
D3's private artifact exception extends to the web core plus page (three-day retention),
and provide a desktop with Node >=18, gh and a local copy of the ISO/reference trace.
The ISO is currently verified only on the VPS; Chromium is forbidden there. No web-core
artifact upload or real-disc browser run has been performed by S6. No public deployment:
the ~87 MB WASM exceeds Pages' 25 MiB per-file limit. S7's planned `upload_wasm=true`
command must use `upload_spike=true` in this repository. Rebuild the native reference at
the spike's commit before claiming same-commit browser parity.

**Status 2026-09-30 evening.** `upload_spike` has now been used: run `36753728272` on `main`
(`workflow_dispatch`, job 7m18s) uploaded `melee-spike-dist` (4,669,739 bytes compressed,
expires 2026-10-03). It contains `spike-core/melee_core_web.wasm` at **16,323,255 bytes** —
the **web** module at `-Oz`, which is the number `docs/PHASE0_DEPLOY_PLAN.md` §0.3 listed as
unverified — and `spike-core/core.json` = `{"commit":"4fba3a080af6f205cc6107ada7baefeb0315cae0","opt":"-Oz"}`.
So the reason Q8 gives for "no public deployment" (an ~87 MB module over Pages' 25 MiB
per-file limit) **no longer holds**: the module is now under the limit. What still stops a
deployment is O1 in `docs/PHASE0_DEPLOY_PLAN.md` — the operator's legal judgement on
publishing game-derived code — not the size.

## Q9 — Which device measures Phase 0 — **ANSWERED 2026-09-30**

`docs/SPEC_PIANO.md` step 8 and `docs/PHASE0_TASKS.md` D5 want a mid-range Android: without
that row there is no go/no-go, and `docs/PHASE0_DEVICE_PLAN.md` §0.2 says so explicitly.

**Answer: only an iPhone is available.** The measurement therefore proceeds on iPhone Safari
and counts as the **iOS row** (`docs/PHASE0_DEVICE_PLAN.md` M3, informative), not as the
Android row. What that does and does not settle:

- a **NO-GO on the iPhone** closes the mobile target by strong inference (a recent iPhone is
  usually faster than a mid-range Android) — an inference, not a measurement;
- a **GO on the iPhone does not** close the Android row, and the spec's go/no-go stays open;
- M1 (Chrome on a desktop) is still wanted and is unaffected: it is the easiest end of the
  chain and the desktop row of the verdict.

**Not blocking**: the tailnet test path (D in `docs/PHASE0_DEPLOY_PLAN.md` §2) needs no
Cloudflare credentials, so the iPhone run can start before Q3/O1 are answered.

## Q10 — The renderer after step 1: where frames come from, who owns the device, when a frame is shown

Raised 2026-10-01 by the WebGPU step 1 branch (`render/webgpu-step1`). Step 1 itself is not blocked
by any of the three: it presents the frame's EFB copies and clears, and each choice below was made
the smallest way and is reversible. Step 2 (draws) is blocked by (a), and (c) decides whether a real
run shows more than its last frame.

**(a) Where the web build's frames come from.** Before the spike below, the shipped modules did not compile
`port/runtime/gx/gx_core.cpp` at all: `native/core_sources.cmake` puts `native/headless_fifo.cpp` in
its place, a decoder that consumes the FIFO's bytes and drops everything a renderer needs
(`headless_fifo.cpp`, "Replaces vertex decoding, texture snapshots and draw observation").
`gx_core.cpp` is compiled only in `wasm/core/CMakeLists.txt`'s `runtime_core` compile gate, which
links into nothing. Step 1 records EFB copies in `headless_fifo.cpp` behind a null-by-default
backend pointer. Draws need far more of `gx_core.cpp` (`decode_vertices`, XF/CP state, texture
snapshots). Options:

1. Link `gx_core.cpp` into the web module in place of `headless_fifo.cpp`. One decoder, the port's
   own; but it is a change to the simulation path (it writes guest memory at the XFB copy, takes
   texture snapshots through `ppc::watch_ram_range`, logs), its link closure (`render_observer`,
   `native_pose_bridge`, `slippi_online`, the settings boundary of patch 0007) has never been linked
   here, and the 2400-checkpoint comparison would have to pass again before anything else.
2. Keep growing `headless_fifo.cpp`'s recording, display-only, one priority at a time. The
   simulation path never changes; but it duplicates `gx_core.cpp`'s decoding and can drift from it.

**Option 1 implementation spike — 2026-10-02, `spike/renderer-real-decoder` (not for merge).**
The operator selected the real decoder, shared across the native oracle and both WASM modules.
`native/core_sources.cmake` now selects `gx_core.cpp`, `gx_texture.cpp`, `render_observer.cpp`,
`native_pose_bridge.cpp` and `native_draw_audit.cpp`; the old empty `RenderObserver` definitions
are removed. The upstream native header directory supplies `PackedAnimation.h` to the pose types.
`native/real_fifo.cpp` forwards host FIFO writes to `gx::write_fifo`; a stable forwarding backend
initializes GX once and allows WebGPU to detach during submission without resetting GX state.
The native and Node targets still have no presentation backend, but now perform real decoding
and capture. This does not implement draw rasterization in the step-1 WebGPU backend.

The offline service boundary supplies empty online overlay names (no online match), ignores the
patch-0007 desktop Settings UI notification, and supplies default diagnostic `TickTiming`.
The guest Settings memory write remains in the real decoder; Slippi EXI fatal guards remain.
Neither the decoder's guest reads/writes nor its texture RAM watches have been bypassed.
`native_fifo_test` is unchanged and still tests the legacy decoder, **not** this new path;
its passing would not establish real-decoder correctness. No CI check or link error flag is relaxed.

**Source-level stopping point, not a measured CI result:** the real observer calls
`gx::authored_stats()` (e.g. `port/runtime/gx/render_observer.cpp:93` at upstream pin `3aab717`).
Its definition lives in `authored_pose.cpp:15`, which also calls `NativeMelee::SamplePacked` and
`SubFrameSolver::{interpolate_matrix,extrapolate_matrix}`. The latter definitions live in
`subframe.cpp`, which unconditionally includes `<windows.h>` and contains a solver thread pool.
Thus adding the observer is not a self-contained link closure: it needs a further statistics
boundary extraction or additional authored/subframe porting. Per the operator's stop rule,
this branch stops here: no statistics stub, no additional porting, no linker suppression.
`authored_pose.cpp` is deliberately not selected; unresolved `gx::authored_stats()` is expected
at executable link, unless an earlier compilation failure prevents reaching it. Other compiler
or linker failures remain possible and have not been measured.

**Compilation/link evidence:** none for this spike at handoff. No compiler, Node, game run or
ISO extraction was invoked on the VPS. The worktree's submodule is uninitialized; source review
used GitHub's contents API at the exact pinned commit, without populating/modifying the submodule
or touching the other agent's checkout. The existing `gx_core.cpp` header comment remains true
and needs no patch; `headless_fifo.cpp` now identifies its legacy-test-only role.
Commit/push/PR are the handoff: CI is neither polled nor declared successful. The parent session
owns CI diagnosis and, if executable artifacts become available, the 2400-checkpoint native/web
comparison **from the same commit**. No parity result or final experimental verdict is asserted.

**(b) Who owns the GPU objects.** The brief for step 1 asked for a backend that owns the instance,
adapter and device. In step 1 the worker acquires them in JavaScript (`web/src/spike/gpu.ts`) and the
C++ backend reaches them through `EM_JS` (`wasm/render/gx_webgpu.cpp`). Reason: `requestAdapter` and
`requestDevice` resolve only after the event loop turns, the simulation is one synchronous
`callMain`, and Asyncify is ruled out for the simulation path (`docs/AGENT_RULES.md`). The other
option is `<webgpu/webgpu.h>` with `--use-port=emdawnwebgpu`, which still needs the device acquired
before `callMain` and imported into C++. Both of its unknowns are now measured: the port builds, links
and renders (PR #47), and it adopts the device JavaScript acquired (PR #52) — see the two paragraphs
below. The choice between the two paths still belongs to the operator.

**(c) When a frame reaches the screen.** A canvas transferred to a worker is committed when the
worker's task ends, and a run is one task, so a `?canvas` run shows only its last frame. Showing
every frame needs either the simulation to return to the event loop once per retrace (a change to
how the core is driven, not to the renderer) or a presentation thread fed with frames over shared
memory (the module is built `MELEE_SINGLE_THREAD=1` today). Not needed to prove step 1; needed for
anything a player would look at.

**(b), probed 2026-10-01 — PR #47, runs `36912403273` and `36920684654`.** The first half of (b) is
answered: the pinned Emscripten (4.0.23) compiles and links a unit that includes `<webgpu/webgpu.h>`
and calls into it with `--use-port=emdawnwebgpu`, and the browser this repository's CI can run gives
the renderer a device it can render with — a texture cleared to red reads back `[255,0,0,255]` under
`google swiftshader`, in a worker, with `--enable-unsafe-swiftshader --enable-unsafe-webgpu` (run
`36920684654`). What was still open at that point is the part this decision turns on: whether that port
can *adopt* a device acquired in JavaScript, since the simulation is one synchronous `callMain` and the
device has to be acquired before it. That probe created an instance of its own and did not attempt the
import (`wasm/probe/webgpu_probe.cpp` said so at the time), so the choice between `EM_JS` and
`<webgpu/webgpu.h>` was left to the operator, with the toolchain risk removed from it. PR #52 measured
the import; the answer is in the paragraph below.

**(b), the import measured 2026-10-02 — PR #52, runs `36932059429` and `36932059473`.** The open half of
(b) is answered, and the answer is yes: C++ adopts the device JavaScript acquired. The pinned port
declares the import: `webgpu/include/webgpu/webgpu.h:2265` exports the getter `emscripten_webgpu_get_device`,
which reads `Module['preinitializedWebGPUDevice']` in `webgpu/src/library_webgpu.js:647-660` of the
package Emscripten 4.0.23 pins, and `wasm/probe/webgpu_probe.cpp` uses it on a device the page acquired
before instantiating the module — exactly the order the real backend needs. It asks the adopted device
for its queue, reads its limits (`maxTextureDimension2D 8192`), creates a 1x1 RGBA8 texture with it and
writes a red pixel through the adopted queue. In the `WebGPU toolchain probe` job of run `36932059429`
headless Chromium 153.0.8010.12, adapter `google swiftshader`, 1m26s, commit `9ab7f53`: **both** launch
configurations answer `adopt: {"device":true,"queue":true,"limits":true,"wrote":true}`, with
`adopt_device_lost: null` and `adopt_errors: []`. `wasm/probe/check.mjs` requires all four of those, so
a rejected command — which raises a validation error and neither throws nor stops the run — cannot read
as an answer.

**What the adoption measurement did not cover — closed 2026-10-02, PR #55, run `36955231521`.** The
module was instantiated on the page in that probe, while the renderer's module is instantiated in the
worker, `web/src/spike/worker.ts`: what was measured was the import mechanism, not that mechanism in the
realm of the worker, and "the mechanism is a module argument read before instantiation and does not
depend on the realm" was reasoning, not a measurement. The probe's worker now asks the same question of
its own realm (`wasm/probe/webgpu_probe_worker.js`): it hands the device it acquired for the canvas to a
module instantiated in the worker, before the canvas step whose commit is where CI's Chromium loses the
device, and both launch configurations answer
`adopt_worker: {"device":true,"queue":true,"limits":true,"wrote":true}` in headless Chromium 153.0.8010.12,
adapter `google swiftshader`, realm `DedicatedWorkerGlobalScope` — adopted at 42.5 ms (default
configuration) and 47.3 ms (full build), with the device lost at 44.9 ms and 70.3 ms, so the adoption was
measured on a live device and not on one the canvas commit had already killed. The module is compiled with
`-sENVIRONMENT=web` and loads and runs in the worker unchanged, so the renderer needs no new link flag for
this. Unchanged from part c of this question and from PR #47: the Chromium of this CI loses the device when
the canvas frame is committed, in both realms, so the canvas pixel stays a real-device measurement, and no
CI runner can produce a game frame at all without the disc.

**What is left for the operator.** The choice between `EM_JS` and `<webgpu/webgpu.h>`, with both of its
unknowns measured instead of assumed: the toolchain builds, links and renders a WebGPU unit in PR #47,
and the port can adopt the device the page acquired in PR #52 — in the realm of the page and, since
PR #55, in the realm of the worker the renderer's module is instantiated in. `EM_JS` is what step 1 shipped in
`wasm/render/gx_webgpu.cpp`, so keeping it is the zero-change option; adopting the device instead
would make the backend own the instance, adapter and device, and is now known to be possible.
