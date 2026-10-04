# PLAN_BREAKDOWN — reviewed implementation breakdown

Reviewer input: `docs/SPEC_PIANO.md`, `docs/AGENT_RULES.md`, `docs/UPSTREAM_PIN.md`, and the
upstream tree at `upstream/melee-unlocked` @ `3aab7172db243c159afa76ecb2c564b3de8e4c0a`.
All upstream paths below are relative to `upstream/melee-unlocked/` unless they start with
`docs/`, `web/`, `functions/`, `scripts/`, `wasm/`, `patches/` or `.github/` (this repo).

---

## 1. DECISION: static recomp is the base for the WASM target

**Decision: build the browser target on Static Recomp (`port/recomp/` → C++ → Emscripten).
The Source Port (`sourceport/`) is not a viable base for Emscripten as it stands.**

### Evidence against Source Port

| # | Fact | Where |
|---|---|---|
| S1 | The game library must be compiled by GCC because disc-resident structs stay big-endian in memory via `scalar_storage_order`, "which no other compiler implements". Emscripten is clang-based; clang does not implement it. | `sourceport/cmake/mingw-w64-x86_64.cmake:1-2`; hard error in `sourceport/game/CMakeLists.txt:13` ("needs GCC 14 or newer: scalar_storage_order") |
| S2 | Its FP fidelity depends on GCC fusing `a*b+c` exactly where the console compiler did (`-ffp-contract=on` + `-mavx2 -mfma`), audited site by site with dedicated tooling. WASM has no deterministic scalar FMA instruction for clang to contract into, so every fused site would silently round twice. | `sourceport/game/CMakeLists.txt:43,53,139,171-173`; `tools/fma_census.py:1-8`; `tools/fma_exact/` |
| S3 | It does not remove the DOL dependency: the host build needs the Static Recomp translation too ("Prepare the guest translation using the Static Recomp steps … the host's translation is also used by the parity tests"). | `docs/build-source-port.md` |
| S4 | Its host (`melee_source`) links the same Windows `runtime` library as the recomp build, so the runtime still has to be ported. The Source Port adds a second porting problem without removing the first. | `port/CMakeLists.txt` (target `melee_source`: `target_link_libraries(melee_source PRIVATE runtime dbghelp)`) |
| S5 | It carries a 200,417-line patch over doldecomp that would have to be kept compiling under a new compiler. | `sourceport/patches/melee-native.patch` (`wc -l`) |
| S6 | The `sourceport/extern/melee` and `sourceport/extern/aurora` submodules are not initialised in this checkout (both directories are empty), so none of the decomp code could be inspected. | `.gitmodules` (upstream), `ls sourceport/extern/*` |

### Evidence for Static Recomp

| # | Fact | Where |
|---|---|---|
| R1 | Generated code is plain C++17: every guest function is `void f_XXXXXXXX(ppc::Context&, uint8_t*)` calling `ppc::` helpers. 40,154 functions in 145 files (~67 MB) in the stale sample tree. | `port/generated.before-shake/functions.h:1-6`, `guest_000.cpp:1-10`; count from `grep -c '^void f_'` |
| R2 | The MSVC-specific surface is small and mechanical: `#include <intrin.h>` in every guest TU; `_rotl` emitted for `rlwinm/rlwnm/rlwimi`; `_byteswap_{ushort,ulong,uint64}`, `_BitScanReverse` and `_mm_fmadd_sd`/`_mm_fmsub_sd`/`_mm_fnm*_sd` in `ppc.h`; `_mm_getcsr/_mm_setcsr` in `update_mxcsr`. | `port/recomp/recomp.py:300`; `port/recomp/emit.py:265-271`; `port/runtime/ppc/ppc.h:10-11,175-216,250,279-290`; `port/runtime/ppc/ppc_runtime.cpp:230-237`; `port/runtime/ppc/interp.cpp:152-154` |
| R3 | Big-endian guest memory is handled explicitly with memcpy + byteswap, not by compiler extensions, so it is portable to clang/WASM. | `port/runtime/ppc/ppc.h:175-216` |
| R4 | FP semantics are specified: "mirror Slippi Dolphin's Jit64 (FMA path)". `fmadd` must be **fused** (single rounding). In WASM this maps to `fma()` (software, exact, deterministic) — correct but of unknown cost. | `port/runtime/ppc/ppc.h:2-3,278-290`; emitted at `port/recomp/emit.py:586-671` |
| R5 | `setjmp/longjmp` is a C++ exception (`ppc::GuestLongJmp`) caught in recompiler-emitted retry loops; only 5 catch sites in the sample tree, so `-fwasm-exceptions` cost is bounded. | `port/runtime/ppc/ppc.h:144`; `port/recomp/emit.py:160`; `grep -c 'catch (ppc::GuestLongJmp'` over `port/generated.before-shake` = 5 |
| R6 | All correctness tooling (checkpoint traces, online pair, replay compare) targets the recomp build. | `tools/validate_native.py:1-21` (`--trace-kind recomp` default), `tools/online_pair.py`, `tools/replay_compare.py` |
| R7 | The recompiler and its emitter are Python and already exercised without a DOL by a generated unit test. | `port/tests/generate_load_test.py:1-20` |

### What would have to be true for Source Port to win

1. Phase 0 shows the recomp simulation misses the mobile budget (> 6 ms/frame mean or > 12 ms
   p99, `docs/SPEC_PIANO.md` §Fase 0) **and** profiling attributes the cost to recomp overhead
   (register file in `ppc::Context`, bounds-checked `ld*/st*` helpers `ppc.h:160-216`, per-entry
   `if (c.entry)` dispatch in every function `guest_000.cpp:8-40`, software `fma()`), not to the HLE.
   Compiled decomp C avoids all of that and is plausibly much faster.
