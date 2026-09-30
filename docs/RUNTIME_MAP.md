# Runtime map — pinned 0.8.1

Source: `upstream/melee-unlocked`, commit `3aab7172db243c159afa76ecb2c564b3de8e4c0a`. Paths below are relative to that submodule; abbreviated `ppc/`, `hle/`, `gx/`, `host/`, `abi/` mean `port/runtime/…`. File groups include corresponding headers unless otherwise specified. The replacement column is a proposed port boundary, **not an existing implementation or a claim of verified browser parity**. The static recompilation target is distinct from the source-port DLL target.

## Guest memory and CPU

| Module / files | Responsibility | Depends on | Windows-only APIs used | Browser/WASM replacement |
|---|---|---|---|---|
| `ppc/ppc.h`, `ppc_estimates.inc` | `Context`, paired FPRs, integer/float operations, endian loads/stores, RAM aliases and locked-cache access; 24 MiB RAM, 16 KiB locked cache; write generations for texture snapshots | C++ math; MMIO/runtime helpers | MSVC `_byteswap_*`, intrinsics headers; x86 `_mm_fmadd_sd` family (architecture dependency, not OS API) | Linear memory with guest-address offsets; portable endian operations; bit-exact float helpers. FMA, rounding, NaN and denormal equivalence require validation; ordinary WASM arithmetic is not established as equivalent |
| `ppc/ppc_runtime.cpp` | Address-indexed dispatch, hooks, indirect calls, longjmp restore, locked-cache DMA, quantized paired loads/stores, SPR/FPSCR helpers | `guest_registry.h`, `host`, `interp.cpp` | `_mm_getcsr/_mm_setcsr` at 230–236; x86 floating-point control | Retain dispatch and DMA; implement explicit PPC rounding/FTZ semantics instead of changing MXCSR |
| `ppc/interp.cpp` | Fallback execution of RAM-resident PPC code | `ppc.h`, dispatch, host services | Inherits PPC intrinsic dependencies | Compile interpreter to WASM; retain fallback for code absent from generated registry |
| `host/host.cpp`, `host.h`, `memory_range.h` — memory/boot/disc portions | RAM/ARAM ownership; guest pointers; DOL/FST loading; boot low-memory state and Gecko installation | Generated guest image metadata, `gecko_data.h`, disc, cosmetics | Guest RAM uses `calloc`, **not mmap or VirtualAlloc** (`host.cpp:385–386`); Windows CRT file seek elsewhere in host | Allocate 24 MiB RAM + 16 MiB ARAM + dispatch/snapshot overhead in WASM; preserve address validation. User-provided disc via File/OPFS-backed random reads |

## ABI and dispatch

| Module / files | Responsibility | Depends on | Windows-only APIs used | Browser/WASM replacement |
|---|---|---|---|---|
| `port/recomp/{dol,symbols,gekko,gecko,analyze,emit,recomp}.py`, `GALE01_symbols.txt`, `hle_list.txt`; `dump.py`, `stats.py` | Offline DOL parsing, PPC analysis, Gecko patch/cave discovery, C++ emission and inspection. Emits `port/generated/`, which is not checked in | User DOL, Slippi Sys data; Python | None in generated-call contract; generated build currently targets MSVC | Run generation in build infrastructure, then compile emitted C++ with WASM toolchain; retain matching image/code-set identity |
| `ppc/guest_registry.h`, `hle/hle.h`; generated `hle_decls.h`, `guest_symbols.h`, function tables | Static recomp ABI: `ppc::Fn = void (*)(Context&, uint8_t*)`; `FnEntry{addr,fn}`; HLE arguments r3–r10/result r3 (`hle.h:10–22`). `recomp.py:268` emits declarations | Generated sources + PPC runtime | None in ABI; guest longjmp and OS context changes use C++ exceptions | WASM function table and exception/unwind support; do not substitute the unrelated `MuHostApi` for this ABI |
| `abi/mu_host.h`, `mu_parity.h`, `mu_native_pose.h`, `mu_lcancel_view.h` | Plain-C versioned source-port host/game function tables and POD inspection/pose contracts (`mu_host.h:1–24`: host v14, game v6) | Source DLL host (`port/app/source_host.cpp`), source game | Headers are platform-neutral; app loads native library through Windows machinery | Omit from minimal static recomp API; retain POD definitions used by shared runtime. Source-port WASM would need a separate linked-module adaptation |

