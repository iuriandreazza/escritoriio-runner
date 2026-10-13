import { defineConfig } from '@playwright/test';

// The built app, driven as it runs: `pnpm test:e2e` builds it first. One app at a time: each test makes its own state directory, so none depends on another.
export default defineConfig({
  testDir: '.',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
});
