# Working rules for AI agents in this repository

Read this before editing anything. It encodes constraints that have already been
established, so you do not have to rediscover them.

> This file is intentionally named `AGENT_RULES.md` rather than `AGENTS.md`: the
> latter is a protected agent-instruction file that requires explicit operator
> approval to create. Move the content there if you want it auto-loaded by Codex.

## Non-negotiable

1. **Never commit game data.** No `*.iso`, `*.gcm`, `*.dol`, `*.gci`, no
   `upstream/melee-unlocked/port/generated/`, no extracted disc filesystem. The repo
   is private but game data still stays out of it. If a task seems to require
   committing one of these, stop and write it to `docs/OPEN_QUESTIONS.md` instead.
2. **Never build on the operator's VPS.** It has 2 vCPU, 3.7 GB RAM, no compiler
   toolchain, no sudo, and no swap. Compiling the recompiled game there would take the
   machine down. All compilation happens in GitHub Actions or a Codespace.
3. **Never run `npm install`, `vite build`, `playwright install` or any bundler on the
   VPS.** Write source, commit, push, and let CI verify. Read CI results with
   `gh run view --log-failed`.
4. **Never modify `upstream/melee-unlocked` in place.** It is a pinned submodule. Port
   changes go in `patches/` as a patch series, or in a separate fork. Record the reason
   for every port change in `docs/PORT_CHANGES.md`.
5. **Do not change Slippi netcode logic or the recompiler to "fix" a desync** before the
   first divergent frame has been identified with the per-frame checksum oracle.

## Engineering rules

- One logical change per branch and per PR. Never mix renderer and networking work.
- Every claim in a document or PR description must name its evidence: a file path, a
  command, a measured number. "Should work" is not evidence.
- The native build is the reference for correctness. The checkpoint comparison
  (2400 CPU/RAM/ARAM hashes) is the oracle for determinism. Never relax it to make a
  test pass.
- Measure before optimising. Record numbers in `docs/PROGRESS.md`.
- Update `docs/PROGRESS.md` at the end of every working session: state, next step, open
  blockers. A new session must be able to resume from that file alone.
- Prefer the smallest dependency that does the job. The UI is TypeScript + Vite, no
  framework.

## Determinism rules (they are easy to violate silently)

- No `-ffast-math`, no `-mrelaxed-simd`.
- Never use host `libm` or JavaScript `Math.*` inside the simulation path.
- PowerPC `fmadd`/`fmsub` must be emulated exactly; never let the host compiler contract
  a multiply-add into an FMA.
- Never use `emscripten_sleep` or Asyncify in the simulation path.

## Secrets

Cloudflare and Supabase credentials live in CI secrets and Pages environment
variables. Never in the repo, never in a client bundle. The only credential the browser
may receive is a short-lived TURN credential minted by `/api/turn-credentials`.
