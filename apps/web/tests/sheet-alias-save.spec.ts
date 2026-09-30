/**
 * Local browser proof for shared product tokens across listing aliases. Supply a synthetic two-alias family through
 * E2E_ALIAS_FIXTURE (JSON: family, child, alias, account), E2E_AUTH_STATE, and PLAYWRIGHT_BASE_URL. Both aliases need a
 * German translation and eBay DE drafts. This changes only that family's shared German title, and leaves it saved.
 * The caller owns seeding and cleanup; no production URL or live channel is allowed.
 */
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { LEGACY_WORKSPACE_ID } from '@nexus/database/workspace-context'

const fixturePath = process.env.E2E_ALIAS_FIXTURE
const auth = process.env.E2E_AUTH_STATE
const fixture = fixturePath ? JSON.parse(readFileSync(fixturePath, 'utf8')) as { family: string; child: string; alias: string; account: string } : null
const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'
const local = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)

async function titleCell(page: Page, rowId: string) {
  const row = page.locator(`.ag-row[row-id="${rowId}"]`)
  await row.locator('.ag-cell').first().click()
  for (let i = 0; i < 20 && await page.locator('.ag-cell-focus').getAttribute('col-id') !== 'name'; i++) await page.keyboard.press('ArrowRight')
  await expect(page.locator('.ag-cell-focus')).toHaveAttribute('col-id', 'name')
  return row.locator('.ag-cell[col-id="name"]')
}

test.describe('an immediate shared save through a sibling alias', () => {
  test.skip(!fixture || !auth, 'Needs E2E_ALIAS_FIXTURE and E2E_AUTH_STATE from a synthetic local fixture.')
  test.describe.configure({ mode: 'serial' })
  test.use({ storageState: auth })
  test.setTimeout(180_000)

  for (const width of [1680, 390]) for (const colorScheme of ['light', 'dark'] as const) {
    test(`${colorScheme}, ${width}px: the second save uses the confirmed product version before a read`, async ({ page }, info) => {
      if (!local(base)) throw new Error('This test may only use a local web app and local API.')
      if (![fixture!.family, fixture!.child, fixture!.alias].every(id => id.startsWith('e2e_'))) throw new Error('Use a synthetic e2e_ fixture only.')
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      let blockSheetReads = false, completedReads = 0
      await page.route('**/*', async route => {
        const url = route.request().url()
        if (!local(url)) return route.abort()
        if (url.includes('/studio/sheet?') && blockSheetReads) return route.abort()
        return route.continue()
      })
      page.on('response', response => { if (response.url().includes('/studio/sheet?') && response.ok()) completedReads++ })
      await page.goto(`/w/${process.env.E2E_WORKSPACE_ID ?? LEGACY_WORKSPACE_ID}/products/${fixture!.family}/edit/studio?scope=EBAY&market=DE&account=${fixture!.account}&locale=de`, { waitUntil: 'domcontentloaded' })
      const first = `primary:${fixture!.child}`, second = `${fixture!.alias}:${fixture!.child}`
      await expect(page.locator(`.ag-row[row-id="${first}"]`)).toBeVisible({ timeout: 90_000 })
      const save = async (rowId: string, value: string) => {
        const target = await titleCell(page, rowId)
        await page.keyboard.press('Enter')
        const input = page.locator('.ag-cell-inline-editing input, .ag-popup-editor textarea, .ag-popup-editor input').first()
        await expect(input).toBeVisible()
        await input.fill(value)
        await page.keyboard.press('Enter')
        const result = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/products/bulk-save'))
        await page.getByRole('button', { name: 'Edit the shared German', exact: true }).click()
        const response = await result, body = await response.json()
        expect(response.status()).toBe(200)
        expect(body).toMatchObject({ saved: 1, failed: 0, units: [{ status: 200, body: { errors: [] } }] })
        await expect(target).toContainText(value)
        return { request: response.request().postDataJSON(), body }
      }
      blockSheetReads = true
      const readsBefore = completedReads
      const firstSave = await save(first, `Primary ${width} ${colorScheme} ${Date.now()}`)
      const finalTitle = `Alias ${width} ${colorScheme} ${Date.now()}`
      const secondSave = await save(second, finalTitle)
      expect(secondSave.request.units[0].expectedVersion).toBe(firstSave.body.units[0].body.currentVersion)
      expect(secondSave.request.units[0].changes[0].contentAddress).toEqual({ tier: 'language', language: 'de' })
      expect(completedReads).toBe(readsBefore)
      await page.screenshot({ path: info.outputPath('saved.png'), fullPage: true })
      blockSheetReads = false
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(await titleCell(page, first)).toContainText(finalTitle)
      await expect(await titleCell(page, second)).toContainText(finalTitle)
    })
  }
})
