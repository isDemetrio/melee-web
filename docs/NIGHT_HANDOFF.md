# Night handoff — state at 2026-09-29 23:20 UTC

Written by the orchestrator at the end of the first working session, so the overnight worker
does not have to rediscover any of it. Read this together with `PROGRESS.md`.

## CI is the source of truth, and it is red

Three workflows, all failing at the time of writing. The failures are real and each one is
described below with the exact symptom that was observed.

### 1. `CI` / `Browser tests (Chromium)` — Playwright now runs, 5 of 8 pass

The servers start correctly now (`serving .../melee-web/dist on http://127.0.0.1:4173 with
_headers (4 rules)`). Three tests fail:

- `boot.spec.ts:35 › unlocks audio on the click, then goes to the lobby` (~15 s) —
  `expect(locator).toContainText(expected) failed`.
- `rtc.spec.ts:27 › negotiates over a real RTCPeerConnection and moves packets both ways`
  (~30 s).
- `rtc.spec.ts:71 › a third tab is refused with a message instead of being silently paired`
  (~30 s) — `element(s) not found`.

The 30 s durations smell like a wait on a state the UI never reaches, so start by checking
whether the lobby screen renders the text and the selectors the tests look for, rather than
by loosening the timeouts. Read the actual assertion output with:

```
gh run view <id> --log-failed 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -80
```

### 2. `CI` / `Repo hygiene and workflow lint` — went red after the wasm-probe change

This job was green before `.github/workflows/wasm-probe.yml` was modified. Read the failing
step before assuming it is the game-data gate.

### 3. `Pages Functions` — `wrangler pages functions build` chokes on a dependency

Typecheck and tests pass (the Cloudflare type coupling was fixed: `functions/types.ts` now
owns the context types). The failure is the bundle step:

```
error: Could not resolve "nanoid/index.d.ts"
```

`nanoid` is a transitive dependency and its type declaration is being fed to esbuild. Either
pin a wrangler version that handles it, or replace this check with something that does not
depend on wrangler's bundler. Do not simply delete the check: it is the only thing that
proves the Functions actually bundle.

## 4. `WASM toolchain probe` — red on purpose, and this is the most valuable output

The probe compiles, runs, and now classifies every divergence between x86 hardware FMA and
WASM `fma()`. Latest table (native vs wasm, 20 264 divergent results):

| divergence      | count | ordinary | subnormal-in | nan-in |
| --------------- | ----- | -------- | ------------ | ------ |
| nan-vs-number   | 0     | 0        | 0            | 0      |
| nan-sign        | 18680 | 0        | 0            | 18680  |
| nan-payload     | 1464  | 0        | 0            | 1464   |
| zero-sign       | 120   | 24       | 96           | 0      |
| subnormal       | 0     | 0        | 0            | 0      |
| value           | 0     | 0        | 0            | 0      |

**No numeric value differs, and no subnormal result differs.** Everything that diverges is
either NaN propagation or the sign of a zero result.

The `zero-sign` row is the one that deserves attention: 24 of those cases have fully ordinary
inputs, e.g.

```
fnmsub a=0000000000000001 c=0000000000000001 b=0000000000000000
       native=8000000000000000  wasm=0000000000000000
```

A sign-of-zero difference is observable through an integer sign test on a stored float (and
through division), so by the same argument that justified not exempting NaN *sign* flips, it
is not automatically safe. Investigate before deciding: is it IEEE-754's permitted latitude
for the sign of an exact zero from an FMA, or a real defect in the WASM implementation? The
answer changes what the project can promise about cross-platform determinism.

### A second, separate problem in this job

```
error: patch failed: port/runtime/ppc/ppc.h:7
error: patch failed: port/runtime/gx/gx_texture.h:1
```

The patch applies cleanly against the pinned upstream when checked by hand
(`git apply --check` → OK), so the workflow is almost certainly applying it twice — once for
the native baseline, once for the WASM build — and the second attempt fails. If that is
what is happening, the WASM build may be running *without* the portable-FMA patch, which
would make the divergence table above measure the wrong thing. Fix this before drawing any
conclusion from the table.

## What is verified versus what is only written

Verified by CI:

- the web shell typechecks, builds, and passes 58 unit tests;
- the first-load shell is ~36 KB (0.7 KB HTML + 2.4 KB CSS + 33 KB JS), well inside the
  1 MB budget;
- the static test server applies the real `_headers` and serves the shell correctly;
- the Pages Functions typecheck and their tests pass;
- the WASM probe compiles and runs the upstream tests (4 of 4) under Node.

Only written, never executed:

- every asset-pipeline, input, cache and touch-control task in the backlog below;
- the Cloudflare deploy path (no tokens, no account login);
- anything involving the game itself.

## What cannot be done tonight, by anyone

There is no Melee disc image, so there is no DOL, so there is no `melee.wasm`. The game
cannot be played, and no amount of work in this repository changes that. Do not write
anything that implies otherwise, in code, docs or comments.

## Backlog once CI is green

See `PROGRESS.md`. Priority: asset pipeline and manifest, input/PAD layer, OPFS asset cache,
touch controls, then docs.