2. **And** someone replaces `scalar_storage_order` in the decomp with explicit accessors or
   load-time endian conversion (scope: unknown — needs investigation; the decomp submodule is
   not checked out).
3. **And** FMA fidelity is either reproduced with explicit `fma()` calls at every console-fused
   site (list derivable from `tools/fma_census.py`) or consciously abandoned.

Note on (3): for v1.0 both peers run the *same* `.wasm`; browser-vs-browser determinism does
not need console fidelity. Fidelity only matters for the native checkpoint oracle and for
"plays like Melee".

### Unknowns that can only be settled once the DOL exists

- Whether the current recompiler output (at the pin) compiles under emcc/clang at all, and the
  compile time / peak RSS per TU on a GitHub-hosted runner. Unknown — needs investigation.
- The largest generated function (bytes of WASM body, number of locals) versus engine limits,
  and how much code LLVM's irreducible-control-flow fixing adds for the multi-entry `goto`
  dispatch (`guest_000.cpp:8-40`). Not measured: script-based measurement was not possible in
  this session. Unknown — needs investigation.
- Size of the final `.wasm` (against the 25 MiB Pages per-file limit and the 100 MB first-run
  budget, `docs/SPEC_PIANO.md` §Definizione di fatto item 4).
- Whether Melee ever sets FPSCR RN ≠ nearest or NI = 1 (`ppc_runtime.cpp:230-237` maps these
  to MXCSR; WASM has no rounding-mode or FTZ/DAZ control). Unknown — needs investigation.
- Per-frame simulation cost in WASM on desktop and mid-range Android (Phase 0).

### Upstream tree anomaly (resolve before anyone relies on it)

`port/generated.before-0563/`, `port/generated.before-pal/`, `port/generated.before-shake/`
(67 MB each) exist in the submodule checkout even though upstream's `.gitignore` has
`/port/generated*/`. They are DOL-derived. Whether they are tracked at the pin is unknown
(not checked; run `git -C upstream/melee-unlocked ls-files port/generated.before-pal | head -1`).
They are stale relative to the runtime (names say "before" three changes). Treat them as game
data under `docs/AGENT_RULES.md` rule 1: do not build, copy or ship from them without an
explicit operator decision (see §4).

### Consequences for the spec (record in `docs/OPEN_QUESTIONS.md`)

- Spec §Setup requires a Linux headless native build passing `tools/validate_native.py`. Root
  `CMakeLists.txt:52-53` fails the configure on anything but Windows x64 + MSVC, 27 runtime
  files include `windows.h` (including the simulation-path files `hle/exi_slippi.cpp`,
  `hle/slippi_net.cpp`, `host/host.cpp`), and `validate_native.py` drives `melee_port.exe` and
  checks renderer isolation, not cross-build equivalence (`tools/validate_native.py:1-3,19-21`).
  The "native reference" is a porting project of its own, not a setup step.
- Spec §Pipeline di deploy item 4 says no Actions for the game build (DOL would be a CI
  secret). The operator's rules forbid building on the VPS. Something has to give: DOL (or
  generated C++) delivered to a private runner, a Codespace, or an encrypted artifact. Operator
  decision required before Phase 0.
- `docs/AGENT_RULES.md` says "never let the host compiler contract a multiply-add into an FMA".
  Correct for general code, but the explicit `ppc::fmadd` family **must** stay fused
  (`ppc.h:278-290`). The WASM port uses `fma()` there and `-ffp-contract=off` everywhere else.

---

## 2. TONIGHT'S WORK BREAKDOWN

Constraints for every task: no game data, no compiler/bundler/`npm install` on the VPS,
verified only by GitHub Actions. One branch + PR per task (`feat/<task-id>-…`), merge only
on green CI. Each task leaves `main` green.

Toolchain note that shapes the order: no lockfile can be generated on the VPS. T2 therefore
includes a lockfile bootstrap workflow; every JS task after it uses `npm ci`.

### T0 — Repo hygiene and CI skeleton

- Deliverables:
  - `docs/PROGRESS.md` (state / next step / blockers, as required by `docs/AGENT_RULES.md`)
  - `docs/OPEN_QUESTIONS.md` (seed with the items in §1 "Consequences" and §4)
  - `docs/PORT_CHANGES.md` (empty table: patch file, upstream file, reason)
  - `.github/workflows/ci.yml` with jobs `lint-workflows` (actionlint) and `hygiene`
  - `scripts/check_no_game_data.py`: fails if the git index contains `*.iso|*.gcm|*.rvz|*.dol|*.gci`,
    anything under `port/generated*`, `assets-extracted/`, or any file > 5 MB
  - `.gitignore`: add `upstream/melee-unlocked/port/generated*/` (currently only `generated/`)
- Acceptance (machine):
  - `ci.yml` passes on the PR; actionlint exits 0.
  - `python scripts/check_no_game_data.py` exits 0 on the tree and exits 1 on a test fixture
    that stages a fake `x.dol` (unit test in `scripts/tests/test_check_no_game_data.py`, run
    with `python -m unittest`).
  - CI checks out the submodule with `submodules: true` and asserts
    `git -C upstream/melee-unlocked rev-parse HEAD` equals the SHA in `docs/UPSTREAM_PIN.md`.
- Depends on: nothing.

### T1 — Technical map documents

