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

**Phase 0 asks for a subset of this, and only the subset blocks the go/no-go.** The Phase 0
deploy plan needs the ten items O1–O10 of `docs/PHASE0_DEPLOY_PLAN.md` section 3 and nothing
else: the O1 decision, a Cloudflare account with R2, a private bucket, S3 keys scoped to it for
one upload, the Pages API token and account ID, an Access application over the preview address,
two Pages preview variables, the R2 binding, an optional Access service token for the agent, and
the exact Android model. No domain, no TURN, no Supabase — those belong to the product's online
play, not to the spike. That table is the ask for Phase 0; the paragraphs below are the wider one.

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

- browser-to-browser determinism: **measured 2026-10-03, and the candidate was real.** The
  arm64 job of the WASM probe runs the x86-built module under Node on aarch64. Run
  37097105278: 3,040 of the 8,000,000 corpus results differed between WASM-x86 and
  WASM-arm64, every one of them `nan-sign`, every one of them an invalid operation with no
  NaN operand (`0 * inf`, `inf - inf`) -- the NaN bit pattern the specification leaves to the
  engine, where ARM's default NaN is positive and x86's is negative. `wasm/compat/fma.h` now
  pins that result to the reference's indefinite `0xFFF8000000000000`, so the module gives the
  same bits on either engine; run 37101091371 re-measured 0 divergent and two identical
  digests (`wasm/README.md`, next measurements 2; `docs/PORT_CHANGES.md`, "The
  invalid-operation NaN is pinned to the reference's value").
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

**Texture follow-up — 2026-10-02 (`render/webgpu-textures`, draft, unverified).**
`wasm/render/gx_webgpu.cpp` now binds eight independent textures/samplers through an explicit
WebGPU layout. It reads only `TextureRef::data` image/TLUT snapshots and calls the existing
`gx::decode_texture` for I4/I8/IA4/IA8/RGB565/RGB5A3/RGBA8/C4/C8/C14X2/CMPR. All are
CPU-repacked to linear RGBA8; CMPR is decompressed, not uploaded as BC1. Each recorded mip is
decoded with tiled byte offsets and uploaded separately. Wrap (including reserved wrap=repeat),
min/mag/mip filters and LOD clamps follow pinned `gx_d3d12.cpp:1613–1648`; signed bias /32
is supplied to WGSL `textureSampleBias` because WebGPU samplers have no bias field. Inverted
LOD clamps and invalid snapshots fail attachment's draw path rather than being approximated.
No new cache: snapshots are uploaded per segment and textures destroyed after queue completion;
image/palette/address reuse therefore cannot preserve stale data. This is deliberately costly.

Only slot 0 is sampled, using raw UV0 and vertex-color MODULATE, including alpha. Other slots
are bound for future priority 3 shaders, **not** claimed to participate in TEV. Full TEV,
lighting/texgen, EFB-copy texture lookup, anisotropy overrides, DLSS bias, replacement packs,
cache performance and device recreation remain open. The existing headless/native/Node paths
and simulation sources are unchanged.

`web/tests/spike/render.spec.ts` adds actual GPU readback assertions for all eleven formats,
MODULATE, same-address/hash image and TLUT replacement, forced mip 1, clamp/repeat/mirror and
linear magnification across a tile boundary. These fixtures bind all eight slots, but establish
pixel semantics only for slot 0. **None were run in this session.** Build/CI, browser/GPU output,
preview, actual-game appearance and 2400-checkpoint parity are unverified (parity is reserved
for the parent session). Signed bias, derivative-driven minification, trilinear mip transitions,
rectangular chains, non-RGB565 TLUTs, CMPR transparent mode and nonzero palette indices still
need dedicated pixel fixtures. Hardware sampling/rounding agreement with D3D is not established.
This entry supersedes the earlier statement below that priority 4 is wholly absent; it does
not establish priority 4 as validated or complete.


**Geometry follow-up — 2026-10-02 (`render/webgpu-geometry`, draft, unverified).**
`wasm/render/gx_webgpu.cpp` now consumes Draw commands with verified packed offsets,
upstream primitive conversion, XF/projection, vertex colors, scissor, culling and reversed
D32 depth. Slot 0 is a neutral white 1×1 texture. Culling follows framebuffer-clockwise
`FrontCounterClockwise=FALSE` in D3D and [WebGPU frontFace](https://www.w3.org/TR/webgpu/#enumdef-gpufrontface).
The synthetic geometry readback tests in `web/tests/spike/render.spec.ts` distinguish a
transformed green triangle from clear-only output and test occlusion/scissor/culling.
These tests have **not been executed** in this implementation session.

Priority 2 is still partial: lighting/channel controls and texgen are absent; normal and
second-color outputs do not yet contribute to the fragment color. Lines lack a pixel fixture.
Perspective/inverted viewports, clip edges, normal/matrix-index coverage and real game captures
remain unverified. Priority 3 (exact TEV, blend/write masks, alpha test, destination alpha,
fog/Z) and priority 4 (eight actual texture/sampler slots and snapshot decoding) remain open.
Whole-EFB clears, copy fidelity, pipeline/cache lifetime across device recreation and submission
cost also remain open. Compilation, CI, preview, GPU execution and 2400-checkpoint parity are
not claimed; parity belongs to the parent session. See the final PROGRESS entry for limits.

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

**Follow-up source review — 2026-10-02, observer required; diagnostic closure supplied.**
At upstream pin `3aab717`, `gx_core.cpp` directly calls `observed_draw_identity` (457),
`observed_owner` (465), `observed_skinned` (470), `capture_authored_pose` (471), and
`finish_observed_frame` (580). These affect draw metadata/capture and frame bookkeeping;
removing the observer would not be a valid source-set reduction. `gx_texture.cpp` has no
observer reference, and `native_draw_audit.cpp` does not require it either: the dependency
comes from the decoder itself, independently of native draw auditing.

`authored_stats()` is also called directly by `gx_core.cpp` (473–476, 822–823), not only by
`render_observer.cpp`. Its definition in `authored_pose.cpp:15` simply returns a static
`AuthoredStats`: atomic counters declared in `authored_pose.h:70–81`. Every use in the
selected decoder/observer sources increments a capture, rejection, feature or draw count;
none reads a counter to decide a draw, pose or simulation outcome. For example, the observer
increments `capture[1]` after the capture eligibility condition has already failed. The
condition and return remain unchanged. These are diagnostic counts, not solver state.

`native/offline_authored_stats.cpp` supplies the same static counter storage for the shared
native/Node/web offline source set. It retains actual increments rather than fabricating
zero statistics; it performs no animation sampling and has no simulation/drawing side effects.
The upstream `authored_pose.cpp` stays excluded, so there is exactly one selected definition.
No upstream modification or numbered patch is needed: this is an offline host implementation
of the existing declaration. Observer capture, guest reads/writes, texture RAM watches,
`native_fifo_test`, and all CI/link checks remain unchanged.

The known `authored_stats` symbol dependency is now supplied at source level; executable link
success is still unmeasured. Bringing in the full sampler would instead require
`port/runtime/gx/authored_pose.cpp`, `NativeMelee::SamplePacked` and
`SubFrameSolver::{interpolate_matrix,extrapolate_matrix}` from `port/runtime/gx/subframe.cpp`,
including its unconditional `<windows.h>` and solver thread pool. That would be a separate
porting task; it is neither required for counter storage nor attempted here.

**Link and parity evidence — 2026-10-02, the experiment is measured.** The link closure compiles and
links: on branch `spike/renderer-real-decoder` the `Phase 0 — Linux headless reference (offline)` job
(run `36999621064`) and the `Phase 0 — WASM core` job (run `36999621081`) both completed green, so
the real decoder builds for the native reference and for the web module from the same commit. Both
were then dispatched with their opt-in private artifacts (`37000659238` → `melee-core-headless`,
`37000662755` → `melee-core-wasm-node`) and run **on the operator's own disc** with
`scripts/phase0/run_checkpoints.sh` and the project's `parity_vs_onett.txt` script, 2400 retraces:

| Run | trace SHA-1 | final scene |
| --- | --- | --- |
| native, real decoder | `c79c53b9cdf81426fa0277e7497a69e55bc5f571` | `mode=2 state=2 match_frame=762` |
| web module, real decoder | `c79c53b9cdf81426fa0277e7497a69e55bc5f571` | `mode=2 state=2 match_frame=762` |
| reference of 2026-09-30, legacy decoder | `c79c53b9cdf81426fa0277e7497a69e55bc5f571` | `mode=2 state=2 match_frame=762` |

All three traces are 2401 rows and `diff` reports **no differing line**. The real decoder therefore
does not change the simulated state: the parity guarantee that the legacy decoder made possible
survives the substitution, and it survives it for the same reason on both sides — the comparison is
between the web module and the native reference **of one commit**, both now on the real decoder, and
it is *also* identical to the trace taken before the substitution. `native_fifo_test` still exercises
the legacy decoder only and is not evidence for this path; no CI check, guest read/write or texture
RAM watch was relaxed to reach this point. Option 1 is adopted.


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

## Q11 — The repository is public — **raised 2026-10-04, needs the operator**

`gh api repos/isDemetrio/melee-web --jq .visibility` answers `public` (`private: false`), and the
same endpoint **without a token** answers `200`: this repository is world-readable. Five places
asserted the opposite until 2026-10-04 — `docs/AGENT_RULES.md` ("CI budget", and rule 1's "the repo
is private"), `.github/workflows/ci.yml`'s trigger comment, the comments in
`web/playwright.spike.config.ts` and `web/tests/unit/spike-config.test.ts` that read their measured
runner-minutes as a share of a "2,000-minute monthly allowance", and
`scripts/check_no_game_data.py`'s "the repository is private" — while `wasm-probe.yml`'s arm64 job
already relied on the repository being public (PR #88). The contradiction was found by a cron
session while looking for the next autonomous step; nothing has failed because of it.

**What is not in question.** `isDemetrio/melee-orig-dol` is private (checked the same day, Q2), no
game data is tracked here (`python3 scripts/check_no_game_data.py --all`: 264 tracked files, clean),
and the compiled core stays in Actions artifacts that are off by default and expire after
three days (D3; what that protects is measured at the end of this entry). Nothing found so far
looks like an unintended exposure of Nintendo's data.

**What needs an answer.**

- **Is `public` intended?** If it is, the consequence already recorded is the CI budget: the minutes
  are free (the corrected section of `docs/AGENT_RULES.md`, checked against GitHub's billing
  documentation), and the plan's remaining decisions are unchanged.
- **If it is not**, the visibility is the operator's to decide. This account has `admin` on the
  repository, but a worker session does not change the visibility of the project's repository on
  its own initiative.
- **It bears on O1** (`docs/PHASE0_DEPLOY_PLAN.md` section 2). O1 asks for the operator's legal
  judgement on publishing game-derived code, and it was written as a question about the deploy of
  the spike page. The repository's source is published already, so the exposure O1 reasons about is
  wider than the deploy it was written for. That does not answer O1 and it is not a legal opinion;
  it is a fact the decision should be taken with.

**What a "private" artifact protects here — measured 2026-10-04.** D3 calls the uploaded build
products private and this entry repeated it. On a public repository that word needs its measured
limits, because those artifacts carry game-derived code (`melee-core-headless`,
`melee-core-wasm-node`, `melee-spike-dist`).

- **World-readable, with no credential at all**: `curl
  https://api.github.com/repos/isDemetrio/melee-web/actions/artifacts` answers `200` without a
  token, and so does the single-artifact endpoint — the name, size, expiry date and the workflow
  run behind every artifact, `total_count` 601 at that moment, the three above included. The run
  page (`https://github.com/isDemetrio/melee-web/actions/runs/37169339350`) answers `200` too.
- **Not world-readable**: the archive. The same request with `/zip` appended answers `401` with
  `{"message": "Requires authentication"}`, and the run-log API answers `403`. No anonymous
  visitor can download anything.
- **What that leaves**: a credential. GitHub's REST documentation for the artifact endpoints says
  "Anyone with read access to the repository can use this endpoint"
  (`docs.github.com/en/rest/actions/artifacts`, read 2026-10-04; the download endpoint's own
  revision carries the same sentence,
  `docs.github.com/en/enterprise-server@3.4/rest/actions/artifacts`), and read access to a public
  repository is held by every GitHub account. GitHub staff state the authentication requirement is
  deliberate (`github.com/actions/upload-artifact/issues/51`, "Currently it's by design"), and
  that thread has a non-collaborator downloading a public repository's artifact with a token that
  grants it nothing else. **Not measured from here**: a download with a credential that is not a
  collaborator's — this VPS holds only the operator's own token, so that last step is
  documentation and a third-party report, not this session's measurement.

**What follows from it.** The three-day retention and the off-by-default switch are unchanged and
are the only bounds these artifacts have. What they are not is an access control: here, "private
artifact" means "not anonymous", not "collaborators only". That is a fact O1 should be taken
with, and it is why Q8's "private artifact exception" is worth re-reading — an exception granted
for a private repository's artifact is weaker on this one than it was when it was granted.
