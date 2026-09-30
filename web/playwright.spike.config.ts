import { defineConfig, devices } from '@playwright/test';
if (!process.env.SPIKE_DIST) throw new Error('SPIKE_DIST must point at a page built by phase0-build.yml');
export default defineConfig({
  testDir: './tests/spike', timeout: 120_000, expect: { timeout: 110_000 },
  fullyParallel: false, workers: 1, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4175', headless: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node scripts/serve.mjs --dir "${process.env.SPIKE_DIST}" --port 4175`,
    url: 'http://127.0.0.1:4175/spike.html', reuseExistingServer: false, timeout: 30_000,
  },
});
