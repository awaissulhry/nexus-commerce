/**
 * Production smoke (docs/ci-plan.md §2.4) — READ-ONLY checks against a finished production deployment.
 * No sign-in, no writes: GET requests to public routes only.
 *
 * The web runs on Railway since 2026-09-29; its address is public, so no secret is needed:
 *
 *   PROD_BASE_URL=https://nexus-commerce-web.up.railway.app npx playwright test -c smoke/prod.config.ts
 *
 * A *.vercel.app URL still works while Vercel runs: Vercel protects deployment URLs, and GitHub reaches them with the
 * "Protection Bypass for Automation" secret (VERCEL_AUTOMATION_BYPASS_SECRET). Without it every request would read
 * Vercel's sign-in page, so the run refuses instead of measuring the wrong thing.
 */
import { defineConfig, devices } from '@playwright/test'

const base = process.env.PROD_BASE_URL ?? ''
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? ''
if (!/^https:\/\/[a-z0-9.-]+\.(up\.railway\.app|vercel\.app|xavia\.it)(\/|$)/.test(base)) throw new Error(`PROD_BASE_URL must be an https Railway, Vercel or xavia.it URL, got "${base}"`)
const onVercel = /^https:\/\/[a-z0-9.-]+\.vercel\.app(\/|$)/.test(base)
if (onVercel && !bypass) throw new Error('VERCEL_AUTOMATION_BYPASS_SECRET is not set — Vercel protection would answer instead of the app (Vercel → Project → Settings → Deployment Protection → Protection Bypass for Automation, then add it as a GitHub secret)')

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
    extraHTTPHeaders: onVercel ? { 'x-vercel-protection-bypass': bypass, 'x-vercel-set-bypass-cookie': 'true' } : {},
  },
  projects: [{ name: 'prod', use: { ...devices['Desktop Chrome'] } }],
})