- Deliverables: `docs/RUNTIME_MAP.md`, `docs/RENDERER_MAP.md`, `docs/NETCODE_MAP.md`,
  `scripts/check_docs.py`, `scripts/tests/test_check_docs.py`.
- Content requirements:
  - RUNTIME_MAP: one table row per file in `port/runtime/{ppc,hle,host,gx,abi}/*.{cpp,h}` with
    columns `path | role | depends on | Windows APIs | browser disposition`. Disposition
    vocabulary is fixed: `keep`, `shim` (compile with portability header/patch), `replace`
    (new web implementation), `stub` (no-op in web build), `drop` (not compiled). Known inputs:
    Windows includes in 27 files (list in §1); DVD worker thread + condition variable
    (`hle/hle_dvd.cpp:47-98`); WASAPI/WinMM output (`host/audio.cpp:1-3,68-71`); ENet
    (`hle/slippi_net.h:18-19`); WinHTTP/BCrypt reporting (`hle/slippi_report.cpp`, 23 matches
    for Win API patterns); libusb/WinUSB adapter (`host/gc_adapter.cpp`); updater
    (`host/updater.cpp`); Discord (`host/discord_presence.cpp`).
  - RENDERER_MAP: answer the spec §1.2 question with evidence. What is already visible:
    the runtime decodes the GX **FIFO command stream** into register state
    (`gx/gx_core.h:1`, `write_fifo` at `gx/gx_core.h:295-296`, `BPMemory` at `:122`), and
    backends implement `gx::Backend::submit_frame(const Frame&)` (`gx/gx_core.h:271-291`),
    selected in `gx/gx_backend.h:1-12`. Shaders are HLSL transcribed from Dolphin
    (`gx/gx_shader.h:1`). Map which `gx/*.cpp` are backend-independent (candidates to keep)
    vs D3D-bound. List every `Frame`/`DrawCall` field a WebGPU backend must consume.
  - NETCODE_MAP: message types and channels. ENet channel 0 reliable (selections, chat,
    build fingerprint), channel 1 unsequenced `NP_MSG_SLIPPI_PAD`, channel 2 unsequenced
    `PAD_ACK` (`hle/slippi_net.cpp:281-450`, esp. `:326-327`, `:446-450`); matchmaking over
    ENet to `mm.slippi.gg` (`:945-954`); where `_ENetPeer*` leaks into client state
    (`hle/slippi_net.h:194-213,285-286`); checksum exchange (`remote_checksums_`,
    `slippi_net.h:217`). Packet sizes/frequency: derive from the serialisers
    (`slippi_net.cpp:400,419,652,674`); runtime measurements are "unknown — needs a running
    build".
- Acceptance (machine), enforced by `scripts/check_docs.py` in `ci.yml`:
  - every file matched by the glob above appears exactly once in RUNTIME_MAP's table;
  - every disposition cell is in the fixed vocabulary;
  - every backticked path of the form `port/...`, `tools/...`, `sourceport/...` cited in any
    `docs/*_MAP.md` or `docs/PLAN_BREAKDOWN.md` exists in the submodule checkout;
  - every `path:N` or `path:N-M` citation is within the file's line count.
- Depends on: T0.

### T2 — Web UI shell (TypeScript + Vite, no framework)

- Deliverables:
  - `web/package.json` (deps: `typescript`, `vite`, `vitest`; nothing else yet),
    `web/tsconfig.json` (`strict: true`), `web/vite.config.ts`, `web/index.html`
  - `web/src/main.ts`, `web/src/ui/boot.ts` (boot screen with a "Gioca" button that
    creates/resumes the `AudioContext` — spec §2.1 autoplay rule),
    `web/src/ui/progress.ts`, `web/src/ui/settings.ts` (localStorage-backed, typed schema)
  - `web/src/platform/capabilities.ts`: detects WebGPU (`navigator.gpu` + adapter),
    `crossOriginIsolated`, `SharedArrayBuffer`, `AudioWorklet`, OPFS
    (`navigator.storage.getDirectory`), WASM threads and WASM exceptions (feature-probe
    by `WebAssembly.validate` on minimal modules), Gamepad API. Returns a typed report; UI
    shows a blocking message when a v1.0 requirement is missing (spec §1.3: no WebGL2 fallback).
  - `web/public/_headers` with the COOP/COEP/CORP block and the `*.wasm` block from
    `docs/SPEC_PIANO.md` §Header obbligatori
  - `.github/workflows/bootstrap-lockfile.yml` (`workflow_dispatch`): runs `npm install` in
    `web/`, opens a PR adding `web/package-lock.json`
  - `ci.yml` job `web`: `npm ci && npx tsc --noEmit && npx vitest run && npx vite build`
- Acceptance (machine):
  - After the lockfile PR merges, job `web` is green.
  - Vitest: `capabilities.test.ts` covers each probe with stubbed globals (present/absent).
  - Vitest: settings round-trip and schema migration from an older version.
  - `web/dist/_headers` exists after build and byte-equals `web/public/_headers`.
  - Build step prints total `dist/` size; job fails if > 1 MB (shell only, no game).
- Depends on: T0. The PR that adds `package.json` must not add the `web` CI job until the
  lockfile exists (two PRs: scaffold+bootstrap workflow, then CI job).

### T3 — Browser test harness

- Deliverables:
  - `web/playwright.config.ts` (Chromium only for now)
  - `web/scripts/serve.mjs`: zero-dependency Node static server for `web/dist` that parses
    and applies `web/public/_headers` (so the tested headers are the deployed file)
  - `web/e2e/boot.spec.ts`
  - `ci.yml` job `e2e`: `npx playwright install --with-deps chromium`, build, serve, test;
    upload `playwright-report/` as artifact on failure
