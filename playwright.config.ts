import { defineConfig, devices } from '@playwright/test';

// These are isolated test-only servers; never reuse a developer's running instance or database.
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
  },
  webServer: [
    {
      command: 'npx tsx --tsconfig apps/backend/tsconfig.json apps/backend/src/index.ts',
      url: 'http://127.0.0.1:4000/api/v1/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        PORT: '4000',
        APP_ORIGIN: 'http://127.0.0.1:5173',
        AI_PROVIDER: 'local',
        DB_DRIVER: 'sqlite',
        SQLITE_PATH: ':memory:',
        JWT_SECRET: 'e2e-only-secret-do-not-use-for-production',
        WORKER_ENABLED: 'false',
        MAINTENANCE_ENABLED: 'false',
        RATE_LIMIT_ENABLED: 'false',
        STORAGE_PATH: './tmp/e2e-storage',
        MAIL_TRANSPORT: 'disabled',
      },
    },
    {
      command: 'npm run dev --workspace=@idcp/desktop',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 60_000,
      env: { IDCP_API_PROXY: 'http://127.0.0.1:4000' },
    },
  ],
});
