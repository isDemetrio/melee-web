# Renderer map — pinned 0.8.1

Source root: `upstream/melee-unlocked`, commit `3aab7172db243c159afa76ecb2c564b3de8e4c0a`. Paths below are relative to that root. Replacement priorities describe proposed implementation work; no WebGPU backend or browser parity is established by this checkout.

## Interception level: GX hardware command stream

The static recomp executes the game's GX SDK code and consumes its FIFO writes. It does **not** HLE the SDK's GX draw/state functions.

| Evidence | What it establishes |
|---|---|
| `port/runtime/ppc/ppc.h:170–218` | Stores to guest RAM use endian helpers; non-RAM stores enter `mmio_write`/`mmio_write64` |
| `port/runtime/host/host.cpp:1047–1061` | `host::mmio_write` recognizes `(addr & 0xFFFFC000u) == 0xCC008000u`; calls `gx_write(value, bytes)`, which calls `gx::write_fifo` |
| `port/runtime/gx/gx_core.cpp:629–648,683–746` | `parse_command` decodes CP load `0x08`, XF load `0x10`, indexed XF `0x20/28/30/38`, display list `0x40`, BP load `0x61`, primitive opcodes; `write_fifo` appends big-endian bytes and parses complete commands |
| `port/runtime/gx/gx_core.cpp:260,607` | `decode_vertices` resolves vertex descriptors/arrays; `run_display_list` reads guest-memory command bytes |
| `port/recomp/hle_list.txt` | SDK HLE override list has no GX or VI overrides; OS/PAD/DVD/EXI/audio/CARD are different boundaries |
| `port/runtime/gx/gx_core.h` (`write_fifo_bytes`), `gx_core.cpp:746` | Source-port path can feed the same FIFO decoder in bulk. Private `0xF0/0xF1` diagnostic/ownership tokens are source-port additions, not GX hardware commands |

This is hardware-command **decoding into captured draw state**, not a claim of cycle-accurate Flipper emulation. GX FIFO ingestion must survive even in a headless build: BP processing also handles PE completion/tokens and frame boundaries.

## Exact CPU-state → backend interface

All paths in this section are under `port/runtime/gx/` unless stated otherwise.

| Type / entry point | Data or dispatch contract | Evidence |
|---|---|---|
| `CPMemory`, `XFMemory`, `BPMemory`, `VertexDesc` | CP vertex descriptors/VAT/arrays, XF transform registers, BP TEV/texture/raster registers; decoder owns live state | `gx_regs.h`; `VertexDesc` is in `gx_core.cpp:153`; globals and `decode_vertices` |
| `Vertex` | Packed 108-byte decoded vertex: position, normal, two RGBA8 colors, eight float2 UVs, position and texture matrix indices | `gx_core.h:23–37`; backend input layout `gx_d3d12.cpp:1038–1058` |
| `DrawSegment`, `append_segment_indices` | Keep individual primitive boundaries within batches; convert quads, triangles, strips, fans and line lists/strips to indexed triangles/lines | `gx_core.h:66–106` |
| `DrawCall` | Primitive/ranges/components; copied `BPMemory`; position/normal/post matrices; 8 light blocks; `xf_regs[0x58]`; matrix indices; signed TEV colors/kcolors; 8 textures; draw identity/pose; optional cached backend pipeline pointer + ownership generation | `gx_core.h:107–150` |
| `TextureRef`, `TextureSnapshot` | Guest address/size/format/TLUT/sampling/mips and shared immutable byte snapshot; renderer must not consult changing guest RAM | `gx_core.h:44–51`, `texture_snapshot.h`, `gx_core.cpp` texture capture |
| `EfbCopy` | Destination address/stride; source rectangle; format, XFB/clear/intensity/half-scale/depth flags; clear color/Z and Y scale | `gx_core.h:160–166` |
| `FrameCommand`, `Frame` | Ordered Draw/Copy commands indexing arrays of draws/copies; vertex/segment buffers; sequence, timing, scene metadata and discontinuity flag | `gx_core.h:168–202` |
| `DrawMatrices` | Optional per-draw position/normal matrix override and replacement vertex pointer for subframe rendering | `gx_core.h:153–158` |
| `Backend` | Pure virtual `submit_frame(const Frame&)`; overload with `DrawMatrices*`; `submit_and_recycle(Frame&)`; `set_skip_present`; virtual resize, options, stats, profile, deadline/wait methods | `gx_core.h`, `struct Backend` |
| `gx::init(Backend*)` → `submit_and_recycle` | Core records frame, hands it to backend at XFB copy; null backend supported | `gx_core.cpp:577`; `port/app/main.cpp:1428–1457` |
| `create_render_backend(void* hwnd, int client_w, int client_h, const RenderOptions&)` | Windows factory selects `RenderApi::D3D11`, otherwise D3D12; falls back to D3D12 if explicit D3D11 creation fails | `gx_backend.cpp:28–39`; `gx_backend.h` |
| `render_options`, `render_resize`, `render_stats`, `render_profile_line` | Backend-neutral wrappers invoke virtual methods; no D3D downcast | `gx_backend_dispatch.cpp:6–27` |
| `create_d3d12_backend`, `D3D12Backend::submit_frame` | Concrete backend creation; consume frame command sequence; `execute_draw`, `execute_copy`, `clear_efb`, `present_efb` implement replay | `gx_d3d12.h`; `gx_d3d12.cpp:1689,1845,1854,1923,2394` |
| `make_vs_uid`, `make_ps_uid`; `VSUid`, `PSUid` | Specialization keys derived from draw's components/XF/BP state; motion-vector mode is also part of shader identity | `gx_shader.h:53–72`; `gx_shader.cpp:163–205` |
| `VSConstants`, `PSConstants`, `fill_vs_constants`, `fill_ps_constants`, `vs_constants_bytes` | Per-draw projection, lighting, matrices, TEV constants, alpha refs, texture dimensions, indirect matrices, fog/Z and presentation flags; conditional VS upload size | `gx_shader.h:10–50,84–85` |
| `texture_level_bytes`, `decode_texture`, `hash_bytes` | Backend-neutral CPU texture decoder/hash; output RGBA8 | `gx_texture.h`; `gx_texture.cpp:54–131` |

