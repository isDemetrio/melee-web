# Presentation cost: what `bitmap_ms` is made of

The iPhone run of `696ec4f` (Safari): cycle 24.67 ms (40.5 fps), core 10.15 ms, **`bitmap` 40.2% of
the cycle (~9.9 ms)**, `idle` 15.9% (~3.9 ms), WebGPU 1.68 ms, `ack` 0.54 ms. The goal is 16.67 ms; the
missing ~8 ms are mostly in `bitmap`. This page says what that number contains, from WebKit's source,
and what this branch adds to take it apart on the phone. **Nothing here has been measured on the phone
yet**: the numbers below the "Run" section are to be filled from the reports.

## What `transferToImageBitmap` does in WebKit

Read from WebKit `main` on 2026-10-05. The phone's Safari may be older; the run below checks whether
the source still describes it.

`OffscreenCanvas::transferToImageBitmap` → `GPUCanvasContextCocoa::transferToImageBuffer`, which makes
**two synchronous IPC calls** to the GPU process (`RemoteCompositorIntegration.messages.in`: both
`Synchronous`):

1. **`PrepareForDisplay(frameIndex)`.** It goes through the same ordered stream as every WebGPU call,
   so the GPU process first finishes decoding and Metal-encoding everything the frame sent before it.
   Then `PresentationContextIOSurface::present` (which can block in `waitForInFlightFrameSlot` while
   too many earlier frames are still on the GPU) and `Queue::onSubmittedWorkScheduled`: it answers
   when every command buffer submitted so far is **scheduled** by Metal.
2. **`PaintCompositedResultsToCanvas(buffer, index)`** → `withDisplayBufferAsNativeImage` →
   `PresentationContextIOSurface::getTextureAsNativeImage`:
   - `texture->waitForCommandBufferCompletion()`: it waits until the GPU has **finished** the
     command buffer that wrote the canvas texture, i.e. the frame's whole batch (gx_webgpu.cpp
     submits one batch per frame, at the XFB copy, and the canvas copy is in it);
   - if the texture is `BGRA8Unorm`, `BGRA8Unorm_sRGB` or `RGBA16Float`, the IOSurface itself becomes
     the image (`createNativeImage`). **Otherwise** -- and the play canvas is `rgba8unorm`
     (spike/gpu.ts) -- `[MTLTexture getBytes:]` copies the whole canvas into `malloc`ed memory on the
     CPU and wraps it in a `CGImage`;
   - that image is drawn into a new accelerated `ImageBuffer` (`paintNativeImageToImageBuffer`).

So one `bitmap_ms` holds, in series, with no clock between them from inside the page:

| part | ours? |
| --- | --- |
| GPU process finishing the frame's ~2.3k messages (decode + Metal encode) | caused by our call count, run in the browser's process |
| GPU executing the frame (≈1,870 draws, EFB copies) | our GPU work |
| CPU readback of the rgba8unorm canvas (`getBytes`, 1.2 MB) + CGImage draw | the browser's path, **chosen by our format** |
| two IPC round trips, ImageBuffer creation | the browser's floor |

WebKit itself measures the GPU part (`PrepareForDisplay` replies `gpuFrameCost` and `presentStall`),
but it is not exposed to the page.

## Hypotheses, and what answers each

1. **Canvas size.** The internal canvas is 640×480 = 307,200 px, the EFB's own size (GX renders 640
   wide). The page shows it at 100% of the panel width, aspect 73:60; on a ~390 pt-wide iPhone at DPR 3
   that is roughly 1,070×880 ≈ 0.95 M device px. **We transfer about a third of the pixels the phone
   shows; nothing transferred is unseen.** The report now records the real figure
   (`presentation.pixels.transferred_over_shown`, from the page canvas's CSS size and
   `devicePixelRatio`). How much the *transfer* depends on pixel count is measured by the probe at
   320×240, 640×480 and 1280×960, without touching the game's picture. A lower internal resolution of
   the *rendering* is a separate mode (`docs/PRESENTATION_COST.md`, "Internal resolution" below): it
   scales the renderer's viewports, so it changes how many pixels are *drawn*, not how many are
   transferred (the canvas stays 640×480).
2. **Transfers per frame.** One. `worker.ts` calls `transferToImageBitmap` only on a retrace beat
   (`retraces >= 0`); the per-draw beats (`-1`) return before it. The renderer writes the canvas only on
   an XFB copy and submits one batch per frame. A frame shows one `context.getCurrentTexture` in
   `webgpu_methods` per XFB copy; more than one per retrace in a report would contradict this.