- Acceptance (machine):
  - `boot.spec.ts` asserts: no console errors; `self.crossOriginIsolated === true`;
    `typeof SharedArrayBuffer === 'function'`; capabilities report renders; clicking
    "Gioca" leaves `AudioContext.state === 'running'` (launch Chromium with
    `--autoplay-policy=no-user-gesture-required` is **not** allowed; the click must do it).
  - A negative test serves without `_headers` and asserts `crossOriginIsolated === false`
    (proves the header test is not vacuous).
  - WebGPU in headless CI Chromium: whether an adapter is obtainable (SwiftShader) is
    unknown — needs investigation. Record the result; do not assert on it tonight.
- Depends on: T2.

### T4 — WASM toolchain probe (CI only, no game data)

The only task tonight that produces evidence about §1 and §3. It compiles upstream code that
needs no DOL.

- Deliverables:
  - `EMSDK_VERSION` (pin one stable emsdk release; spec §Setup)
  - `wasm/compat/intrin.h`: maps `_byteswap_*` → `__builtin_bswap*`, `_BitScanReverse`,
    `_rotl/_rotr` → `__builtin_rotateleft32/right32` (or portable shifts)
  - `patches/0001-ppc-portable-fma-and-intrinsics.patch` against `port/runtime/ppc/ppc.h`:
    under `#if defined(__EMSCRIPTEN__) || !defined(_MSC_VER)` replace `<immintrin.h>/<intrin.h>`
    use and implement `fmadd/fmsub/fnmadd/fnmsub` with `fma()` preserving the sign
    conventions in `ppc.h:285-289`. Record in `docs/PORT_CHANGES.md`.
  - `scripts/apply_patches.sh`: `git apply --check` then apply onto the CI checkout of the
    submodule (never committed; rule 4).
  - `wasm/probe/CMakeLists.txt` building, with emcc and `-O3 -fwasm-exceptions
    -ffp-contract=off -sENVIRONMENT=node`, these upstream tests that have no DOL/Windows deps:
    `port_load_test` (generated by `port/tests/generate_load_test.py`, uses the real emitter),
    `port/tests/ram_watch_test.cpp` (ppc.h), `port/tests/ax_ucode_test.cpp` +
    `port/runtime/hle/ax_ucode.cpp`, `port/tests/texture_snapshot_test.cpp` +
    `port/runtime/gx/gx_texture.cpp`. Include only what each test needs; if a test turns out
    to pull a Windows header, drop it and record why.
  - `wasm/probe/fma_vectors.cpp`: N=10^6 deterministic pseudo-random (a,c,b) triples incl.
    subnormals, ±0, inf, NaN inputs, and f25/fs rounding (`ppc.h:272-277`); prints a SHA-256
    of the result bit patterns. Built twice: native `g++ -O2 -mfma` using the **unpatched**
    x86 intrinsic path, and emcc using the patched `fma()` path.
  - `wasm/probe/bench.cpp`: times 10^7 `ppc::fmadd` and 10^7 `ld32/st32` round trips.
  - `.github/workflows/wasm-probe.yml` (on PRs touching `wasm/`, `patches/`, `EMSDK_VERSION`;
    plus `workflow_dispatch`), uses `emscripten-core/setup-emsdk` or `mymindstorm/setup-emsdk`
    pinned to `EMSDK_VERSION`, runs outputs under `node`.
- Acceptance (machine):
  - All listed tests exit 0 under node.
  - `fma_vectors` hash from native x86 FMA == hash from WASM `fma()`. Mismatch fails the job
    (this is the first real determinism datum; do not "fix" by loosening).
  - Bench writes `wasm-probe/bench.json` artifact (ns/op native vs wasm). No threshold tonight;
    record numbers in `docs/PROGRESS.md`.
  - Job prints `nproc`, `free -m`, `df -h` of the runner (input for §3 R2).
- Depends on: T0. Independent of T2/T3.

### T5 — Cloudflare Pages Functions