## OS HLE and event scheduling

| Module / files | Responsibility | Depends on | Windows-only APIs used | Browser/WASM replacement |
|---|---|---|---|---|
| `hle/hle_os.cpp` | Console I/O, reset/exit/panic; `OSSleepThread` waits for host event; guest thread creation/resume largely stubbed; `OSLoadContext` unwinds (`:37–48`) | HLE ABI, host event pump | No native thread creation here | Preserve guest semantics and C++ unwinds. Guest OS threads are not a request to create browser workers |
| `hle/hle_stubs.cpp` — SI/AI/DSP/AR portions | SI completion responses, AI DMA callbacks, DSP mailbox/tasks, RAM↔ARAM DMA, AR allocator. Despite filename, contains functional audio/device behavior | `ax_ucode`, host interrupts/completions, audio output | No direct Windows device API in these HLE handlers | Retain deterministic callbacks/mailboxes/DMA even with silent output |
| `host/host.cpp` — event/time portions; `tick_timing.h` | Virtual timebase, scheduled completions, alarms, interrupt delivery, retrace, wall-clock pacing, exit signals | PPC context, HLE DVD/audio, PAD and Slippi polling | `QueryPerformanceCounter/Frequency`, `__rdtsc`, thread scheduling; `std::thread`, mutex/CV for logging | Simulation worker; virtual guest clock remains authoritative. Host monotonic timing bridge; SharedArrayBuffer/Atomics only if shared workers are chosen. Blocking waits must not occupy browser UI thread |

## VI / video interface and graphics

