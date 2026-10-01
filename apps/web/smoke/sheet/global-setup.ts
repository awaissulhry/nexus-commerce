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
import { installSheetNetworkFence, startSheetDenyProxy } from './networkFence'

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
  const fence = await startSheetDenyProxy()
  const browser = await chromium.launch().catch(async error => { await fence.close(); throw error })
  try {
    // The auth helper first opens /login. Guard its context before it creates that first page.
    const guardedBrowser = { newContext: async (options: Parameters<typeof browser.newContext>[0]) => {
      const context = await browser.newContext({ ...options, proxy: fence.proxy, serviceWorkers: 'block' })
      await installSheetNetworkFence(context, fence.blocked)
      return context
    } }
    const page = await authenticatedStudioPage(guardedBrowser, { base, viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
    // The family's own studio page: its name carries the nonce, and nothing else in any database does.
    await page.goto(`${base}/w/${seed.workspace}/products/${seed.families.master.family}/edit/studio?scope=master&market=IT&locale=it&tab=sheet`)
    await expect(page.getByText(seed.families.master.name).first(), `the sheet seed's nonce ${seed.nonce} did not come back through the UI — refusing to run against an unknown stack`).toBeVisible({ timeout: 60_000 })
    await page.context().storageState({ path: SHEET_STORAGE_STATE })
  } finally {
    try { await browser.close() } finally { await fence.close() }
    expect(fence.blocked, 'Setup attempted a non-loopback request; all such requests were blocked').toEqual([])
  }
}
