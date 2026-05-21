/**
 * IR.16 — Playwright config for the images workspace smoke + future
 * visual-regression suite.
 *
 * Tests live under `apps/web/tests/`. Run with:
 *   npx playwright install chromium  # one-time, ~150MB
 *   npx playwright test
 *
 * Setup needed before the auth-gated specs (lightbox, editor, DAM
 * picker walkthrough) are useful:
 *   1. PLAYWRIGHT_BASE_URL pointing at a running dev server or
 *      nexus-commerce-three.vercel.app
 *   2. A seeded test user + a fixture for cookie-based login
 *      (Nexus session cookie or NextAuth JWT)
 *
 * Without those, only the unauth'd smoke spec (loads /, checks title)
 * has signal. Adding auth fixtures is a follow-up.
 */

import { defineConfig, devices } from '@playwright/test'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: './tests',
  // Visual regression: snapshots land alongside specs; diff threshold
  // is intentionally lenient so font-rendering noise across
  // dev/CI/host environments doesn't fail every run.
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      threshold: 0.2,
    },
  },
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'dot' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Locale matches Xavia's primary marketplace so generated UI strings
    // surface in Italian when the i18n hook hydrates.
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Add 'firefox' / 'webkit' / mobile projects once the suite covers
    // enough surface to justify the extra runtime.
  ],
})
