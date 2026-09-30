/**
 * Signs in ONCE through the real login form with E2E_EMAIL / E2E_PASSWORD and saves the signed-in state for the specs
 * that take one (`E2E_AUTH_STATE`). Nothing is committed: the credentials come from the environment (CI's disposable
 * seed, `scripts/ci/seed-smoke.mts`) and the state goes to a temporary file.
 *
 * 🔴 The fence: the web app and the API must both be on this machine. `backend-url.ts` falls back to the PRODUCTION API
 * when NEXT_PUBLIC_API_URL is missing (hard rule 3); the sign-in of a made-up seeded login only succeeds against the
 * database this run seeded, and `/auth/me` must name that login.
 *
 * Over http (CI and a local stack) the API must run with COOKIE_SECURE=false COOKIE_SAMESITE=lax: its default is a
 * Secure, partitioned `__Host-` cookie, which Playwright's `route.fetch()` does not send over http. The web accepts
 * either cookie name (`lib/workspaces/server.ts`).
 */
import { chromium, type FullConfig } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isLocal, sheetEnv } from './sheet-e2e'

export default async function globalSetup(config: FullConfig) {
  const base = config.projects[0]?.use.baseURL ?? 'http://localhost:3000'
  if (!isLocal(base)) throw new Error(`The sheet specs run only against a local web app, not ${base}`)
  if (!sheetEnv.api || !isLocal(sheetEnv.api)) throw new Error('Set E2E_API_URL to the LOCAL API the web app is pointed at (hard rule 3).')
  if (!sheetEnv.email || !sheetEnv.password) {
    console.log('sheet global setup: no E2E_EMAIL / E2E_PASSWORD — specs that need a login skip themselves.')
    return
  }
  const state = process.env.E2E_AUTH_STATE ?? join(tmpdir(), 'nexus-sheet-e2e-auth.json')
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined })
  try {
    const page = await browser.newPage()
    await page.route(url => !isLocal(url.href), route => route.abort())
    await page.goto(`${base}/login`)
    await page.getByLabel('Email').fill(sheetEnv.email)
    await page.getByLabel('Password').fill(sheetEnv.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 60_000 })
    const me = await page.evaluate(async (paths) => {
      for (const path of paths) {
        const res = await fetch(path).catch(() => null)
        if (res?.ok) return (await res.json()) as { user?: { email?: string } }
      }
      return null
    }, ['/backend/api/auth/me', `${sheetEnv.api}/api/auth/me`])
    if (me?.user?.email?.toLowerCase() !== sheetEnv.email.toLowerCase()) {
      throw new Error('Signed in, but /auth/me does not name the seeded login — refusing to run the sheet specs against an unknown stack.')
    }
    await page.context().storageState({ path: state })
  } finally {
    await browser.close()
  }
  // Workers start after global setup and inherit this.
  process.env.E2E_AUTH_STATE = state
}
