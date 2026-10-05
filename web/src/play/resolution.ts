/**
 * The internal resolution a play frame is rendered at, and scaled up from to the canvas.
 *
 * The game's own framebuffer is 640x528 (`gx_core.h`, `gx::EFB_WIDTH` x `gx::EFB_HEIGHT`). This is
 * the size the WebGPU backend creates its render target at (`wasm/render/gx_webgpu.cpp`, `gxw_open`):
 * the same geometry is drawn with a smaller viewport, so fewer pixels are filled, and an XFB copy
 * scales the reduced target up to the 640x480 canvas. It is a presentation choice only -- the
 * decoded frame, the emulated framebuffer's coordinates and all guest state are untouched, which the
 * 2400-checkpoint trace proves (that trace runs the node core, which carries no WebGPU backend).
 *
 * The operator picks a level in the Game screen's report panel, before or during a match, so the
 * same match carries frames at different levels and the per-frame report shows what each cost.
 * `px_drawn` (the internal render target's pixels) and `px_shown` (the canvas's) are new report
 * columns, so the reduction is visible in the numbers.
 */

/** The full internal render target: `gx::EFB_WIDTH` x `gx::EFB_HEIGHT`. */
export const EFB_WIDTH = 640;
export const EFB_HEIGHT = 528;
/** The presentation canvas: the play worker's `OffscreenCanvas`, and the page's `<canvas>`. */
export const CANVAS_WIDTH = 640;
export const CANVAS_HEIGHT = 480;

export interface ResolutionLevel {
  /** What the select shows and the report records as `res_pct`. */
  name: string;
  /** Percent of the full internal resolution: 100, 75, 50. The wire value. */
  pct: number;
  /** `pct / 100`: what the backend multiplies the EFB size by. */
  scale: number;
  /** The internal render target's pixels per frame: `round(EFB_WIDTH*scale) * round(EFB_HEIGHT*scale)`. */
  pxDrawn: number;
  /** The canvas pixels the frame is shown at: constant, whatever the internal resolution. */
  pxShown: number;
}

/** The canvas pixels a frame is shown at: constant, whatever the internal resolution. */
export const PX_SHOWN = CANVAS_WIDTH * CANVAS_HEIGHT;

/** The levels the Game screen offers. 100% is the path every session used before this mode. */
export const RESOLUTION_LEVELS: readonly ResolutionLevel[] = [
  { name: '100%', pct: 100, scale: 1, pxDrawn: 640 * 528, pxShown: PX_SHOWN },
  { name: '75%', pct: 75, scale: 0.75, pxDrawn: 480 * 396, pxShown: PX_SHOWN },
  { name: '50%', pct: 50, scale: 0.5, pxDrawn: 320 * 264, pxShown: PX_SHOWN },
];

/** The level with this percent, or 100%: an unknown value is today's path, never an error. */
export function resolutionPct(pct: number | undefined): ResolutionLevel {
  return RESOLUTION_LEVELS.find((level) => level.pct === pct) ?? RESOLUTION_LEVELS[0]!;
}
