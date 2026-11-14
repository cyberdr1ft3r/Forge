import {defineConfig, devices} from '@playwright/test';

export default defineConfig({
  testDir: './tests/release-browser',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['line']],
  use: {
    baseURL: process.env.RELEASE_HTTPS_URL ?? 'https://127.0.0.1:18443',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {name: 'release-desktop-chromium', use: {...devices['Desktop Chrome']}},
    {name: 'release-mobile-chromium', use: {...devices['Pixel 5']}},
  ],
});
