/**
 * Production smoke (docs/ci-plan.md §2.4) — READ-ONLY checks against a finished production deployment.
 * No sign-in, no writes: GET requests to public routes only.
 *
 * The web runs on Railway since 2026-09-29; its address is public, so no secret is needed:
 *
 *   PROD_BASE_URL=https://nexus-commerce-web.up.railway.app npx playwright test -c smoke/prod.config.ts
 */
import { defineConfig, devices } from '@playwright/test'

const base = process.env.PROD_BASE_URL ?? ''
if (!/^https:\/\/[a-z0-9.-]+\.(up\.railway\.app|xavia\.it)(\/|$)/.test(base)) throw new Error(`PROD_BASE_URL must be an https Railway or xavia.it URL, got "${base}"`)

export default defineConfig({
  testDir: '.',
  testMatch: 'prod.spec.ts',
  grep: /@prod/,
  retries: 2,
  workers: 1,
  timeout: 30_000,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: base },
  projects: [{ name: 'prod', use: { ...devices['Desktop Chrome'] } }],
})
