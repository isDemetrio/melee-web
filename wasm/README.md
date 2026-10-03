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

CTest runs all four upstream executables under Node, plus `fma_shim_test` (ours, built
from `wasm/probe/fma_shim_test.cpp` through the patched `ppc.h`), which pins the sign of an
exact zero and the four wrappers' sign conventions. Any nonzero exit fails CI.
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
canonicalization, sign removal, filtering or tolerance are permitted. The FMA patch
routes the four operations through `wasm_compat::fma` (a `std::fma` call with the guard
described under "The zero-sign class" below) and `wasm_compat::fmsub`/`fnmadd`/`fnmsub`
(single-rounding calls with a negated operand, which return a NaN operand unnegated --
"The NaN-sign class"). Negation is applied before the one rounded operation, preserving
the intrinsic operation's zero behavior rather than negating an already-rounded result.
NaN bits that the platform's own arithmetic produces can still differ; that is evidence
the gate must expose.

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
input-class count matrix, results and native NaN results per path, a kind × path
count matrix, and the first differing `(a, c, b)` with both result patterns for each
kind, for each kind and path, and for the first gate violation. Exit status: 0 pass,
1 gate failure, 2 malformed/truncated dump or internal inconsistency (equal
hashes must mean zero divergences and vice versa).

The per-path view exists because the kind table alone cannot tell a shim that computes
the wrong NaN from a rounding step that loses one: a count concentrated on a single
operation points at that operation's arithmetic, while the same count on all four
single paths and none on the doubles points at `ppc::fs`. It was added together with the
last fix, and that run came back bit-exact, so it has not had to discriminate anything
yet; it is kept because the next divergence will need exactly that distinction.

The asserted property is "no divergent result outside the permitted class", not
"hashes equal" and never a mismatch count. By default the permitted class is
empty, so a plain run is bit-exact; that is what CI runs, and since run 36677219860
a plain run passes. With
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

## Finding: native and WASM FMA results are bit-identical (2026-09-30)

**Latest classified run** (36677219860, 2026-09-30 06:15 UTC, emsdk 4.0.23, Node 22.23.3):
8,000,000 results, **0 divergent**, both sides
`sha256 6b79b92a3bc1fb1699853e1c8c671d37aaf64f82378bcb9d393387480f66afc9`.
The strict gate (permitted class: none) passes, and no exemption was used.

| divergence | gate | total | ordinary | subnormal-in | inf-in | nan-in |
| --- | --- | --- | --- | --- | --- | --- |
| nan-vs-number | FAIL | 0 | 0 | 0 | 0 | 0 |
| nan-sign | FAIL | 0 | 0 | 0 | 0 | 0 |
| nan-payload | FAIL | 0 | 0 | 0 | 0 | 0 |
| zero-sign | FAIL | 0 | 0 | 0 | 0 | 0 |
| subnormal | FAIL | 0 | 0 | 0 | 0 | 0 |
| value | FAIL | 0 | 0 | 0 | 0 | 0 |

This is not parity on an empty region: 7,085 results per double path and 6,589 per single
path are NaNs on the native side, and every one of those bit patterns matches.

Four measured runs got there. Each line is a change to `wasm/compat/fma.h`, and the
`nan-in` column is where all of the residual lived:

| run | shim | divergent | nan-sign | nan-payload | zero-sign |
| --- | --- | --- | --- | --- | --- |
| 36647200912 | `std::fma` directly | 20264 | 18680 | 1464 | 120 |
| 36661984096 | + zero-addend guard | 20144 | 18680 | 1464 | 0 |
| 36672598366 | + NaN guard in the three negating wrappers | 780 | 64 | 716 | 0 |
| 36677219860 | + NaN guard in `fma` itself (the `fmadd` path) | 0 | 0 | 0 | 0 |

**The lesson, because it was paid for twice.** The residual after each of the first three
runs was explained as the platform's NaN latitude — the WASM specification does leave the
sign and payload of a NaN produced by arithmetic to the engine, and the first three tables
were consistent with that story. It was wrong both times it was used: the first residual
was musl's zero-addend shortcut and our own operand negation, and the last one was `fmadd`
simply having no NaN guard while its three sibling wrappers did. With a guard on all four
operations nothing diverges, including NaN payloads, on a corpus that feeds 51,656 NaN
operands. A divergence that the shim can explain is a shim bug until the shim has been
ruled out by measurement, not by a plausible mechanism.

**What it means for determinism.** The netcode peers are browsers only (Slippi
Dolphin matchmaking is out of scope for v1.0, `docs/SPEC_PIANO.md`), so the native
x86 build is the *fidelity reference*, not a peer. Native-vs-WASM bit-exactness now
holds for this corpus, this compiler and the default rounding environment (native
FTZ/DAZ off). It does not establish browser-to-browser determinism: the peers are
engines, not this one Node build, and the arm64 comparison in "Next measurements"
is the run that speaks to that.

