import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.pw.ts',
  fullyParallel: true,
  forbidOnly: false,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'bun index.ts',
    url: 'http://localhost:8080',
    reuseExistingServer: true,
  },
});
