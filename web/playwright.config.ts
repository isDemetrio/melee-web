import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests.
 *
 * Two servers, on purpose:
 *  - 4173 serves `dist/` with the real `_headers` applied, which is what production looks
 *    like and is the only configuration in which `crossOriginIsolated` is true;
 *  - 4174 serves the same build with no headers at all, so the negative test can prove
 *    the positive assertion is not vacuous.
 *
 * Chromium only for now. WebKit and Firefox are worth adding when there is a game to test;
 * until then they would only double the runtime of tests about the shell.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node scripts/serve.mjs --dir dist --port 4173',
      url: 'http://127.0.0.1:4173/',
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
    },
    {
      command: 'node scripts/serve.mjs --dir dist --port 4174 --no-headers',
      url: 'http://127.0.0.1:4174/',
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
    },
  ],
});
