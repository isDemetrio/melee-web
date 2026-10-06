# What the FIFO write path costs, and what happened when it was rewritten

The guest's recompiled PowerPC code hands the emulated GPU one 32-bit word at a time through
`write_fifo` (`port/runtime/gx/gx_core.cpp`). That function is on the hottest store path in the port:
it appends the word to `g_buf` and calls `drain_fifo()` once after it.

This document records what that path costs in the four-player profile, the one reduction that was
tried, and the result. **The reduction is a regression and was withdrawn.** No speed claim is made
for it.

## What it costs

Four-player profile, window `PROF_FROM=1685 PROF_TO=2400` (715 match frames), `-Oz`, cores
`8b8508f` (baseline) and `647bafb` (the branch):

| function | self time |
| --- | --- |
| `host::gx_write(unsigned int, int)` | **5.24%** |
| `std::__2::vector<unsigned char>::__append` + `__construct_at_end` | **1.26%** |
| **cluster: the FIFO write path** | **7.47%** |

`host::gx_write` is a two-line wrapper around `write_fifo`, so its self time is `write_fifo`'s body
inlined into it. The cluster is ~7.5% of the whole four-player profile, and ~4.7% of the frame
(the simulation is ~63% of the frame in the phone report).

Inside the envelope-skinning subtree the same pair is named at **262.9 ms, 3.6%** of that subtree
(`docs/SKINNING_ENVELOPE_COST.md`) — it is the third largest named item under
`SetupEnvelopeModelMtx`, after the guest memory helpers and the guest bodies.

## The reduction that was tried

`write_fifo` grew the buffer with `resize(at + bytes)`, which value-initialises the bytes it adds,
and then the loop below it overwrote every one of them:

```cpp
const size_t at = g_buf.size();
g_buf.resize(at + (size_t)bytes);   // value-initialises `bytes` bytes
for (int i = 0; i < bytes; ++i) g_buf[at + i] = (uint8_t)(value >> (8 * (bytes - 1 - i)));
drain_fifo();
```

So each byte of every FIFO word was stored twice. The patch built the word in a 4-byte scratch and
handed the range to `insert` — the call the neighbouring `write_fifo_bytes` already makes:

```cpp
uint8_t word[4];
for (int i = 0; i < bytes; ++i) word[i] = (uint8_t)(value >> (8 * (bytes - 1 - i)));
g_buf.insert(g_buf.end(), word, word + bytes);
drain_fifo();
```

Same bytes, same order, same `drain_fifo()` after them.

## The measurement

Two profile pairs at four players over the same window, run in **opposite order** so that a
machine that drifts would show up as a sign flip. `A` is `main` at `8b8508f`; `B` is the branch at
`647bafb` (whose only extra commits are documentation, so the code measured is the change itself).

| pair | profile total | `host::gx_write` | cluster | delta |
| --- | --- | --- | --- | --- |
| 1 (A then B) | A 36732 ms, B 38495 ms | A 5.24% → B 9.61% | 7.48% → 9.62% | **+2.14 pp** |
| 2 (B then A) | A 31212 ms, B 36187 ms | A 5.39% → B 9.99% | 7.52% → 10.00% | **+2.48 pp** |

Both orders agree: the rewrite makes the path **slower**, not faster. In absolute terms
`gx_write` goes from ~1.9 s to ~3.7 s over the 715-frame window — roughly **double** — while the
profile total moves only 4.8%, so this is not machine drift.

The trace gate is clean: the branch core's state trace is
`c79c53b9cdf81426fa0277e7497a69e55bc5f571`, **identical to the reference**. The change is
behaviour-identical, as designed; it is simply slower.

## Why the guess was wrong

`std::vector::insert` with an iterator range is not the same animal as `resize`. It has to handle
the case where the range being inserted aliases the vector's own storage, and it is a large enough
template that it does not inline into `write_fifo` the way `resize`'s `__append` does. The
`std::vector<unsigned char>` self-time that disappears in `B` (1.26% → 0.00%) has not vanished: it
has moved into `gx_write`, and grown. Removing one redundant store per byte cost more than the store
was worth.

## Verdict

**No safe reduction exists on this route.** The FIFO write path is a real cost — ~7.5% of the
four-player profile — but the obvious rewrite of it is a regression, so `patches/0013` was withdrawn
and is not part of the series.

The one variant not tried keeps `resize` (which is fast) and replaces only the four-iteration byte
loop with a byte-swap and a `memcpy`. The loop is the other half of `gx_write`'s self time, so it is
the only remaining candidate here; the expected gain is small (a fraction of the ~2% of the frame the
whole cluster is worth at two players), and the frame metric cannot resolve it — only the profile can.

## How this was measured

- Builds: `Phase 0 — WASM core` with `upload_spike=true profiling_funcs=true`; the artifact is
  `melee-spike-dist-names` (the `--profiling-funcs` build is for profiling and is never deployed).
- Profiles: `prof4.mjs` with `SCRIPT=four-player.txt NOATTACH=1 NOTIME=1 NOTRACE=1
  PROF_FROM=1685 PROF_TO=2400`, 2400 retraces, script
  `experiments/four-player/four-player.txt`.
- Gate: `prof4.mjs` with `PROF_FROM=-5`, `sha1sum` of `trace.csv`.
- The frame-level metric (`sim_ms`) cannot separate a change of this size; the profile share can.
