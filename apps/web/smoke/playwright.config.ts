/**
 * CI smoke suite (docs/ci-plan.md §2.3) — a few end-to-end journeys against a PRODUCTION build of the
 * web app (`next start`) and the API, on a disposable database seeded by scripts/ci/seed-smoke.mts.
 *
 * Separate from ../playwright.config.ts on purpose: that suite targets the live site; this one only
 * ever targets localhost, and refuses to start unless the seeded nonce is read back through the UI.
 *
 *   SMOKE_SEED=<seed.json> SMOKE_BASE_URL=http://localhost:3000 npx playwright test -c smoke/playwright.config.ts
 */
import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const STORAGE_STATE = process.env.SMOKE_STORAGE_STATE ?? join(tmpdir(), 'nexus-smoke-owner.json')

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  grep: /@smoke/,
  fullyParallel: true,
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never', outputFolder: process.env.SMOKE_REPORT_DIR ?? join(tmpdir(), 'nexus-smoke-report') }]] : 'list',
  globalSetup: './global-setup.ts',
  outputDir: process.env.SMOKE_OUTPUT_DIR ?? join(tmpdir(), 'nexus-smoke-results'),
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? 'http://localhost:3000',
    storageState: STORAGE_STATE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'smoke', use: { ...devices['Desktop Chrome'] } }],
})
