/** Local-only wire and reload proof. The caller seeds and removes its own two-product fixture. */
import { readFileSync } from 'node:fs'
import { expect, test, type Page, type Response } from '@playwright/test'
import { decodeSheetCells } from '@nexus/shared/sheet-cell-wire'

interface Fixture { family: string; child: string; workspace: string; accounts: Record<string, string>; nonce: string }
interface Sheet { rows: Array<{ id: string; values: Record<string, { value: unknown }> }> }
const path = process.env.E2E_LIST_FIXTURE
const fixture: Fixture | null = path ? JSON.parse(readFileSync(path, 'utf8')) : null
const auth = process.env.E2E_AUTH_STATE
const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3026'
const local = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
const numericFields = {
  AMAZON: ['purchasable_offer__discounted_price__value_with_tax', 'purchasable_offer__map_price', 'purchasable_offer__maximum_seller_allowed_price', 'purchasable_offer__minimum_seller_allowed_price', 'purchasable_offer__our_price'],
  ETSY: ['production_partner_ids'],
}

async function focus(page: Page, key: string) {
  await expect(page.locator('.ag-row .ag-cell').first()).toBeVisible({ timeout: 90_000 })
  const rowIndex = await page.evaluate(({ id, key }) => {
    interface Row { rowIndex: number; data?: { id: string } }
    interface Grid { forEachNode(visit: (row: Row) => void): void; setColumnsVisible(keys: string[], show: boolean): void; ensureIndexVisible(index: number, where: string): void; ensureColumnVisible(key: string, where: string): void; setFocusedCell(index: number, key: string): void }
    interface Fiber { memoizedProps?: { api?: Grid }; return?: Fiber }
    for (const cell of document.querySelectorAll('.ag-cell, .ag-cell *')) {
      const keyName = Object.keys(cell).find(key => key.startsWith('__reactFiber$'))
      for (let fiber = keyName ? (cell as unknown as Record<string, Fiber>)[keyName] : undefined; fiber; fiber = fiber.return) {
        const api = fiber.memoizedProps?.api
        if (!api?.forEachNode) continue
        let at = -1
        api.forEachNode(row => { if (row.data?.id === id) at = row.rowIndex })
        if (at < 0) continue
        api.setColumnsVisible([key], true)
        api.ensureIndexVisible(at, 'middle')
        api.ensureColumnVisible(key, 'middle')
        api.setFocusedCell(at, key)
        return at
      }
    }
    throw new Error('fixture row not found on the real grid')
  }, { id: fixture!.child, key })
  const cell = page.locator(`.ag-row[row-index="${rowIndex}"] .ag-cell[col-id="${key}"]`)
  await expect(cell).toBeVisible()
  await cell.focus()
  return cell
}

async function assertSave(response: Response, value: number[]) {
  expect(response.status()).toBe(200)
  const request = response.request().postDataJSON()
  expect(request.units).toHaveLength(1)
  expect(request.units[0].changes).toHaveLength(1)
  expect(request.units[0].changes[0].value).toEqual(value)
  const answer = await response.json()
  expect(answer).toMatchObject({ saved: 1, failed: 0 })
  expect(answer.units).toHaveLength(1)
  expect(answer.units[0].status).toBe(200)
  expect(answer.units[0].body.errors ?? []).toEqual([])
}

