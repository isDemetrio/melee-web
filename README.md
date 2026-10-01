# melee-web

Phase 0: a WebAssembly port with a browser harness and a measurement suite.

- `docs/` — specification, technical maps, decisions, progress log, open questions
- `web/` — TypeScript shell: boot, settings, lobby, input, asset client
- `web/src/net/` — signalling, WebRTC transport, session negotiation
- `web/src/input/` — keyboard, gamepad and touch, all writing one pad state
- `functions/` — edge functions
- `wasm/` — the portable-intrinsic shim and the CI-only toolchain probes
- `scripts/` — build, manifest, upload and deploy scripts
- `.github/workflows/` — hygiene, shell and browser tests; the Phase 0 build and deploy

No game data is stored in this repository and none is built into it: the harness reads the
operator's own copy at run time. Everything is built in CI, never on the operator's machine.