- Deliverables:
  - `functions/api/turn-credentials.ts`: POST only; requires a verified Access identity;
    calls the Cloudflare Realtime TURN credential-generation endpoint with
    `env.TURN_KEY_ID` / `env.TURN_KEY_API_TOKEN` and a short TTL; returns `iceServers`
    always prefixed with `stun:stun.cloudflare.com:3478`. Exact endpoint path and response
    shape: verify against https://developers.cloudflare.com/realtime/turn/ before deploy
    (unknown — needs investigation; do not guess in code, keep it in one constant).
  - `functions/_middleware.ts`: validates `Cf-Access-Jwt-Assertion` (RS256, JWKS from
    `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, `aud` = `env.ACCESS_AUD`),
    JWKS fetcher injectable for tests. Rejects with 403 when missing/invalid. Local/dev bypass
    only when `env.ACCESS_DEV_BYPASS === "1"` and never in production (assert `env.CF_PAGES_BRANCH`).
  - `functions/api/health.ts` (200 + git SHA from `env.CF_PAGES_COMMIT_SHA`).
  - `functions/tsconfig.json`, tests `functions/test/*.test.ts` run by vitest from `web/`
    or a sibling `package.json` (decide once; keep one lockfile if possible).
  - `wrangler.toml` (`pages_build_output_dir = "web/dist"`, no secrets).
- Acceptance (machine):
  - Vitest with a JWT signed by a test RSA key and a stub JWKS: valid → 200, wrong `aud` → 403,
    expired → 403, missing header → 403.
  - TURN handler with mocked `fetch`: token appears only in the upstream request header, never
    in the response body; upstream 5xx → 502; non-POST → 405.
  - `.dev.vars` (wrangler's local secrets file) is added to `.gitignore`; `.env.*` does not
    cover it. `scripts/check_no_game_data.py` also fails if `.dev.vars` is in the index.
  - `npx wrangler pages functions build` succeeds in CI without credentials (if it requires
    login, record that and drop this check — unknown — needs investigation).
- Depends on: T2 (lockfile/tooling).

### T6 — Lobby and signalling layer (testable without Supabase)

- Deliverables:
  - `web/src/lobby/signaling.ts`: interface `SignalingChannel { join(room, self): Promise<void>;
    send(msg: SignalMsg): void; onMessage(cb); onPresence(cb); leave() }`;
    `SignalMsg` is a discriminated union: `hello`, `offer`, `answer`, `ice`, `ready`, `bye`,
    each with `from`, `to`, `seq`, `roomEpoch`.
  - `web/src/lobby/memory_signaling.ts` (in-process hub, for unit tests) and
    `web/src/lobby/broadcast_signaling.ts` (`BroadcastChannel`, for two-tab e2e without network).
  - `web/src/lobby/supabase_signaling.ts`: Realtime Broadcast + Presence on private channel
    `room:<CODE>`, anonymous sign-in (spec §3.3). Type-checked only tonight; the SDK is
    `@supabase/supabase-js`, added as the single new dependency. No URL/key in code: read from
    `import.meta.env.VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` at runtime, absent → adapter
    reports "lobby unavailable".
  - `web/src/lobby/room.ts`: room code generator (4 letters, alphabet without ambiguous letters,
    `crypto.getRandomValues`), host election (creator = port 1), state machine
    `idle → waiting → negotiating → connected → closed`, duplicate/out-of-order message handling
    via `seq`, glare handling (only host sends `offer`), 3rd joiner rejected for 1v1.
  - `web/src/ui/lobby.ts`: nickname, create/join, presence list.
- Acceptance (machine):
  - Vitest over `memory_signaling`: host+guest reach `connected` given a fake peer factory;
    reordered/duplicated `ice` messages are tolerated; third joiner gets `room_full`;
    guest leaving returns host to `waiting`.
  - Room code: 10^5 generated codes all match `/^[A-HJ-NP-Z]{4}$/` (or the chosen alphabet).
  - `tsc --noEmit` passes with `supabase_signaling.ts` included.
- Depends on: T2.

### T7 — WebRTC transport seam

- Deliverables:
  - `web/src/net/transport.ts`: `NetTransport { send(lane: 'unreliable'|'reliable', bytes:
    Uint8Array): void; onMessage(cb: (lane, bytes) => void); state; rttMs(): number | null;
    close() }`. Lanes mirror ENet usage: reliable = ENet channel 0; unreliable = channels 1–2
    (`port/runtime/hle/slippi_net.cpp:326-327,446-450`).
  - `web/src/net/webrtc_transport.ts`: one `RTCPeerConnection`, two DataChannels created by
    the host with `negotiated: true` and fixed ids: `game` `{ordered:false, maxRetransmits:0}`,
    `ctrl` `{ordered:true}`; `binaryType = 'arraybuffer'`; RTT from `getStats()`
    `candidate-pair.currentRoundTripTime`; ICE servers fetched from `/api/turn-credentials`
    with an injectable fetcher; trickle ICE via `SignalingChannel` (T6).
  - `web/src/net/sab_ring.ts` + `wasm/net/sab_ring.h`: SPSC ring over `SharedArrayBuffer`,
    one per direction, frames `[u32 len][u8 lane][payload]`, head/tail as `Int32Array`
    indices with `Atomics.store/load` and `Atomics.notify`. Layout documented in
    `docs/NETCODE_MAP.md` §Transport. The C header is layout + inline read/write only.
  - `wasm/net/sab_ring_test.c` compiled in `wasm-probe.yml` with emcc (`-pthread` not needed
    for the layout test) to produce frames that a Node script decodes with `sab_ring.ts`
    (cross-language layout test).
  - `web/e2e/transport.spec.ts`: two pages, `BroadcastChannel` signalling, loopback
    connection (host candidates only, no STUN) .
- Acceptance (machine):
  - E2E: DataChannels open on both pages; `game.ordered === false`, `game.maxRetransmits === 0`,
    `ctrl.ordered === true`; 1,000 64-byte messages on `ctrl` arrive complete and in order;
    ≥ 95% of 1,000 on `game` arrive (loopback); `rttMs()` returns a finite number.
  - Vitest: `sab_ring` wraparound, full-buffer back-pressure (send returns false, never blocks),
    zero-length frames rejected, 10^5 random frames round-trip identically.
  - `wasm-probe.yml`: C-written frames decoded by TS byte-identically.
- Depends on: T3 (e2e harness), T5 (credential endpoint shape; mock it), T6 (signalling), T4
  (emsdk job, for the C side only).

### T8 — Asset manifest tooling (synthetic disc only)

- Deliverables:
  - `scripts/disc/gcdisc.py`: GameCube disc header + FST parser (boot.bin game id at 0x0,
    revision at 0x7, DOL offset at 0x420 as in `tools/extract_dol.py:12-18`; FST offset/size at
    0x424/0x428). Stdlib only.
  - `scripts/verify_iso.py`: size 1,459,978,240 and SHA-1
    `d4e70c064cc714ba8400a849cf299dbd1aa326fc` (spec §ISO e DOL); exits non-zero with a
    clear message otherwise; also enforces `GALE01` + revision 2 like `tools/extract_dol.py:13-16`.
  - `scripts/extract_fs.py`: FST → `assets-extracted/` (git-ignored).
  - `scripts/make_manifest.py`: → `assets/manifest.json` with `{path, size, sha256,
    stored: "<sha256>.bin", encoding: "br"|"gzip"|"identity", group}`; compression chosen per
    file (skip when it does not shrink ≥ 5%); groups from `scripts/asset_groups.json`
    (glob → `boot|menu|character:<name>|stage:<name>|music|movies|other`).
  - `scripts/upload_assets.sh`: `--dry-run` (default) lists objects missing from a given
    remote listing; real upload path uses `wrangler r2 object put` and runs only with
    credentials present.
  - `scripts/tests/fixtures/make_fake_disc.py`: builds a tiny valid GameCube image with a fake
    FST and dummy files at test time (never committed as a binary).
  - `ci.yml` job `python`: `python -m unittest discover -s scripts/tests`.
- Acceptance (machine):
  - Parser round-trips the synthetic image: file list, offsets, sizes equal the generator's.
  - `verify_iso.py` rejects wrong size, wrong hash, wrong game id, wrong revision (fixtures).
  - Manifest: deterministic output (two runs byte-identical), sorted keys, schema validated by
    `scripts/manifest_schema.json` (stdlib check, no jsonschema dependency or vendored small
    validator), every file in exactly one group, `stored` = sha256 of the **uncompressed** bytes.
  - Group rules: only asserted against synthetic names tonight. Whether the rules classify the
    real disc correctly is unknown until the ISO exists.
- Depends on: T0.

### T9 — Cloudflare deploy pipeline (credential-gated)

- Deliverables:
  - `scripts/build_web.sh` (Vite build → `web/dist`), `scripts/deploy.sh`
    (`wrangler pages deploy web/dist --project-name "$CF_PAGES_PROJECT" --branch "$BRANCH"`)
  - `.github/workflows/deploy.yml`: on push to `main` (production) and on PRs (preview);
    maps `secrets.CLOUDFLARE_API_TOKEN`, `secrets.CLOUDFLARE_ACCOUNT_ID` into env; first step
    checks presence and, if absent, emits `::notice::deploy skipped: no Cloudflare credentials`
    and exits 0. Deploy step `needs: [web, e2e]`.
  - `docs/DEPLOY.md`: one-time setup list for tomorrow (Pages project, Access app covering the
    Pages domain and the R2 custom domain, R2 bucket + CORS + CORP transform rule, TURN key,
    Supabase project + private-channel RLS), which secrets/vars go where, rollback command.
- Acceptance (machine):
  - actionlint green; on the PR the deploy job runs and ends with the skip notice (visible in
    `gh run view --log`).
  - `scripts/deploy.sh` has `set -euo pipefail` and refuses to run with a dirty tree or when
    `web/dist/_headers` is missing (tested by `scripts/tests/test_deploy_guard.sh` in CI).
- Depends on: T2, T3, T5.

### T10 — Session close

- Deliverables: `docs/PROGRESS.md` updated with T0–T9 status, measured numbers from T4
  (bench, runner specs, FMA hash result), open blockers; `docs/OPEN_QUESTIONS.md` updated.
- Acceptance: `scripts/check_docs.py` green; every task above has a merged PR link in PROGRESS.
- Depends on: all.

Recommended order: T0 → T1 → T4 → T2 → T3 → T5 → T6 → T8 → T7 → T9 → T10. T4 goes early
because it is the only evidence-producing task; T8 is independent and can fill CI wait time.

---

## 3. RISKS (browser target), ranked by probability × impact

P/I on a 1–3 scale. "Earliest measurement" names the first point at which a number exists.

### R1 — Recomp simulation too slow in WASM on mobile (P3 × I3 = 9)

- How it bites: per-frame cost exceeds the 3–6 ms mobile budget; rollback (up to 7 resims per
  tick, spec §Fase 0) multiplies it.
- Where: every guest memory access goes through `ppc::ld*/st*` with a range check and
  byteswap (`port/runtime/ppc/ppc.h:160-216`) plus RAM write tracking (`mark_ram_write`,
  `ppc.h:28-31`); registers live in `ppc::Context` memory, not locals; each function starts
  with an `if (c.entry)` chain (`port/generated.before-shake/guest_000.cpp:8-40`); fused
  multiply-add becomes a software `fma()` call in WASM (no hardware scalar FMA in base WASM),
  vs. one `VFMADD` on x86 (`ppc.h:279-290`).
- Mitigation: measure first. Candidate fixes in order of cost: make `mark_ram_write` a no-op in
  the web build if the renderer does not need it; `-O3` + `-flto` on the guest; remove the
  range check for proven-RAM addresses in the emitter; if `fma()` dominates, evaluate an exact
  double-double FMA inline. Fallback per spec: desktop-only v1.0. Source Port only under §1
  conditions.
- Earliest measurement: tonight (T4 `bench.json`: `fmadd` and `ld32/st32` ns/op WASM vs
  native). Full answer: Phase 0 with the DOL.

### R2 — The generated code does not build in CI within runner limits (P3 × I3 = 9)

- How it bites: 67 MB of C++ across 145 TUs (sample tree) plus a 2.4 MB trampoline table
  (`port/generated.before-shake/guest_table.cpp`) at `-O3`; upstream needed `/bigobj` and warns
  of "several GB of objects" (`port/CMakeLists.txt`, target `guest` and the
  `MELEE_PREBUILT_GUEST` comment). A standard GitHub-hosted runner has limited RAM,
  disk and a 6 h job cap; on this repository, which is public, those minutes are not metered
  (`docs/AGENT_RULES.md`, "CI budget"), so the limits that bite are RAM, disk and the cap.
- Where: emcc per-TU compile of `guest_*.cpp`, then `wasm-ld` linking one module.
- Mitigation: `-O2` for guest TUs if `-O3` blows memory; `ninja -j` tuned to RAM, not cores;
  cache objects keyed by generated-file hash (`actions/cache`); build the guest as a static
  library once per DOL/recomp change, not per PR (`workflow_dispatch` only); consider a larger
  or self-hosted runner. Also blocked by the DOL-delivery decision (§1).
- Earliest measurement: T4 prints runner `nproc/free/df` tonight; real numbers on first
  generated build (needs DOL, or the operator's decision on the stale tree — §4).

### R3 — WASM function size / irreducible control flow from multi-entry functions (P2 × I3 = 6)

- How it bites: functions with many `goto L_...` entry targets produce irreducible CFGs;
  LLVM's WebAssembly backend fixes them with dispatch blocks that grow code and slow loops;
  very large functions can hit engine limits on body size/locals or tier-up very slowly
  (baseline-only execution on mobile).
- Where: `if (c.entry) { … goto L_80002A64; … }` emitted for every re-entry point
  (`guest_000.cpp:8-40`), generated by `port/recomp/emit.py`; retry loops around `__setjmp`
  callers (`emit.py:160`).
- Mitigation: emitter option to split huge functions or to emit a single `switch` dispatcher
  at the top (reducible); only after measurement (AGENT_RULES rule 5 spirit).
- Earliest measurement: first emcc compile of generated code. Largest-function size could be
  measured from the stale tree with a script, but that was not done here (unknown).

### R4 — Blocking/threading model incompatible with the browser main thread (P3 × I2 = 6)

- How it bites: the simulation thread waits on a condition variable for DVD completion
  (`port/runtime/hle/hle_dvd.cpp:85`), the DVD worker is a detached `std::thread`
  (`:51,73`), audio has its own thread (`port/runtime/host/audio.cpp:71`). `Atomics.wait` is
  forbidden on the browser main thread, and a pthread cannot `await fetch`.
- Where: `hle_dvd.cpp:38-98`, `host/audio.cpp:45-71`, `host/host.cpp` main loop.
- Mitigation: `-sPROXY_TO_PTHREAD=1` so the simulation never runs on the main thread; DVD
  worker becomes a JS-side fetch/OPFS loader that fills a SAB buffer and `Atomics.notify`s;
  keep the "complete at a fixed virtual time" contract (`hle_dvd.cpp:38`, spec §2.3) and pause
  the simulation if data is late. Requires `crossOriginIsolated` (T3 proves the headers).
- Earliest measurement: T3 (isolation headers) tonight; DVD path at Phase 0.

### R5 — WebGPU renderer is a rewrite, and pipeline creation stalls on mobile (P3 × I2 = 6)

- How it bites: shaders are HLSL generated from GX state (`port/runtime/gx/gx_shader.h:1`);
  a WGSL generator is new work. ~6,555 prewarmed pipelines on desktop (PORT_COMPLETION.md
  "Beta 0.1 work"); `createRenderPipelineAsync` on mobile GPUs is slow and memory-heavy.
- Where: `gx::Backend::submit_frame(const Frame&)` (`gx/gx_core.h:271-291`) is the seam; D3D
  code in `gx/gx_d3d12.cpp` (2,864 lines) / `gx/gx_d3d11.cpp` (1,899 lines) is the reference.
- Mitigation: reuse aurora's TEV→WGSL generator if licence allows (spec §1.3); keep the
  existing generic-fallback-pipeline strategy (PORT_COMPLETION.md "Flicker, stutter…");
  prewarm from recipes only for the pipelines seen in the first N matches, not all 6,555.
- Earliest measurement: Phase 1. Headless CI WebGPU availability: unknown (T3 records it).

### R6 — FP fidelity: FPSCR modes cannot be expressed in WASM (P2 × I2 = 4)

- How it bites: the runtime maps PPC FPSCR rounding mode and NI (flush-to-zero) onto MXCSR
  (`port/runtime/ppc/ppc_runtime.cpp:230-237`). WASM always rounds to nearest and never
  flushes subnormals. If Melee sets RN≠0 or NI=1, WASM results differ from native → checkpoint
  oracle mismatch (spec §Fase 0 go/no-go "2400/2400 identici").
- Where: `update_mxcsr` callers (emitted for `mtfsf*`); `fctiw` uses `std::nearbyint`
  (`ppc.h:293-302`), which also depends on the current rounding mode natively.
- Mitigation: instrument `update_mxcsr` in the native build to log any non-default mode; if
  present, emulate the mode in software only at those sites.
- Earliest measurement: first native run with the DOL (log line count). Browser-vs-browser
  sync is unaffected (same binary).

### R7 — Browser-vs-browser desync despite identical `.wasm` (P1 × I3 = 3)

- How it bites: WASM is deterministic except NaN sign/payload of arithmetic results, relaxed
  SIMD, and anything imported from JS. A NaN stored to guest RAM and folded into the Slippi
  checksum could differ between x86 and ARM engines.
- Where: all `double` arithmetic in generated code and `ppc.h:272-309`; Emscripten libm calls
  that resolve to JS `Math.*` (check the final import section of the `.wasm`); threads touching
  guest RAM concurrently (`g_ram_watched`/`g_ram_versions`, `ppc.h:25-26`).
- Mitigation: build flags forbid `-mrelaxed-simd`, `-ffast-math`; CI check that the `.wasm`
  import list contains no `Math`-derived float functions; canonicalise NaNs in `fs()`/stores
  only if a desync is traced to it (rule 5).
- Earliest measurement: Phase 3 cross-device match with the checksum oracle; import-list
  check from the first wasm link.

### R8 — Download size and hosting limits (P2 × I2 = 4)

- How it bites: `.wasm` from ~67 MB of C++ may exceed Cloudflare Pages' 25 MiB per-file limit
  and eat into the 100 MB first-run budget (spec DoD item 4).
- Where: final link output; `web/public/_headers` caching.
- Mitigation: serve `.wasm` from R2 (same COEP/CORP rules as assets, spec §Header), Brotli,
  streaming compile (`WebAssembly.compileStreaming`), `-Oz` on cold guest TUs if needed.
- Earliest measurement: first link. Unknown until then.

### R9 — Netcode seam is invasive: ENet types leak into client state (P2 × I2 = 4)

- How it bites: `NetplayClient` stores `_ENetHost*`/`_ENetPeer*` and keys connection maps by
  peer pointer (`port/runtime/hle/slippi_net.h:194-213`); ENet also provides connect/timeout/
  disconnect semantics that DataChannels express differently. Matchmaking talks ENet to
  `mm.slippi.gg` (`slippi_net.cpp:945-954`).
- Mitigation: introduce `INetTransport` + opaque peer handle as a patch series, with the ENet
  implementation kept for native tests (spec §3.1); map ENet channels to lanes exactly as in T7;
  replace matchmaking with the fake backend (spec §3.4).
- Earliest measurement: T7 proves the JS side tonight; C++ side needs a compilable runtime.

### R10 — DOL/game-derived code cannot reach CI cleanly (P3 × I1 = 3, blocks R1–R3 measurements)

- How it bites: spec forbids the game build in Actions (`docs/SPEC_PIANO.md` §Pipeline di
  deploy item 4); the operator forbids building on the VPS. Until resolved there is no place to
  run Phase 0.
- Mitigation: operator decision (options: private encrypted artifact + decryption key as a
  secret; larger/self-hosted runner; Codespace). Record in `docs/OPEN_QUESTIONS.md` tonight.
- Earliest measurement: n/a — decision item.

---

## 4. DO NOT ATTEMPT TONIGHT

| Item | Why not |
|---|---|
| Emscripten build of the full `port/runtime` or any `melee_core_wasm` target | Needs `port/generated/` (needs the DOL); runtime pulls `windows.h` in 27 files incl. simulation-path `hle/exi_slippi.cpp` and `host/host.cpp`; nothing to run it against. Output unverifiable. |
| Building, copying or benchmarking from `port/generated.before-*` | DOL-derived (game data under `docs/AGENT_RULES.md` rule 1); stale vs. the runtime at the pin; tracked status unknown. It would answer R2/R3 early, so write it to `docs/OPEN_QUESTIONS.md` as an operator decision instead of doing it. |
| Linux headless native build (`melee_core_headless`) | Root `CMakeLists.txt:52-53` rejects non-MSVC; MSVC flags throughout `port/CMakeLists.txt` (`/EHsc /bigobj /fp:precise`); `tools/validate_native.py` needs `--iso` and a `.exe`. Large and not verifiable without the DOL. |
| `INetTransport` patch in `port/runtime/hle/slippi_net.cpp` | The file includes `windows.h` and cannot be compiled or exercised in CI tonight. Keep the seam JS-side (T7) and document the C++ seam in NETCODE_MAP. |
| WebGPU backend / WGSL TEV generator | No frames to render or compare; headless CI WebGPU availability unknown; a multi-week task that must start from RENDERER_MAP (T1), not code. |
| Aurora integration | `sourceport/extern/aurora` is not checked out; licence and API unreviewed. Reading it is a Phase 1 design task. |
| AudioWorklet output path, Gamepad mapping, touch overlay, PWA/service worker | No simulation to feed or drive; produces UI whose correctness cannot be machine-checked tonight. Low risk, can come later. |
| OPFS cache / on-demand DVD loader | Contract depends on the DVD HLE threading change (R4) and real manifest groups; testable only with fakes, and would be redesigned once `hle_dvd.cpp` is ported. |
| Real Supabase / Cloudflare setup, R2 uploads, first deploy | No credentials (by design: tomorrow). T5/T6/T9 must pass without them. |
| Reusing upstream `lobby/` (DHT, `server.py`, Caddy, Docker) | Native UDP/DHT or a self-hosted server — violates "no own server" and is not browser-reachable. |
| Recompiler changes (function splitting, dispatch rewrite, removing range checks) | No measurement exists yet (R1/R3); changing the recompiler blind violates "measure before optimising" and cannot be validated without the DOL. |
| `npm install`, `vite build`, `playwright install`, emsdk on the VPS | Forbidden by `docs/AGENT_RULES.md` rules 2–3 and the operator's global rules; all verification goes through Actions (`gh pr checks`, `gh run view --log-failed`). |
| A game-build workflow that expects the DOL in secrets | Contradicts the spec (§Pipeline di deploy item 4) pending the operator decision (R10). |
