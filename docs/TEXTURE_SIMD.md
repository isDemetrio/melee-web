# Texture decode: which formats the game decodes, and the kernels for them

Code: `wasm/render/texture_decode.h`. Bench: `experiments/texture-simd/` (`texture-simd.yml`).

## 1. The formats, counted (run 37230982757, PR #116, candidate run 1)

The 2400-retrace replay (2279 frames reach the renderer) decodes on a simulated texture pool with
`gxw_bind`'s limits. 857 frames decode at least one texture; 1769 misses, 1815 levels in total.
The RGBA8 kernel of PR #116 was taken on **0** levels, because the game decodes **no** RGBA8:

| GX format | misses | levels | output MiB | reference ms (whole replay) | share of time |
|---|---:|---:|---:|---:|---:|
| 1 I8     |  47 |  47 | 15.71 | 12.72 | 34% |
| 14 CMPR  | 631 | 665 |  9.30 |  9.23 | 25% |
| 9 C8     | 104 | 104 |  4.95 |  7.00 | 19% |
| 0 I4     | 344 | 349 |  4.61 |  3.83 | 10% |
| 2 IA4    | 620 | 627 |  2.27 |  2.87 |  8% |
| 3 IA8    |  16 |  16 |  1.16 |  1.01 |  3% |
| 8 C4     |   6 |   6 |  0.33 |  0.54 |  1% |
| 5 RGB5A3 |   1 |   1 |  0.03 |  0.04 |  0.1% |
| 4 RGB565, 6 RGBA8, 10 C14X2 | 0 | 0 | 0 | 0 | 0 |

**RGB565 is not decoded at all** (format 4: zero misses), so it gets no kernel. The time is
concentrated in I8 (few, large textures), CMPR (the most frequent), C8 and I4.

What the whole decode is worth: 37.2 ms of reference time over the replay, **0.016 ms per frame on
average**; the cost is in load hitches (worst frame 3.66 ms), not in steady play. No kernel can
save more than that.

## 2. The kernels

All exact, full blocks only; partial blocks and other formats call `gx::decode_texture`.

- **I4, I8, IA4, IA8, RGBA8** — byte moves plus `e4(n) = n*17 = (n<<4)|n`: v128 shuffles, nibble
  masks and shifts. Integer, nothing to round.
- **CMPR** (DXT1-like) — the semantics hold: each 4x4 sub-block's four colours are computed by the
  reference's own scalar integer code (rgb565 expansion, `(2a+b)/3`, `(a+b)/2`, alpha 0 for the
  transparent case), then each row of four pixels is one `i8x16.swizzle` of that 16-byte palette,
  with indices from a 4 KiB table of the 256 selector bytes. Only the selection is SIMD.
- **C4, C8** — **not SIMD** (WebAssembly has no gather): the palette is converted once per level
  with the reference's `tlut_color` and each pixel copies 4 bytes. Counted separately
  (`table_levels`, `frames_with_table`), never as SIMD.

Checks: `experiments/texture-simd/kernels_check.cpp` compares every format 0..14, every TLUT
format, full and partial sizes, both CMPR palette branches, on random texels, against
`gx::decode_texture` byte for byte (natively through `emu/wasm_simd128.h`, and in CI with `em++
-msimd128` under Node); then the game replay compares every mip of every decoded texture and the
ordered graphics oracle, with the trace gate.

## 3. Result

Filled from the CI run of this branch (`texture-simd.json`): §PR description.
