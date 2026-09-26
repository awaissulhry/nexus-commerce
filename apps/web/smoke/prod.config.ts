/**
 * Production smoke (docs/ci-plan.md §2.4) — READ-ONLY checks against a finished production deployment.
 * No sign-in, no writes: GET requests to public routes only.
 *
 * Vercel protects deployment URLs; GitHub reaches them with the "Protection Bypass for Automation"
 * secret (VERCEL_AUTOMATION_BYPASS_SECRET). Without it every request would read Vercel's sign-in
 * page, so the run refuses instead of measuring the wrong thing.
 *
 *   PROD_BASE_URL=https://<deployment>.vercel.app VERCEL_AUTOMATION_BYPASS_SECRET=… npx playwright test -c smoke/prod.config.ts
 */
import { defineConfig, devices } from '@playwright/test'

const base = process.env.PROD_BASE_URL ?? ''
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? ''
if (!/^https:\/\/[a-z0-9.-]+\.(vercel\.app|xavia\.it)(\/|$)/.test(base)) throw new Error(`PROD_BASE_URL must be an https Vercel or xavia.it URL, got "${base}"`)
if (!bypass) throw new Error('VERCEL_AUTOMATION_BYPASS_SECRET is not set — Vercel protection would answer instead of the app (Vercel → Project → Settings → Deployment Protection → Protection Bypass for Automation, then add it as a GitHub secret)')

export default defineConfig({
  testDir: '.',
  testMatch: 'prod.spec.ts',
  grep: /@prod/,
  retries: 2,
  workers: 1,
  timeout: 30_000,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: base,
    extraHTTPHeaders: { 'x-vercel-protection-bypass': bypass, 'x-vercel-set-bypass-cookie': 'true' },
  },
  projects: [{ name: 'prod', use: { ...devices['Desktop Chrome'] } }],
})
