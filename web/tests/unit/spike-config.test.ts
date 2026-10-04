/**
 * The spike harness bound, asserted where every pull request runs.
 *
 * `web/playwright.spike.config.ts` bounds one test (120 s) and one expectation (110 s), which
 * bounds nothing about a suite of 44 tests run with one worker: a branch whose WebGPU readback
 * probes time out spends about 1.8 minutes per test, so the step ran for 51 minutes and the job
 * was killed at its own `timeout-minutes: 60` cap -- reported as cancelled, with no list of the
 * probes that failed. Three runs did it on 2026-10-04 (37164057193, 37165648926, 3715924165):
 * 181 runner-minutes of a 2,000-minute monthly allowance, spent in about ninety minutes. The
 * healthy suite is 51 s (step 15 of run 37169669256 on `main`), so a green branch never reaches
 * the bound; it is what turns a red one into a failure in minutes.
 *
 * What this does not cover: the correctness of the harness itself, and the pixel-probe step that
 * runs after it (`wasm/render/pixel_pipeline_check.mjs`), which is a separate command.
 */

import { describe, expect, it } from 'vitest';

describe('the spike harness configuration', () => {
  it('bounds the whole suite, not one test', async () => {
    // Imported here and not at the top: the config refuses to load without SPIKE_DIST, which
    // only phase0-build.yml sets, and loading it must not start the server it describes.
    process.env.SPIKE_DIST = process.env.SPIKE_DIST ?? 'unused-by-this-test';
    const config = (await import('../../playwright.spike.config')).default;
    expect(config.globalTimeout).toBeGreaterThan(0);
    expect(config.globalTimeout).toBeLessThanOrEqual(20 * 60_000);
    expect(config.timeout).toBeGreaterThan(0);
    expect(config.expect?.timeout).toBeGreaterThan(0);
  });
});
