# Open questions — operator decisions required

These are decisions the agent cannot take alone: they need the operator's own accounts,
hardware, files, or a judgement call about scope. Each entry says what is blocked until
it is answered.

## Q1 — The game disc (blocks Phase 0 entirely)

Nothing that compiles the game can start without `main.dol`, extracted from the
operator's own NTSC-U 1.02 (GALE01) ISO.

- Expected SHA-1 of the ISO: `d4e70c064cc714ba8400a849cf299dbd1aa326fc`,
  size 1,459,978,240 bytes.
- What is needed: a link the build machine can fetch, or the file itself uploaded to a
  private location.
- **Blocked until answered**: `scripts/extract_dol.py` runs, the recompiler runs, Phase 0.

## Q2 — Where the DOL lives for CI

GitHub Actions secrets are capped at 48 KB; `main.dol` is roughly 4.5 MB. The
specification (`docs/SPEC_PIANO.md`, deploy pipeline item 4) says the game build must not
run in Actions at all for this reason.

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