| Module / files | Responsibility | Depends on | Windows-only APIs used | Browser/WASM replacement |
|---|---|---|---|---|
| `host/host.cpp:484–536,910–914,1023–1061` | VI MMIO, periodic virtual retrace, interrupt 24; CP/PE registers, FIFO forwarding | Guest SDK VI code, PPC MMIO, GX core | Host pacing only; VI is not a separate `hle_vi.cpp` | Preserve virtual VI and PE completion behavior independently of canvas presentation |
| `gx/gx_core.*`, `gx_regs.h`, `texture_snapshot.h` | GX FIFO CP/XF/BP decoding, vertex loading, display lists, immutable draw/texture snapshots, XFB frame completion | Guest memory, observer/pose hooks, backend | No D3D device API in FIFO parser | Retain CPU parser; null backend for headless. See renderer map for `Frame` contract |
| `gx/gx_backend.*`, `gx_backend_dispatch.cpp`, `render_options.h` | Renderer factory and virtual presentation dispatch | `Backend`, D3D11/12 | Factory uses `D3D11CreateDevice`; HWND | New WebGPU factory; reuse backend-neutral dispatch |
| `gx/gx_d3d12.*`, `gx_d3d11.*` | Draw/copy replay, EFB, textures, raster/depth/blend state, swapchain, GPU lifetime/caches | GX frames, shader/texture helpers, host window | D3D12/D3D11, DXGI, D3DCompile, COM, fences/events | WebGPU backend, WGSL, canvas configuration, GPU resource retirement |
| `gx/gx_shader.*`, `gx/gx_texture.*` | TEV/XF→HLSL, UIDs/constants; tiled/paletted/CMPR texture decoding to RGBA8 | Draw snapshots, BP registers | Generation/CPU decoding is C++; generated language is HLSL | Preserve state normalization/CPU texture decode; implement WGSL generation and audited constant layouts |
| `gx/threaded_backend.*`, `frame_queue.h` | Bounded frame handoff, recycling, backlog drain, independent presentation timeline | Window/factory, subframe solver, immutable frames | Win32 thread/window setup plus `std::thread`, mutex/CV | Render worker/OffscreenCanvas or message-based renderer; preserve ordered copies and backpressure |
| `gx/subframe.*`, `authored_pose.*`, `render_observer.cpp`; `ppc/render_observer.h` | Optional draw matching, guest animation observation, authored pose capture and subframe transforms | PPC hooks, native animation library, GX snapshots | No graphics API in pose math; inherits PPC dependencies | Defer high-refresh presentation; retain no-op observer seam for 60 Hz core |
| `gx/native_pose_bridge.*`, `native_draw_audit.*` | Source-port pose snapshots and diagnostic FIFO scope/owner tokens | `abi/mu_native_pose.h`, GX core | None in bridge contract | Omit source-only capture for static recomp; stub referenced hooks |
| `gx/gx_streamline.*`, `gx_xess.*`, `gx_dlss5.*`, `gx_dlss5_scaling.*` | Vendor reconstruction, frame generation/latency and neural-render integration; scaling helpers | D3D12, vendor SDKs | Streamline/NGX/XeSS DLL loading and D3D12; signature/platform services in Streamline | Disable vendor paths; optional browser-specific postprocessing is separate work |
| `gx/gx_dxr_scene.*`, `gx_dxr_gpu_scene.*`, `gx_dxr_path_tracer.*`, `shaders/dxr_pathtrace.hlsl` | CPU scene extraction and D3D12 ray-tracing resources/passes | Draw snapshots, D3D12/DXR | DXR and DXIL/DXC | Defer; not needed for baseline GX raster output |
| `gx/texture_pack.*`, `companion_texture_map.h` | Replacement PNG lookup/decoding, asynchronous replacement cache | stb, files, texture hashes | `GetModuleFileNameW`; native filesystem and worker threads | Optional user imports/OPFS; retain stb decoding; defer replacement packs |
| `gx/video_background.*`, `video_background_learning.h`, `video_background_style.h` | Optional looping menu videos, learned target matching/style | Files, renderer | Media Foundation `MFStartup`, `MFCreateSourceReaderFromURL`, `IMFSourceReader` (`video_background.cpp:116–187,286`) | Defer; later browser video decode/upload bridge |
| `gx/pc_settings.*`, `pc_settings_dx11.cpp`, `pc_settings_shared.h`, `pc_settings_visuals.inl`, `radial_navigation.h`, `ui_sources/` | In-game PC settings, navigation/layout helpers and visual assets | ImGui, host configuration, renderer | ImGui Win32/DX11/DX12 backends and native dialogs | Browser settings UI or ImGui WebGPU/input adapter; omit Windows-only settings |
| `gx/lab_view.*`, `training_overlay.*`, `flicker_scan.*` | Replay-event visualization, training overlays, render-flicker diagnostics | Slippi events, ImGui, renderer captures | Device readback belongs to D3D backend; overlay helpers are CPU code | Defer UI overlays; retain pure analysis helpers if useful |

## PAD input

| Module / files | Responsibility | Depends on | Windows-only APIs used | Browser/WASM replacement |
|---|---|---|---|---|
| `hle/hle_pad.cpp` | PAD API→12-byte guest PADStatus, fresh-input mask, rumble routing and calibration | `host::input_poll`, lcancel, user Gecko, online local slot | No direct Windows API | Inject deterministic per-tick `host::PadState[4]`; preserve guest byte layout |
| `host/window.*`, `input_bindings.h`, `settings_chord.h` | Window, message pump, keyboard/XInput aggregation, binding/overlay controls | PAD backends, host settings | HWND/User32, `XInputGetState`/rumble, Raw Input registration/messages | Canvas/DOM events and Gamepad API bridge; rumble optional |
| `host/gc_adapter.cpp` | WUP-028 USB packets, calibration, polling/rumble worker | Vendored libusb | **libusb**, whose Windows backend supports WinUSB/libusbK/libusb-win32; not direct WinUSB-only runtime (`port/CMakeLists.txt:201–219`) | Gamepad where exposed; optional WebUSB adapter implementation with permission/device support |
| `host/hid_pad.*`, `playstation_pad.*`, `switch_pro.cpp` | HID discovery/reports, DS4 parser, Switch Pro output handshake/calibration | Raw Input, bindings | `GetRawInputDeviceInfoW`, `GetRawInputDeviceList`, `CreateFileW`, HID APIs; Switch worker | Prefer Gamepad; optional WebHID protocol bridge. Reuse pure report parsing separately |
| `host/controller_profiles.*` | Controller mapping profile persistence | Filesystem, bindings | No direct Windows API in profile parser | Browser persistence/import/export |
| `host/lcancel.*`, `user_gecko.*` | Input assists/feedback and optional user data-write cheats | Guest state, online policy, PAD, shader tints | No direct Windows API in core logic | Disable optional assists/codes initially; retain no-op call seams and deterministic input |

