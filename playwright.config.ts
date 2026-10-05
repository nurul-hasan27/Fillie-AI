import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * Fillie E2E. The extension is loaded unpacked into a persistent Chromium
 * context so real MV3 behaviour (service worker, storage, content scripts) is
 * exercised rather than mocked.
 */
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list']] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4321',
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        // Extensions require a real Chrome profile and the new headless mode.
        headless: true,
        viewport: { width: 1280, height: 900 },
      },
    },
  ],
  webServer: {
    command: 'node scripts/serve-fixtures.mjs',
    url: 'http://127.0.0.1:4321/health',
    reuseExistingServer: true,
    timeout: 30_000,
    stdout: 'ignore',
  },
});

export const FIXTURES_DIR = path.resolve(process.cwd(), 'tests/fixtures');