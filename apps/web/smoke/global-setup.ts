/**
 * Signs the seeded owner in ONCE and saves the session for every test (storageState).
 *
 * 🔴 The fence: before any test runs, the seeded NONCE must be read back through the products page.
 * The web app falls back to the PRODUCTION API when NEXT_PUBLIC_API_URL is missing
 * (src/lib/backend-url.ts), and a smoke run against production would be writes to real data. A nonce
 * that only this run's database holds proves which stack answered. No nonce → no tests.
 */
import { chromium, expect, type FullConfig } from '@playwright/test'
import { authenticatedStudioPage } from '../../../scripts/studio-browser-auth.mjs'
import { STORAGE_STATE } from './playwright.config'
import { smokeSeed } from './seed'

export default async function globalSetup(config: FullConfig) {
  const base = config.projects[0]?.use.baseURL ?? 'http://localhost:3000'
  const origin = new URL(base)
  if (!['localhost', '127.0.0.1'].includes(origin.hostname)) throw new Error(`Smoke runs only against localhost, not ${origin.hostname}`)
  const seed = smokeSeed()
  process.env.STUDIO_TEST_EMAIL = seed.email
  process.env.STUDIO_TEST_PASSWORD = seed.password

  const browser = await chromium.launch()
  try {
    const page = await authenticatedStudioPage(browser, { base, viewport: { width: 1440, height: 900 } })
    const first = seed.products[seed.workspaces.a][0]
    await page.goto(`${base}/w/${seed.workspaces.a}/products`)
    await expect(page.getByText(first.name).first(), `the seeded nonce ${seed.nonce} did not come back through the UI — refusing to run smoke against an unknown stack`).toBeVisible({ timeout: 45_000 })
    await page.context().storageState({ path: STORAGE_STATE })
  } finally {
    await browser.close()
  }
}