Do not use legacy `d3d12_resize`/`d3d12_stats` downcast helpers for a new backend (`gx_d3d12.cpp:2856–2860`); use neutral wrappers. A WebGPU backend can implement `Backend` without altering the generated guest ABI.

## Shader specialization and pipeline lifetime

`gx_shader.cpp:163–205` constructs normalized UIDs: shader-relevant vertex/XF and BP fields are retained, while unused state is removed from specialization. `generate_vertex_shader` (`:208`) emits HLSL transform/lighting/texgen code. `generate_pixel_shader` (`:394`) emits TEV stage operations, including indirect texture lookup/coordinate adjustment (`:448+`), color/alpha combiners (`write_tev_regular`/`write_tev_compare`, `:356–393`), alpha testing and fog. TEV constants remain per-draw uniforms. A WGSL generator must preserve these numerical operations and state choices; merely replacing HLSL syntax does not prove matching integer shifts, wrapping, rounding or matrix conventions.

`gx_d3d12.cpp` separates shader identity from fixed-function state:

- `PsoKey` combines VS/PS hashes with blend, Z mode, cull, pixel-format, topology and motion-vector variant. `PipelineRecipe` retains reconstructible game-side pipeline inputs; `get_pso` derives keys/recipes (`:1279–1329`).
- `describe_pipeline` (`:1036–1114`) defines the 108-byte vertex layout, blend factors/subtract, RGB/alpha write masks, EFB destination-alpha handling, culling and reversed-depth compare mapping. Targets are RGBA8 + D32; the motion-vector variant adds RG16F and R8 targets. Logic operations are explicitly ignored here; do not promise full GX hardware logic-op parity.
- `build_pso` (`:1116–1150`) looks up/compiles HLSL with `D3DCompile` (`vs_5_0`/`ps_5_0`), loads from `ID3D12PipelineLibrary`, otherwise calls `CreateGraphicsPipelineState` and stores it.
- `psos_`, `vs_blobs_`, `ps_blobs_` hold resident objects. `DrawCall::cached_pipeline` is guarded by `cached_pipeline_owner`; `get_pso` includes backend generation/motion-vector variant in the owner identity (`:1280–1295`). Never carry an old pipeline pointer into a recreated device.
- Disk caches contain compiled blobs, a serialized D3D12 pipeline library and state recipes (`:2701–2835`). `port/CMakeLists.txt:458–467` hashes `gx_shader.cpp`, `gx_shader.h`, `gx_d3d12.cpp` into `GX_SHADER_CACHE_VERSION`. Cache writing/reading includes size/integrity checks; recipes can be merged across shader-version directories.
- `prewarm_fallback_psos` (`:1256–1276`) builds generic raster-state variants at startup. `prewarm_pipelines` (`:2715–2769`) reads/merges recipes, deduplicates, queues both ordinary and motion-vector variants and integrates completed work before guest startup. A generic position/color/texture-0 pipeline covers newly encountered draws until exact shading is ready (`:1181–1254`). Current submission sets `pso_wait_budget_us_ = 0` (`:2456–2460`); older tracker descriptions of skipped draws/bounded waits are not the current steady-state policy.

For WebGPU, persist portable recipe/state data and regenerate WGSL/pipelines; the D3D blob/library format is not a cross-backend cache. Browser-specific persistent pipeline binary access is **unknown — needs investigation**; this source has no such implementation.

## WebGPU implementation order

This is a proposed order derived from the existing call/data dependencies. “Parity” below means baseline D3D raster path; optional vendor features are listed separately.

