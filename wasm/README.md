# CI-only WASM toolchain probe

T4 builds synthetic instruction output from the real pinned recompiler and selected
runtime components. No DOL, ISO, game-generated C++, secrets, or local compiler is
needed. All compilation and execution belongs in GitHub Actions, never on the VPS.

`EMSDK_VERSION` pins **4.0.23**, listed in the official
[emsdk release manifest](https://github.com/emscripten-core/emsdk/blob/main/emscripten-releases-tags.json).
The independent `wasm-probe.yml` workflow runs on relevant PRs or manual dispatch.
It asserts the upstream HEAD against `docs/UPSTREAM_PIN.md` before building.

Included upstream tests (paths relative to `upstream/melee-unlocked/`):

| Target | Sources / scope |
| --- | --- |
| `port_load_test` | `port/tests/generate_load_test.py` invokes the actual decoder and emitter; 40 signed/unsigned halfword load cases, including indexed/update forms |
| `ram_watch_test` | `port/tests/ram_watch_test.cpp`; guest writes and texture invalidation through `ppc.h` |
| `ax_ucode_test` | `port/tests/ax_ucode_test.cpp` + `port/runtime/hle/ax_ucode.cpp`; DSP ADPCM, parameter blocks, output and mixer control |
| `texture_snapshot_test` | `port/tests/texture_snapshot_test.cpp` + `port/runtime/gx/gx_texture.cpp`; snapshot ownership, palette/mip changes, decoding and deduplication |

None of the four candidates is dropped: their include chains contain no Windows
headers. The patch adds `<stddef.h>` to `gx_texture.h`, which declares `size_t` at
line 14 without explicitly including its declaration. The original MSVC FMA
branch remains unchanged. CI builds native executables **before** applying any
patch, with the shim only supplying the missing MSVC integer intrinsics header;
`<immintrin.h>` and all four upstream FMA intrinsic bodies remain original.
No `_MSC_VER` spoofing or copied reference FMA implementation is used.

A successful build proves these components and this synthetic emitter sample
compile under emcc/clang. It does not prove every emitted opcode or a complete
recompiled game builds. `ppc_runtime.cpp` is deliberately not linked: its
`update_mxcsr` at lines 230–236 sets x86 rounding, FTZ and DAZ. No dummy MXCSR
implementation is supplied. Porting that functionality, host services and the
remaining runtime is outside this probe.

## Reading evidence

CTest runs all four upstream executables under Node. Any nonzero exit fails CI.
`fma_vectors` independently checks its SHA-256 implementation against empty,
`abc` and one-million-`a` known answers, then prints one lowercase digest.

The corpus is exactly 1,000,000 `(a,c,b)` triples, in the upstream argument order.
SplitMix64 starts at `0x4d454c4545574153` and advances three times per triple.
The first 24³ triples enumerate the Cartesian product of the edge table; these
include both zeros, signed subnormals, smallest normals, largest finite values,
infinities, positive/negative quiet and signaling NaNs, and rounding boundaries.
Thereafter every fourth triple places the random mantissas near ±1; the remainder
uses unrestricted random binary64 patterns.

For each triple, hashing order is `fmadd`, `fmsub`, `fnmadd`, `fnmsub` in double
precision, followed by the same four `fs(op(a,f25(c),b))` paths used by
`port/recomp/emit.py:603-610`. Each result contributes eight bytes, least
significant first, for 64,000,000 hashed bytes. No formatting conversions, NaN
canonicalization, sign removal, filtering or tolerance are permitted. The FMA
patch uses `fma(a,c,b)`, `fma(a,c,-b)`, `fma(-a,c,-b)` and `fma(-a,c,b)`;
negation is applied before the one rounded operation, preserving the intrinsic
operation's zero behavior rather than negating an already-rounded result.
NaN propagation can still differ; that is evidence the gate must expose.

Hash inequality fails the job. Equal hashes establish parity only for this corpus,
compiler/engine and default rounding environment (native FTZ/DAZ off), not a proof
of netcode determinism on every browser or nondefault FPSCR mode. The two digest
files remain available as artifacts even on mismatch. Do not weaken the gate to
make it green.

`wasm-probe/bench.json` contains native and WASM ns/op with toolchain/runner metadata;
it is uploaded in the `wasm-probe` artifact before the job ends, including on a
hash mismatch. Both variants execute 10⁷ dependent FMA calls and 10⁷ guest
`st32`/`ld32` round trips over 64 KiB of unwatched RAM. These helpers use big-endian
guest words on little-endian x86/WASM hosts (`ppc.h:179-183,200-205`); this is not a
measurement of the byte-reversed `ld32r/st32r` helpers. Compiler barriers prevent
elimination and store forwarding by the compiler; the FMA barrier also incurs a
stack spill/reload. Timings include loop/barrier/watch-check overhead, exclude
allocation and hashing, and have no performance threshold. The returned sinks
keep results observable, and the memory checksum must match.

Runner `nproc`, `free -m`, and `df -h` appear in the log. After a CI run, record its
URL, hashes and measured timings in `docs/PROGRESS.md`; no measurements have been
made locally. Compilation, runtime results and hash equality remain pending CI.

## Exact CI commands

The authoritative commands, including pin parsing, JSON assembly, strict digest
validation and artifact upload, are in
[the workflow](../.github/workflows/wasm-probe.yml). After checkout with recursive
submodules, the pin assertion and setup of Node 22 and emsdk from `EMSDK_VERSION`,
the build/run steps are exactly:

```bash
mkdir -p wasm-probe/out/native
git -C upstream/melee-unlocked diff --exit-code
for source in fma_vectors bench; do
  g++ -std=c++17 -O2 -mfma -ffp-contract=off -fno-fast-math \
    -Iwasm/compat -Iupstream/melee-unlocked/port/runtime/ppc \
    "wasm/probe/$source.cpp" -o "wasm-probe/out/native/$source"
done
wasm-probe/out/native/fma_vectors > wasm-probe/native.sha256
wasm-probe/out/native/bench > wasm-probe/native-bench.json
bash scripts/apply_patches.sh
bash scripts/apply_patches.sh
emcmake cmake -S wasm/probe -B wasm-probe/out/wasm -DCMAKE_BUILD_TYPE=Release
cmake --build wasm-probe/out/wasm --parallel 2
ctest --test-dir wasm-probe/out/wasm --output-on-failure
node wasm-probe/out/wasm/fma_vectors.js > wasm-probe/wasm.sha256
node wasm-probe/out/wasm/bench.js > wasm-probe/wasm-bench.json
```

CMake supplies `-O3 -fwasm-exceptions -ffp-contract=off -fno-fast-math` and
`-sENVIRONMENT=node -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=1`. Memory growth permits
the RAM watch test's 24 MiB guest buffer. Synthetic emitted C++ is written only
inside ignored `wasm-probe/out/`; the generator runs with bytecode writes disabled.
Applying twice checks idempotence. The script processes `patches/*.patch` in sorted
shell-glob order, accepts an already-applied patch only after reverse-checking it,
and fails loudly on stale or partial patches. Run it only on the CI checkout.

Permitted local checks are `bash -n scripts/apply_patches.sh`, YAML/Python syntax
validation, checking referenced paths, and:

```bash
git -C upstream/melee-unlocked apply --check "$PWD/patches/0001-ppc-portable-fma-and-intrinsics.patch"
```
