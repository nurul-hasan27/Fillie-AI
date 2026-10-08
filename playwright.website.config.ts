import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * Browser tests for the website's /influencer, /admin and checkout pages (a sibling checkout at ../fillie-website).
 * The website talks to an in-memory Postgres running the real migrations; see tests/website/fake-supabase.ts.
 * Run with: npm run test:website
 */
export default defineConfig({
  testDir: './tests/website',
  outputDir: './test-results-website',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5199', trace: 'retain-on-failure', screenshot: 'only-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
  webServer: {
    command: 'npm run dev -- --port 5199 --strictPort --host 127.0.0.1',
    cwd: path.resolve(process.cwd(), '../fillie-website'),
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'ignore',
  },
});
