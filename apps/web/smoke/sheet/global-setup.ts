/**
 * Signs in ONCE and saves the session for every sweep test — the seeded owner on CI (SMOKE_SEED), or a signed-in state
 * the caller supplies for a local stack (STUDIO_STORAGE_STATE).
 *
 * 🔴 The fence, as in `../global-setup.ts`: before any test runs, the sheet seed's NONCE must come back through the
 * products page. The web app falls back to the PRODUCTION API when a variable is missing (src/lib/backend-url.ts); a nonce
 * only this run's database holds proves which stack answered. No nonce → no tests.
 */
import { chromium, expect, type FullConfig } from '@playwright/test'
import { authenticatedStudioPage } from '../../../../scripts/studio-browser-auth.mjs'
import { smokeSeed } from '../seed'
import { SHEET_STORAGE_STATE } from '../sheet.config'
import { sheetSeed } from './seed'

export default async function globalSetup(config: FullConfig) {
  const base = config.projects[0]?.use.baseURL ?? 'http://localhost:3000'
  const origin = new URL(base)
  if (!['localhost', '127.0.0.1'].includes(origin.hostname)) throw new Error(`The sheet sweep runs only against localhost, not ${origin.hostname}`)
  const seed = sheetSeed()
  if (process.env.SMOKE_SEED) {
    const owner = smokeSeed()
    process.env.STUDIO_TEST_EMAIL = owner.email
    process.env.STUDIO_TEST_PASSWORD = owner.password
  } else if (!process.env.STUDIO_STORAGE_STATE) {
    throw new Error('Set SMOKE_SEED (CI: the seeded owner) or STUDIO_STORAGE_STATE (a signed-in state for this local stack)')
  }
  const browser = await chromium.launch()
  try {
    const page = await authenticatedStudioPage(browser, { base, viewport: { width: 1440, height: 900 } })
    // The family's own studio page: its name carries the nonce, and nothing else in any database does.
    await page.goto(`${base}/w/${seed.workspace}/products/${seed.families.master.family}/edit/studio?scope=master&market=IT&locale=it&tab=sheet`)
    await expect(page.getByText(seed.families.master.name).first(), `the sheet seed's nonce ${seed.nonce} did not come back through the UI — refusing to run against an unknown stack`).toBeVisible({ timeout: 60_000 })
    await page.context().storageState({ path: SHEET_STORAGE_STATE })
  } finally {
    await browser.close()
  }
}