## DVD / disc

| Module / files | Responsibility | Depends on | Windows-only APIs used | Browser/WASM replacement |
|---|---|---|---|---|
| `hle/hle_dvd.cpp` | Sync/async DVD reads, request status/callbacks; asynchronous completion scheduled quarter-frame later, ordered (`:35–63`) | Host ISO/FST readers, guest event queue | C++ worker, mutex/CV, not a Windows DVD API | OPFS/File-backed worker reads or preloaded virtual files; preserve virtual completion order and stall simulation until data is ready |
| `host/vcdiff.*`, `source_mod_overlay.*` | Slippi resource patch decoding; source-mod disc file overlays | Disc data, files | Portable decoding/file logic | Keep VCDIFF for Slippi GameFiles diffs; omit source-mod overlays initially |
| `host/cosmetic_mods.*`, `mod_profile.*` | Cosmetic import, staged overlays, mod identity and configuration | Filesystem, JSON, disc resources | BCrypt SHA256, file dialogs, `CreateFileW`, `CreateProcessW` for tar extraction | Defer; browser import/unpack/hash pipeline if added, without subprocesses |

## AX audio

| Module / files | Responsibility | Depends on | Windows-only APIs used | Browser/WASM replacement |
|---|---|---|---|---|
| `hle/ax_ucode.*` | CPU HLE of DSP AX command processing/mixing | RAM/ARAM memory callbacks; DSP mailbox path | No direct Windows device API | Keep deterministic DSP/ARAM behavior; output can be discarded |
| `hle/audio_core.*` | Shared AI DMA clock/state and DSP mailbox bridge, including native PCM mode | AX, host audio and timing | Output dependency through host | Retain if using shared/native audio path; static recomp AI state also lives in `hle_stubs.cpp:188–239` |
| `hle/jukebox.*` | Slippi HPS DSP-ADPCM music loading/decoding/mixing | Disc reads, PCM output | Files/threads through host dependencies | Retain decoder for audio build; no-op music playback for simulation-only |
| `host/audio.*` | 32 kHz stereo input, buffering/resampling, output and dumps | Jukebox, AI blocks | WASAPI `IAudioClient/IAudioRenderClient`, COM; WinMM `waveOut*` fallback; event/worker thread | AudioWorklet with bounded PCM ring; SharedArrayBuffer optional handoff. Headless output sink must still consume callback traffic |

## CARD saves

| Module / files | Responsibility | Depends on | Windows-only APIs used | Browser/WASM replacement |
|---|---|---|---|---|
| `hle/hle_card.cpp` | Slot-A 128-Mbit GCI-folder card; 64-byte directory + 8 KiB sectors, 2043 blocks (`:1–17`); async SDK callbacks | Host completion queue, guest RAM, C++ files | No direct Windows API | In-memory GCI filesystem backed by OPFS/IndexedDB; keep callback semantics |
| `hle/hle_stubs.cpp` — EXI SRAM | 64-byte console settings behind channel 0/device 1, persisted as `sram.bin` | Host config, file I/O | No direct Windows API | Small persistent blob; preserve defaults/checksum behavior |

## EXI / Slippi device

