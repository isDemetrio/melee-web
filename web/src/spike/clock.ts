/**
 * The worker's clock, measured rather than assumed. Shared by the spike worker and the play worker
 * (web/src/play/frame-meter.ts), so both reports state the same two numbers the same way.
 */

/** Smallest observable step of performance.now(): the resolution every sim_ms is quantised to. */
export function timerResolutionMs(now: () => number = () => performance.now()): number {
  let best = Number.POSITIVE_INFINITY;
  let last = now();
  for (let i = 0; i < 200_000; i++) {
    const current = now();
    if (current > last) { best = Math.min(best, current - last); last = current; }
  }
  return best;
}

/**
 * What one clock read costs, in nanoseconds: the price of every timed section, paid twice per
 * section. A meter that reads the clock around each of ~2,300 WebGPU calls per frame costs about
 * `2 * calls * clockCostNs` per frame, and the play report states that estimate next to its numbers.
 */
export function clockCostNs(now: () => number = () => performance.now(), reads = 100_000): number {
  const started = now();
  for (let i = 0; i < reads; i++) now();
  return ((now() - started) / reads) * 1e6;
}