### The zero-sign class: a defect in musl's `fma`, fixed in the shim

The 120 `zero-sign` divergences are not IEEE-754 latitude for the sign of a zero from an
FMA. For the first one the probe printed,

```
fnmsub a=0000000000000001 c=0000000000000001 b=0000000000000000
       native=8000000000000000 wasm=0000000000000000
```

the operands are 2⁻¹⁰⁷⁴ each, so the exact product is −2⁻²¹⁴⁸: nonzero, and it must round
to −0. The pinned toolchain returned +0 because musl's `fma.c` short-circuits a zero
addend to `return x*y + z` (`:56-60`, and again at `:134-136`), which rounds the product
and then adds the zero. Upstream fixed that in musl git and Emscripten main by returning
the product; `wasm/compat/fma.h` applies the same fix in our shim, with the extra
condition upstream gets for free from its earlier zero/infinity/NaN shortcut. A sign of a
stored zero is observable through an integer sign test and through division, so this was
a real defect and not something to exempt.

Evidence, kept apart on purpose:

- measured before the fix: 120 `zero-sign` divergences (24 of them with ordinary
  operands), run 36647200912;
- verified locally, without a compiler: every expected bit pattern in
  `wasm/probe/fma_shim_test.cpp` against the platform's correctly rounded `math.fma`
  (CPython 3.14.7);
- **measured after the fix**: `zero-sign 0` in run 36661984096, with `nan-vs-number`,
  `subnormal` and `value` still 0.

### The NaN-sign class: our own negation, fixed in the shim

`nan-sign` was not the engine's NaN latitude either. `fmsub`, `fnmadd` and `fnmsub` are
written as one `fma` call with a negated operand, and negating a NaN operand flips the sign
of the NaN that comes back. The x86 instructions these wrappers stand in for do not do that.
The probe's first `nan-sign` example in run 36661984096:

```
fnmadd a=7ff8000000000001 c=0000000000000000 b=0000000000000000
       native=7ff8000000000001  wasm=fff8000000000001
```

All 18 680 had a NaN operand and none had an ordinary one. `wasm/compat/fma.h` now returns
the first NaN operand quieted and unnegated -- x86's priority, multiplicand then multiplier
then addend -- for those three wrappers only. `docs/PORT_CHANGES.md`, "The NaN-sign class",
records the same.

**Measured, and the first fix was incomplete.** Run 36672598366 took `nan-sign` from 18 680
to 64 and `nan-payload` from 1 464 to 716 -- not to zero, because `fmadd` had been left out.
Its first example of each class is on an `fmadd` path:

```
fmadds a=fff8000000001234 c=7ff8000000000000 b=0000000000000000
       native=fff8000000000000  wasm=7ff8000000000000     (nan-sign)
fmadd  a=7ff0000000000000 c=0000000000000000 b=fff8000000001234
       native=fff8000000001234  wasm=fff8000000000000     (nan-payload)
```

`fmadd` reaches `wasm_compat::fma` with no wrapper in between, and that function had no NaN
guard, so a NaN operand went into the engine's own arithmetic and came back as the engine's
NaN. The first case is two NaN operands where `NaN * NaN` lost the multiplicand's sign; the
second is `inf * 0 + NaN` returning the invalid-operation default NaN instead of the NaN
operand. `fma` now carries the same guard (run 36677219860, `nan-sign` 0 and `nan-payload`
0), and the three wrappers keep their own because they negate an operand *before* calling
it, so a guard inside `fma` would see an already flipped sign.

The priority order is therefore no longer an expectation: with the guard on all four
operations, 51 656 NaN-operand results match the native reference bit for bit, multi-NaN
cases included.


**Next measurements, in order.**

1. Done: run 36677219860, 8,000,000 results, 0 divergent, identical digests. The
   native-vs-WASM corpus comparison is closed; the strict gate passes and no exemption is
   in use.
2. Done: runs 37097105278 and 37101091371 (`ci/wasm-arm64-parity`). The first measured
   3,040 divergent results out of 8,000,000 between WASM-x86 and WASM-arm64 -- all of them
   `nan-sign`, all of them an invalid operation with no NaN operand -- and the second, after
   `wasm/compat/fma.h` pinned that NaN to the reference's indefinite value, measured 0, with
   two identical digests. The browser-to-browser question is answered by measurement rather
   than assumed, and the answer was "the engine differs" until the shim stopped letting it.
3. With the running build: count NaN operands and NaN results of every
   `fmadd`/`fmsub`/`fnmadd`/`fnmsub` (and the rest of the FP helpers) over real
   gameplay and replays. It is no longer needed to decide whether NaN bits may differ —
   they do not, on this corpus — but it would say whether the guards cost anything on
   the hot path and whether the corpus's NaN density resembles gameplay's.

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
made locally. Compilation, runtime results and hash equality are now measured — see the
"Finding" above and `docs/PROGRESS.md`, "Measured numbers".

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
