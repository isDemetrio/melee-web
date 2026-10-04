import { defineConfig, devices } from '@playwright/test';
if (!process.env.SPIKE_DIST) throw new Error('SPIKE_DIST must point at a page built by phase0-build.yml');
export default defineConfig({
  testDir: './tests/spike', timeout: 120_000, expect: { timeout: 110_000 },
  // Bounds the whole suite, not one test. The per-test allowances above bound nothing when there
  // are 44 of them: on a branch whose readback probes time out, 27 of the 44 tests spent about
  // 1.8 minutes each and the job was killed at its own timeout-minutes: 60 cap, so the run was
  // reported as cancelled instead of naming the probes that failed. Three such runs on
  // 2026-10-04 (37164057193, 37165648926, 3715924165) cost 181 runner-minutes, while a healthy
  // suite is 51 s (step 15 of run 37169669256 on main). A green branch therefore never reaches
  // this bound.
  globalTimeout: 15 * 60_000,
  fullyParallel: false, workers: 1, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4175', headless: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node scripts/serve.mjs --dir "${process.env.SPIKE_DIST}" --port 4175`,
    url: 'http://127.0.0.1:4175/spike.html', reuseExistingServer: false, timeout: 30_000,
  },
});