| Module / files | Responsibility | Depends on | Windows-only APIs used | Browser/WASM replacement |
|---|---|---|---|---|
| `hle/hle_stubs.cpp` — EXI handlers; `hle/exi_slippi.*`, `gecko_data.h` | Channel-1 device DMA, command lengths/read queue, Slippi code/resource delivery, replay writing, optional code toggles | Host RAM/disc, generated Gecko bytes, VCDIFF, online/playback, lab/practice | File I/O and host dependencies | Keep EXI wire semantics; serve Sys resources from packaged virtual files; browser replay download/persistence |
| `hle/slippi_net.*` | Packet codec, user record, code history, concrete ENet client and matchmaking | ENet, JSON, report HTTP helper, threads | ENet Winsock; Windows string conversions; native user files | Separate WebRTC transport and browser matchmaking/session identity. See netcode map; no existing virtual transport |
| `hle/slippi_online.*`, `slippi_menu_codec.h`, `native_slippi_bridge.h`, `native_online_policy.h` | Guest online command handling, readiness/setup, delayed input, time sync, RAM savestates, checksum oracle, native payload/policy helpers | Netplay/matchmaking, EXI, guest memory | Native Launcher file discovery and host integrations; no direct shell login launch in this module | Retain online protocol core when browser netplay is implemented; otherwise explicit unavailable/offline responses |
| `hle/slippi_report.*` | GraphQL reports, gzip replay PUT, background ISO MD5 | WinHTTP, BCrypt, user credentials, JSON/files | `WinHttp*`, `BCrypt*`, worker | Disable stock-server reporting in initial browser build; any future fetch integration needs supported auth/CORS contract (unknown — needs investigation) |
| `hle/slippi_playback.*`, `slippi_playback_legacy.h` | Replay parsing and playback EXI replies; playback Gecko selection | Vendored SlippiLib, replay files and playback-generated guest | Native filesystem dependencies | Virtual replay files; retain only for playback build, with matching recompiled Gecko caves |
| `hle/native_savestate.*`, `native_state_layout.h`, `native_replay_stream.*` | Source-port memory snapshots/undo, native layout checks and replay byte assembly | Source game ABI/memory, files | `GetWriteWatch`, `ResetWriteWatch` in native savestate (`:180–199,248–258`) | Omit for static recomp; source-port alternative needs explicit dirty tracking or portable comparison path |
| `hle/native_practice.*`, `native_practice_model.*` | Practice/rematch handoff and state model across native/legacy online flow | Online menus, game API or guest RAM | No separate device API | Stub optional practice service initially; retain command dependencies where linked |

## Host services and diagnostics/tests

| Module / files | Responsibility | Depends on | Windows-only APIs used | Browser/WASM replacement |
|---|---|---|---|---|
| `host/discord_presence.*` | Discord desktop RPC/presence and join-code handoff | JSON, background worker | Named pipes via `CreateFileA`, read/write operations | Disable desktop RPC; optional browser session-link UI is separate |
| `host/updater.*` | GitHub release check/download and executable updater | JSON, native files, process launch | WinHTTP, Windows update script/process integration | Disable native updater; application deployment owns web assets |
| `host/host.cpp` — logs/state traces/profiler | Buffered logs; CPU/RAM/ARAM/event checkpoints; simulation-state digests | Guest/source inspection, filesystem | Background threads, timing intrinsics/Win32 | Console/downloadable trace sink; retain deterministic checkpoint fields |
| `port/app/main.cpp`, `settings_window.cpp`, `source_host.cpp`, `source_guest_boundary.*`, `main_source.cpp` | Application boot, CLI/settings, crash handling; separate source DLL host/boundary | Runtime, generated guest or source DLL | Win32 GUI/process/DLL APIs, `MiniDumpWriteDump` (`main.cpp:891`) | New thin WASM bootstrap/export layer; do not compile Windows app unchanged |
| `port/app/launcher*`, `launch_process.h` | Optional launcher, replay browser, build/version management and peer lobby | DHT, Monocypher, Win32, updater | Winsock/BCrypt/WinHTTP and GUI/process APIs | Exclude launcher; it is not required to run the static recomp core |
| `port/tests/` — PPC/load, RAM/memory, DVD/image, CARD/AX, packet/menu/savestate, frame queue/draw/texture/backend/observer tests | Existing unit and boundary fixtures; exact target/source list in `port/CMakeLists.txt` | Runtime subsets, some generated guest/ISO/native GPU | Several targets explicitly link D3D/Win32; current flags include `/EHsc`, `/bigobj`, `/fp:precise` | Port relevant fixtures to WASM CI; native tests cannot establish WASM float/transport parity |
| `tools/validate_native.py`, `online_pair.py`, `replay_compare.py`, `slp_diff.py`, `extract_dol.py`, `verify_generated_gct.py` | Cross-renderer checkpoint comparison; paired online exercise; replay equivalence; extraction/code verification | Built native executables, user disc/replays | Native process orchestration in harnesses | Adapt orchestration in CI; preserve checkpoint/replay comparison algorithms |
| `port/third_party/` integration | ENet transport; libusb adapter; SlippiLib replay parser; nlohmann JSON; stb textures; ImGui; earcut; DHT/Monocypher launcher; Streamline/NGX/XeSS | See `port/CMakeLists.txt:196–249,332–339,469+` | ENet links `ws2_32/winmm`; libusb explicitly builds Windows backends; ImGui uses Win32/DX12; vendor DLLs | Keep portable parser/codec/math libraries only; replace transport/device/GUI backends; omit launcher/vendor integrations |

