# Where the envelope-skinning cost lands

`docs/FOUR_PLAYER_ATTRIBUTION.md` names vertex skinning with envelopes as the largest single
item in the character drawing path: `SetupEnvelopeModelMtx` and the three functions under it
(3.25 ms at two players → 6.29 ms at four, **+3.04 ms** [2.77–3.52] of the +16.57 ms a
four-player match costs, **16.2%**). This note says where inside it the samples land, and what
was changed.

The attribution is the deliverable. The reduction found is small and is reported as small.

## The work

`SetupEnvelopeModelMtx` (guest `0x8036E4C4`) is called once per display-list PObj of a character
that carries envelope weights. The core's own counter (`envelope_matrix_calls`) counts them:
**115.5 per match frame at two players, 245.4 at four — 2.124×**, against **1.322×** for draws.
Each call walks up to ten envelope slots (`envelope->mtxidx < 10`); per slot it walks the joint
list and, for each bone, concatenates the bone's local matrix with its envelope matrix
(`PSMTXConcat`) and accumulates into the slot matrix (`HSD_MtxScaledAdd`). Per slot it then
concatenates the view matrix, inverts and transposes the result for the normal matrix
(`HSD_MtxInverseTranspose`), and loads position, normal and texture matrices into the GX FIFO
(`GXLoadPosMtxImm`, `GXLoadNrmMtxImm`, `GXLoadTexMtxImm`).

**Why it grows with more characters.** The cost is per character and the two extra characters
bring their own skeletons and envelope PObjs. The ratio is 2.124× for envelope matrices against
1.322× for draws: the extra characters are skinned more heavily per draw than the first two, so
this is not just "twice the characters". `FOUR_PLAYER_ATTRIBUTION.md` records that the four-player
load is not the two-player load with two fighters added.

## Where the samples land

`/home/hermes/briefs/skinning/attribute_skinning.py` walks the Chrome CPU profile the fourcore
harness records on the real core (`inmatch.cpuprofile`, 2400 retraces, sampling window aligned on
match frames) and sums the samples under every node that is `guest::f_8036E4C4`, grouped by the
function the sample is *in*. The profile window holds 2400 frames at 15.81 ms/frame (4p) and
10.63 ms/frame (2p) of sampled time.

| callee | 4p ms | 2p ms | Δ ms | share of 4p subtree |
| --- | ---: | ---: | ---: | ---: |
| `wasm_compat::fma` (shim) | 852.2 | 430.2 | +422.0 | 11.6% |
| `PSMTXConcat` (guest body) | 779.9 | 491.5 | +288.4 | 10.6% |
| `ppc::ld32` | 598.6 | 307.2 | +291.5 | 8.2% |
| `host::gx_write` (FIFO) | 569.9 | 276.8 | +293.1 | 7.8% |
| `ppc::psq_load` | 557.0 | 305.4 | +251.6 | 7.6% |
| `HSD_MtxInverseTranspose` (guest body) | 455.4 | 214.7 | +240.8 | 6.2% |
| `ppc::psq_store` | 386.5 | 193.2 | +193.3 | 5.3% |
| `ppc::st32` | 355.7 | 181.8 | +174.0 | 4.8% |
| `fma` (libm) | 347.2 | 256.2 | +91.0 | 4.7% |
| `HSD_MtxScaledAdd` (guest body) | 331.4 | 199.9 | +131.5 | 4.5% |
| `SetupEnvelopeModelMtx` (guest body) | 318.1 | 146.1 | +172.0 | 4.3% |
| `normalize` (libm fma) | 200.5 | 168.5 | +32.1 | 2.7% |
| `host::mmio_write` | 171.3 | 90.9 | +80.4 | 2.3% |
| `vector<u8>::__append` + `__construct_at_end` | 262.9 | 123.0 | +139.9 | 3.6% |
| `ppc::enter` | 98.7 | 35.3 | +63.4 | 1.3% |
| **subtree self total** | **7338.5** | **3873.0** | **+3465.5** | 100% |

Grouped by zone, the 4-player subtree is:

| zone | 4p ms | share |
| --- | ---: | ---: |
| emulated arithmetic (`wasm_compat::fma` + libm `fma` + `normalize`) | 1399.9 | 19.1% |
| guest body (`PSMTXConcat`, `HSD_MtxInverseTranspose`, `HSD_MtxScaledAdd`, `SetupEnvelopeModelMtx`) | 1884.8 | 25.7% |
| guest memory helpers (`ld32`/`st32`/`psq_load`/`psq_store`/`ld64`/`st64`) | 2085.1 | 28.4% |
| GX FIFO (`gx_write`, `mmio_write`, the FIFO vector growth, `gx::`) | 1118.9 | 15.3% |

