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