## Minimum viable WASM core

Scope: **offline, headless static-recomp simulation with supplied disc/Sys data and scripted pads**, retaining guest-visible device timing. This is an exact proposed component boundary, not an existing WASM CMake target. A proven minimal link-symbol list is **unknown — needs investigation**: the current runtime glob and Windows libraries do not provide one (`port/CMakeLists.txt:174–178,235–249`).

Keep/port these modules:

1. All matching generated guest translation units, registry/name tables, image metadata and `gecko_data.cpp`; `ppc/{ppc.h,ppc_estimates.inc,ppc_runtime.cpp,interp.cpp,guest_registry.h}` and generated ABI headers. Fix x86 float/endian dependencies and retain exception semantics.
2. `host/{host.cpp,host.h,memory_range.h,tick_timing.h}` core memory/boot/disc/event/MMIO/trace services with platform replacements; `host/vcdiff.*` for Slippi resource diffs.
3. `hle/{hle.h,hle_os.cpp,hle_pad.cpp,hle_dvd.cpp,hle_card.cpp,hle_stubs.cpp,ax_ucode.cpp,ax_ucode.h}`. Retain AI callbacks/DSP/ARAM work; silence only the physical output. Supply in-memory CARD/SRAM files and injected pad states.
4. `hle/{exi_slippi.cpp,exi_slippi.h,gecko_data.h}` and packaged Sys resources. Offline online-command adapter must preserve request sizes/read replies. No server/client transport is required for this scope.
5. `gx/{gx_core.cpp,gx_core.h,gx_regs.h,gx_texture.cpp,gx_texture.h,texture_snapshot.h}` with `gx::init(nullptr)`. Preserve FIFO consumption, PE finish/token side effects and XFB boundaries; native headless already passes a null backend (`port/app/main.cpp:1428–1457`).

Required stubs/adapters at retained call sites: host window/message pump and physical controller/rumble functions; host audio output and jukebox; Slippi online login/search/reporting and playback handlers (unless replay validation is enabled); Discord/updater; cosmetic/source-mod lookup; user Gecko/lcancel; native practice; GX render-observer/authored/native-pose/audit and lab/training hooks. Keep the guest-visible successful completion or explicit unavailable response expected by each caller; do not replace the whole event/MMIO layer with no-ops.

Exclude D3D factories/backends, shader generation, presentation workers/subframes, texture packs/videos/UI/vendor GPU/DXR integrations, native source DLL/savestate path, launcher, ENet/libusb and Windows app entry points. If retaining a whole source file pulls one of these back in, split its dependency or supply the named stub; this document does not assert those files link unchanged. Headless replay/online validation adds `slippi_playback`/SlippiLib or `slippi_online`/netplay respectively and is outside this offline minimum.
