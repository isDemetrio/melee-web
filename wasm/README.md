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
With `--dump FILE` it also writes every result's raw bits (8 bytes, little-endian,
in hashing order: 64,000,000 bytes). The WASM build links `-sNODERAWFS=1` so
that file lands on the runner's disk, not in Emscripten's in-memory FS.

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

The gate is `fma_vectors --compare native.bin wasm.bin`, run by the native
binary after both dumps exist. It regenerates the corpus with integer code only,
re-hashes both dumps (the workflow checks these equal the digests each side
printed), and classifies every differing result **from the two result bit
patterns**, never from the input class alone. Two independent axes:

- *input class* of the operands actually fed (single paths see `f25(c)`),
  highest precedence first: `nan-in`, `inf-in`, `subnormal-in`, `ordinary`
  (every operand normal or ±0);
- *divergence kind*, first matching rule wins: `nan-vs-number` (NaN-ness
  differs), `nan-sign` (both NaN, sign bit differs), `nan-payload` (both NaN,
  same sign, payload or quiet bit differs), `zero-sign` (+0 vs −0), `subnormal`
  (any operand or either result subnormal), `value` (everything else).

It prints both SHA-256 digests, results/divergent per input class, a kind ×
input-class count matrix, and the first differing `(a, c, b)` with both result
patterns for each kind and for the first gate violation. Exit status: 0 pass,
1 gate failure, 2 malformed/truncated dump or internal inconsistency (equal
hashes must mean zero divergences and vice versa).

The asserted property is "no divergent result outside the permitted class", not
"hashes equal" and never a mismatch count. By default the permitted class is
empty, so a plain run is bit-exact; that is what CI runs. With
`--allow-nan-payload-differences` the permitted class is exactly `nan-payload`
on non-`ordinary` inputs. Every other cell (any `ordinary` divergence, whatever
its kind; any sign difference including a NaN's; any NaN-ness difference; any
subnormal or value difference) still fails, so a new divergence in any other
class breaks the gate even with the switch on. The switch exists for a later,
deliberate operator decision (see `docs/OPEN_QUESTIONS.md` Q7), not for CI.

A pass establishes parity only for this corpus, compiler/engine and default
rounding environment (native FTZ/DAZ off), not a proof of netcode determinism on
every browser or nondefault FPSCR mode. The digests and the classification
report remain available as artifacts even on failure (the 64 MB dumps are not
uploaded; they are reproducible from the pinned sources). Do not weaken the gate
to make it green.

## Finding: native and WASM FMA results are not bit-identical (2026-09-29)

**Measured.** The first CI run of the hash-only probe failed its gate: the SHA-256
over all 8,000,000 results differed between the native build (unpatched x86
`_mm_f*_sd` intrinsics, `g++ -O2 -mfma`) and the WASM build (patched `std::fma`,
emsdk 4.0.23, Node 22). That is the whole measurement so far: one bit of
information, "not identical". The run URL and the two digests were not recorded
in this repository when the classifier was written; the hashing order is unchanged,
so the next run's per-side digests are directly comparable with that run's log.

**Not yet measured:** which results differ, how many, and in which class. The
classifier above exists to produce exactly that; no count in this file comes from
a run until the table from CI is pasted into `docs/PROGRESS.md`.

**What it means for determinism.** The netcode peers are browsers only (Slippi
Dolphin matchmaking is out of scope for v1.0, `docs/SPEC_PIANO.md`), so the native
x86 build is the *fidelity reference*, not a peer. Two outcomes matter:

- Any divergence in `ordinary`, `zero-sign`, `subnormal`, `value` or
  `nan-vs-number` is a real arithmetic bug in the patch or in Emscripten's `fma`
  and blocks the online phase outright.
- If every divergence is confined to NaN results (`nan-payload`, and possibly
  `nan-sign`), then the game's arithmetic is unaffected **if the game never feeds
  NaN into these operations** or lets a NaN reach state that is compared or
  checksummed. **That condition is NOT verified.** It needs the running build (the
  DOL, `docs/OPEN_QUESTIONS.md` Q1). Note too that `nan-sign` is not covered by
  `--allow-nan-payload-differences`: a sign difference is gated regardless.

Expectation, to be confirmed or refuted by the table (not a measurement): x86
FMA returns the first NaN operand quieted, without applying the instruction's
negation, and its invalid-operation default NaN is negative (`0xfff8…`).
Emscripten's `fma` has no hardware FMA to lower to and routes non-finite operands
through ordinary WASM arithmetic, whose NaN sign and payload the WASM spec leaves
nondeterministic, after the patch has already negated the operand. If so, the
divergences would be `nan-sign`/`nan-payload` on `nan-in`/`inf-in` inputs.

**Next measurements, in order.**

1. Rerun this workflow and record the classification table verbatim.
2. Run the same WASM binary on an arm64 runner and compare WASM-x86 against
   WASM-arm64 dumps. That, not native-vs-WASM, is the browser-to-browser netcode
   question; ARM's default NaN is positive, so NaN sign is a candidate there too.
3. With the running build: count NaN operands and NaN results of every
   `fmadd`/`fmsub`/`fnmadd`/`fnmsub` (and the rest of the FP helpers) over real
   gameplay and replays. Zero NaNs is what would make any NaN-only divergence
   harmless; one NaN reaching the per-frame checksum makes it a desync.

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
wasm-probe/out/native/fma_vectors --dump wasm-probe/native.bin > wasm-probe/native.sha256
wasm-probe/out/native/bench > wasm-probe/native-bench.json
bash scripts/apply_patches.sh
bash scripts/apply_patches.sh
emcmake cmake -S wasm/probe -B wasm-probe/out/wasm -DCMAKE_BUILD_TYPE=Release
cmake --build wasm-probe/out/wasm --parallel 2
ctest --test-dir wasm-probe/out/wasm --output-on-failure
node wasm-probe/out/wasm/fma_vectors.js --dump wasm-probe/wasm.bin > wasm-probe/wasm.sha256
node wasm-probe/out/wasm/bench.js > wasm-probe/wasm-bench.json
wasm-probe/out/native/fma_vectors --compare wasm-probe/native.bin wasm-probe/wasm.bin \
  > wasm-probe/fma-divergence.txt
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