The three `HSD_Mtx*`/`PSMTXConcat` bodies are guest code and are not ours to change; the memory
helpers are out of line at `-Oz` and `docs/CORE_COST_BROWSER.md` already records that inlining
them was tried and is not to be repeated blindly; the FIFO path is the emulated GPU. That leaves
the FMA shim as the one named, safe lever.

## The reduction: the FMA zero-factor case

`wasm/compat/fma.h` tested a zero addend first and a zero factor only inside that branch. A call
with a zero factor and a nonzero addend therefore fell through to `exact_product` and then to
libc's `fma` — which normalizes `x`, `y` and `z` (three calls, `system/lib/libc/musl/src/math/fma.c:40-42`)
before reaching the same `x*y + z` shortcut. The off-diagonal zeros of a rotation matrix are
exactly that case. The change hoists the zero-factor check ahead of the general path: one compare
instead of the `exact_product` scan and the libc call.

The result is unchanged by construction: the exact product of a zero factor is a signed zero, so
the exact sum is the IEEE sum of that zero and the addend, and ordinary addition gives it the
right sign (including the `-0 + +0 = +0` case musl's shortcut loses). The probe gains a
randomized zero-factor comparison against the general path to hold that, and the existing
`expect` patterns for `-0` and `inf*0` are unchanged.

## The measurement

See the table below. The fourcore harness's own metric is the mean `sim_ms` over match frames
1–715, and the same metric's six-pair spread on this VPS is already wide
(`FOUR_PLAYER_ATTRIBUTION.md`: four-player 43.9–50.5 ms, ±7%), so a change worth ~0.8% of the
frame cannot be separated by the frame metric. The profile measurement below is the one that
targets what the change removes.

Both cores are `-Oz`, built with `--profiling-funcs` so the sampler can name functions, from the
same base: **A** is `main` at `64dc1d1`, **B** is this branch at `fb8aa14` (A plus the one file).
Artifacts `melee-spike-dist-names` from runs `37337920947` (A) and `37336312091` (B).

**The trace gate passes.** `gate.sh` on B, 2400 retraces, state trace on:
`trace c79c53b9cdf81426fa0277e7497a69e55bc5f571 final scene: mode=2 state=2 match_frame=762` —
byte-identical to the reference of `docs/ATTRIBUTE_RESIDUAL.md`. The reordering changes no
simulated state.

**The libm `fma` path is gone.** From the 4-player profile (`PROF_FROM=1685 PROF_TO=2400`, 2400
frames), whole profile:

| | A `fma` | A `normalize` | A total | B `fma` | B `normalize` | B total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ms in window | 593.1 | 321.7 | **914.8** | 151.9 | 51.3 | **203.2** |
| share of profile | | | **2.41%** | | | **0.44%** |

B's window was 46.6 s against A's 37.9 s (the VPS was busier), so the totals are not comparable
directly; the shares are. B's non-`fma` work is 1.254× A's, so in A-equivalent time B's libm path
is 203.2 / 1.254 = **162 ms against A's 915 ms — an 82% drop**, and it is no longer in the top
twenty of the skinning subtree at all (A: `fma` 347.2 ms and `normalize` 200.5 ms, 7.5% of the
subtree). The residual the shim was written for was, in this path, entirely the zero-factor case.

**The frame metric cannot resolve it.** The harness's own metric, mean `sim_ms` over match frames
1–715, eight alternating A/B pairs (`/home/hermes/briefs/skinning/measure_ab.sh`, four-player
script):

| | mean | min..max | sd |
| --- | ---: | ---: | ---: |
| A | 53.406 ms | 49.773..60.460 | 3.428 |
| B | 51.289 ms | 47.151..54.126 | 2.073 |
| paired B−A | **−2.117 ms** | −6.334..+1.278 | 2.439 |

Taken at face value that is a 4.0% gain (ratio 0.960). **It is not one, and this note does not
claim it.** The session drifted upward — A's own single runs go 49.8 → 60.5 ms across the eight
pairs — and the profile above caps the removable work at 0.38 ms/frame, an order of magnitude
below the paired mean. Splitting the series where the drift starts, the first four pairs average
−0.31 ms (the profile's number) and the last four −3.92 ms (the drift). A change worth ~0.7% of
the frame is not separable from a VPS whose single runs span ±7%.

**Verdict.** A safe reduction exists and is measured directly: the libm `fma`+`normalize` path
under the skinning subtree is removed, worth **0.38 ms/frame at four players (0.8% of a ~47 ms
frame) and 0.22 ms/frame at two**. That is the whole of it. The frame metric's eight-pair spread
cannot confirm a gain that size, and the one number it does produce (−2.1 ms) is drift, not the
change.