test.describe('typed lists on the local product sheet', () => {
  test.skip(!fixture || !auth, 'Needs E2E_LIST_FIXTURE and E2E_AUTH_STATE for a synthetic local fixture.')
  test.describe.configure({ mode: 'serial' })
  test.use({ storageState: auth, permissions: ['clipboard-read', 'clipboard-write'] })
  test.setTimeout(180_000)

  for (const channel of ['AMAZON', 'ETSY'] as const) for (const width of [1680, 390]) for (const theme of ['light', 'dark'] as const) {
    test(`${channel} ${theme} ${width}px: keyboard, mouse and paste send numbers and reload exactly`, async ({ page }, info) => {
      if (!local(base) || !fixture!.family.startsWith('e2e_c_lists') || !fixture!.child.startsWith('e2e_c_lists')) throw new Error('use this lane\'s local synthetic fixture only')
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript(theme => localStorage.setItem('nexus:theme', theme), theme)
      await page.route('**/*', route => local(route.request().url()) ? route.continue() : route.abort())
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const market = channel === 'ETSY' ? 'GLOBAL' : 'IT', locale = channel === 'ETSY' ? 'en' : 'it'
      const firstRead = page.waitForResponse(response => response.request().method() === 'GET' && response.url().includes(`/products/${fixture!.family}/studio/sheet?`))
      await page.goto(`/w/${fixture!.workspace}/products/${fixture!.family}/edit/studio?scope=${channel}&market=${market}&account=${fixture!.accounts[channel]}&locale=${locale}&tab=sheet`, { waitUntil: 'domcontentloaded' })
      const initial = await firstRead
      expect(initial.status()).toBe(200)
      await expect(page.getByText(`E2E lists ${fixture!.nonce}`).first()).toBeVisible({ timeout: 90_000 })
      const read = async (): Promise<Sheet> => {
        const url = new URL(initial.url())
        const response = await page.request.get(url.pathname + url.search, { headers: { 'x-nexus-workspace-id': fixture!.workspace } })
        expect(response.status()).toBe(200)
        return decodeSheetCells(await response.json()) as Sheet
      }
      if (channel === 'AMAZON') {
        const row = (await read()).rows.find(row => row.id === fixture!.child)!
        expect([1, 2, 3].map(index => row.values[`bulletPoints_${index}`].value)).toEqual([null, null, 'Third'])
      }
      const finalValues = new Map<string, number[]>()
      for (const key of numericFields[channel]) {
        const previous = (await read()).rows.find(row => row.id === fixture!.child)!.values[key].value
        const first = Array.isArray(previous) && previous[0] === 7 ? 17 : 7
        for (const gesture of ['keyboard', 'mouse', 'paste'] as const) {
          const cell = await focus(page, key)
          const expected = gesture === 'keyboard' ? [first] : gesture === 'mouse' ? [first, first + 1] : [first + 2]
          const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/products/bulk-save'))
          if (gesture === 'paste') {
            await cell.click({ position: { x: 6, y: 6 } })
            await page.evaluate(value => navigator.clipboard.writeText(value), String(first + 2))
            await page.keyboard.press('ControlOrMeta+V')
          } else {
            await page.keyboard.press('Enter')
            const popup = page.locator('.ag-popup-editor')
            await expect(popup).toBeVisible()
            const remove = popup.getByRole('button', { name: /^Remove / })
            while (await remove.count()) await remove.first().click()
            const input = popup.locator('input').first()
            await input.fill(String(first))
            if (gesture === 'mouse') {
              await input.press(',')
              await input.fill(String(first + 1))
              await page.locator('h1').first().click()
            } else await input.press('Enter')
          }
          await assertSave(await saved, expected)
          expect((await read()).rows.find(row => row.id === fixture!.child)!.values[key].value).toEqual(expected)
          finalValues.set(key, expected)
        }
      }
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.getByText(`E2E lists ${fixture!.nonce}`).first()).toBeVisible()
      for (const [key, expected] of finalValues) expect((await read()).rows.find(row => row.id === fixture!.child)!.values[key].value).toEqual(expected)
      if (channel === 'AMAZON') {
        const row = (await read()).rows.find(row => row.id === fixture!.child)!
        expect([1, 2, 3].map(index => row.values[`bulletPoints_${index}`].value)).toEqual([null, null, 'Third'])
        await expect(await focus(page, 'bulletPoints_3')).toContainText('Third')
      } else {
        await expect(await focus(page, 'production_partner_ids')).toContainText(String(finalValues.get('production_partner_ids')![0]))
      }
      expect(errors).toEqual([])
      await page.screenshot({ path: info.outputPath('typed-list.png'), fullPage: true })
    })
  }
})