| Priority | Required work | Reference / boundary |
|---|---|---|
| 1 | Implement `Backend`, factory selection and canvas/device initialization; replay ordered `FrameCommand`s. Preserve null/headless path and frame ownership/recycling | `gx_core.h`, `gx_backend_dispatch.cpp`, `gx_d3d12.cpp:2394+` |
| 2 | Vertex/index uploads, exact packed-layout interpretation, primitive conversion, projection/XF matrices, lighting, texgen, viewport/scissor, cull and reversed depth | `gx_core.h:23–37,73–105`; `gx_shader.cpp:208+`; `gx_d3d12.cpp:1036–1114,1689+`. Repack unsupported vertex attribute formats if necessary; audit device limits |
| 3 | TEV WGSL specialization and uniform/bind-group layout, signed integer combiner behavior, alpha test, blend/write masks, destination-alpha and fog/Z semantics | `gx_shader.h`, `gx_shader.cpp:356+`, `describe_pipeline`. Validate WGSL alignment against C++ buffers; do not memcpy unverified layouts |
| 4 | Eight texture/sampler slots, texture/TLUT snapshots and all existing CPU formats: I4/I8/IA4/IA8/RGB565/RGB5A3/RGBA8/C4/C8/C14X2/CMPR; mips, wrap/filter/LOD and invalidation | `gx_texture.cpp:54–131`, `texture_snapshot.h`, `TextureRef`, D3D texture/sampler caches |
| 5 | Persistent EFB color/depth, ordered EFB copies and clear semantics, address-keyed copy textures, half-scale filtering, XFB presentation/aspect/resize. Copy commands cannot be dropped with a skipped presentation | `gx_d3d12.cpp:1845–1922`; `threaded_backend.cpp:148–154` |
| 6 | Asynchronous pipeline jobs, startup recipe prewarm, generic fallback, cache/device generations; GPU-safe upload/resource retirement and loss/recreation handling | D3D job system below; `Ring` and frame garbage/descriptor rotation in `gx_d3d12.cpp`. Browser device-loss behavior itself: unknown — needs investigation |
| 7 | Per-frame image comparisons and command/texture/geometry tests across menus, effects/reflections, transitions, resize and backlog drain | `port/tests/{draw_batch_test,texture_snapshot_test,gpu_resource_test,backend_dispatch_test}.cpp`; `tools/diff_captures.py`, `tools/validate_native.py` |

Defer authored subframes (`subframe.*`, `authored_pose.*`, `render_observer.cpp`), motion-vector targets/upscaling, SSAA/sharpening and cosmetic/video/UI overlays until baseline output matches. Defer Streamline/DLSS/NGX/XeSS and DXR entirely from the initial browser backend. These are separate from guest simulation. `execute_copy` currently creates RGBA8 GPU copies of EFB color (`gx_d3d12.cpp:1854+`); despite richer `EfbCopy` fields, full format/depth-copy hardware fidelity is not established. Exact requirements beyond the implemented D3D behavior are **unknown — needs investigation**.

## Async and worker seams

| Existing seam | Current synchronization/ownership | Proposed WebGPU mapping |
|---|---|---|
| `D3D12Backend::{PsoJob,PsoResult}`, `pso_jobs_`, `psos_pending_`, `pso_done_` | `get_pso:1298+` queues a missing draw's job ahead of prewarm work; workers receive copied UIDs/recipe/state | Start `createRenderPipelineAsync` for each unique key, keep a pending set, render with prebuilt generic pipeline |
| `pso_worker:1152–1166` → `integrate_compiled_psos:1168–1178` | Worker compiles outside render cache ownership; result queue transfers ownership; renderer publishes objects and clears pending entry | Promise completion queues a result for renderer-owned integration; never synchronously wait on UI thread |
| `prewarm_pipelines:2715–2769` | Batch jobs plus startup progress, ordinary/motion-vector variants | Async startup phase with recipe progress; allow first simulation tick only at chosen readiness point |
| `ThreadedBackend`, `FrameQueue` | Simulation submits snapshots; worker owns window/renderer; backlog frames execute copies/clears without presentation; recycle buffers (`threaded_backend.cpp:32–35,125–154,317–357`) | WASM simulation worker and render event loop, with messages or shared memory. Preserve lifetime and ordered command drain; SAB is a design choice, not current browser code |
| `TextureSnapshot`, RAM write generations | Immutable texture bytes leave simulation with frame; render thread does not read live guest memory | Preserve snapshot/ownership model across workers, including stale-frame disposal |
| D3D `Ring`, fences and frame garbage | Upload pages/resources remain alive until frame slot GPU work completes (`gx_d3d12.cpp:138+`) | WebGPU submission-completion retirement; pipeline readiness and GPU completion are distinct events |

The source already separates simulation frames from pipeline compilation and presentation. Remaining browser scheduling, WGSL correctness, float parity and performance are **unknown — needs investigation**; none were executed as part of this source map.
