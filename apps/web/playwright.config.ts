import { defineConfig, devices } from '@playwright/test';

const GATEWAY_PORT = 8788;
const WEB_PORT = 5174;
const ORIGIN = `http://localhost:${WEB_PORT}`;

/**
 * E2E runs against the real gateway with the mock venue (deterministic,
 * offline) and fault injection enabled, behind the Vite dev proxy.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: ORIGIN,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      command: 'pnpm --filter @paperperp/gateway exec tsx src/main.ts',
      url: `http://localhost:${GATEWAY_PORT}/readyz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(GATEWAY_PORT),
        MARKET_SOURCE: 'mock',
        DATABASE_PATH: ':memory:',
        ENABLE_FAULT_INJECTION: 'true',
        ALLOWED_ORIGINS: ORIGIN,
        SIWE_DOMAINS: `localhost:${WEB_PORT}`,
        STALE_AFTER_MS: '3000',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: 'pnpm exec vite',
      url: ORIGIN,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { WEB_PORT: String(WEB_PORT), GATEWAY_URL: `http://localhost:${GATEWAY_PORT}` },
    },
  ],
});