3. **GPU wait against transfer.** Not separable from one `bitmap_ms`. Two experiments separate them:
   - `probe`: the transfer of a just-cleared canvas of its own, after the frame's transfer has already
     waited for the GPU. That is the transfer with nothing behind it: the IPC round trips, the
     readback path for its format, the ImageBuffer. `bitmap_ms − probe(640×480, rgba8unorm)` is then
     the wait for the frame's own work, by subtraction.
   - `alternate`: blocks of 240 frames, alternately presented as today and **one frame late**. Late
     means the renderer draws the XFB into one of two offscreen textures (its `gpu.xfb` path, the one
     CI uses), and the canvas gets the *previous* frame's texture in a command buffer submitted just
     *before* the current frame's batch. `waitForCommandBufferCompletion` then waits for a copy that
     depends on a frame the GPU had a whole cycle to finish. The pair difference late − direct is the
     part of `bitmap_ms` that is waiting for the current frame's GPU work, measured directly, with
     ~15 pairs per 3-minute match and their spread as the noise. If it is large, presenting one frame
     late *is* the reduction (at the price of one frame of display latency, ~25 ms).
   - `bgra` (and `bgra-probe`, `bgra-alternate`): the whole renderer in `bgra8unorm` -- EFB,
     pipelines, EFB-copy textures, canvas -- so the XFB copy stays a plain texture copy and WebKit
     takes the IOSurface path instead of `getBytes`. Same pixels by construction (a format's channel
     order is storage, not shader-visible). The probe already compares the two formats on every
     other probed frame, interleaved, in one session; a `bgra` session confirms it on the real frame.
4. **`idle`.** It is ours, entirely: the worker's 60 Hz pacing (`worker.ts`:
   `deadline = max(deadline + 16.67, now)`, then `Atomics.wait` for what is left). The browser's own
   waiting is in `ack` (the page presenting) and in `bitmap`, not in `idle`. `idle` is non-zero only in
   frames whose work finished before their deadline; because the deadline is reset to *now* after a
   late frame, a fast frame never makes up for a slow one. With the phone's numbers the work per frame
   averages 24.67 − 3.9 ≈ 20.8 ms: a pacer that let fast frames catch up after slow ones would at best
   bring the mean cycle to that, ~48 fps, with the game running bursts above 60 Hz that the display
   cannot show. That is a game-speed policy, not a cost to cut, and it is not changed here.

## Run (on the phone)

Game screen → **presentation** selector (default `direct`, the path every earlier report used), then
Play, a match, Save/Share report. The report's `presentation` block has the answer per mode:
`by_present_mode`, `alternate_pairs` (pairs, mean late − direct, SD, standard error),
`probe_transfer_ms` (by pixels and format), `after_probe` (what the probe costs the next frame),
`pixels`. Suggested order, one match each: `probe`, `alternate`, `bgra-alternate`.

None of these modes changes the default path. `direct` makes the same WebGPU calls in the same order
as before (no file under `wasm/` is touched), so the CPU trace and the WebGPU call stream of a
`direct` session are unchanged. The `probe` calls go through functions captured before the meter, so
they are in no frame's `webgpu_calls`; the `alternate` copies are counted in the frame that makes
them. A non-default mode that became the default would need its own WebGPU digest certificate.

## Internal resolution (how much of the lag is pixel fill)

The slowest decile of in-match frames costs three times a fast frame (55.59 ms vs 18.85 ms) for 42%
more draws (2869 vs 2023) — a cost that does not track the draw count. That is the signature of fill
rate: the same draws cost more when they cover more pixels, and the camera zooming out, or a special
effect, covers more. This mode tests that directly: it draws the frame at fewer pixels and scales it up
to the canvas, so the geometry, the commands and the materials are unchanged and only the pixels filled
change.

`Game screen → internal resolution` selector (default `100%`, the path every earlier report used),
next to the presentation selector. Three levels:

| level | render target | pixels drawn | shown at |
| --- | --- | --- | --- |
| `100%` | 640×528 (the EFB) | 337,920 | 640×480 |
| `75%` | 480×396 | 190,080 | 640×480 |
| `50%` | 320×264 | 84,480 | 640×480 |

The level is read live: change it **during** a match and the same match carries frames at more than one
level, so a single report compares them. The per-frame report records the level (`res_pct`) and the
pixels drawn vs shown (`px_drawn`, `px_shown`), and the report's `resolution` block groups the frames by
level (`by_level`, with `cycle_ms`, `core_ms`, `webgpu_ms`, `bitmap_ms` per level).

**Nothing about the game changes.** The reduction is in the presentation only: the WebGPU backend's
render target is `640*scale × 528*scale`, the same draw commands run with a scaled viewport and
scissors, and the XFB copy scales the result back up to the 640×480 canvas (a fullscreen blit;
`wasm/render/gx_webgpu.cpp`, `gxw_open`/`gxw_copy`). The emulated framebuffer, its coordinates and all
guest state are untouched, which the 2400-checkpoint trace proves (that trace runs the node core, which
carries no WebGPU backend).

### Run (on the phone)

1. Game screen → **internal resolution** = `100%`. Play a match of the kind that lags (four players,
   a stage that zooms out). Save/Share report. This is the baseline.
2. Play the **same match, same characters, same stage** at `50%` — the largest reduction — and save.
3. Optionally, one more match changing the level **mid-match** (start at `100%`, switch to `50%` when
   the zoom-out starts): the `resolution` block then compares both halves of one match, which removes
   stage and session variance.
4. Compare the `resolution.by_level` block: `cycle_ms` (and `core_ms`/`webgpu_ms`) at `100%` against
   `50%`. If the slow frames are pixel fill, the `50%` mean and p99 are lower, and the gap between the
   slowest and fastest frames narrows; if it is not, they barely move. The report also names the
   level per frame, so the zoom-out frames can be read at each level on their own.

The measured numbers are the operator's; CI has no GPU and cannot produce them (`docs/FOUR_PLAYER_LOAD.md`).

## Results

Not measured yet.
