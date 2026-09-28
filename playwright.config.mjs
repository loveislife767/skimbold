import { defineConfig } from '@playwright/test';

const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.mjs',
  outputDir: 'test-results',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // Each worker runs its own Chromium with the extension loaded.
  workers: 2,
  // @stress tests (the long-page engine test and the Reader's 300-page timings) measure
  // main-thread blocking, which another worker's Chromium competing for the CPU would spoil,
  // so they run one at a time once everything else has finished.
  projects: [
    { name: 'e2e', grepInvert: /@stress/ },
    { name: 'stress', grep: /@stress/, dependencies: ['e2e'], workers: 1 },
  ],
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    headless: true,
    // Extensions need full Chromium; Playwright's default headless shell cannot load them.
    channel: 'chromium',
    trace: 'retain-on-failure',
  },
});
