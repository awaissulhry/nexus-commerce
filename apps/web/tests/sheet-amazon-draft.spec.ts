/** Local API + private PostgreSQL proof. No mocked save or provider publish. */
import { readFileSync } from 'node:fs'
import { expect, test as baseTest, type BrowserContext, type Page, type Request } from '@playwright/test'
import { decodeSheetCells } from '@nexus/shared/sheet-cell-wire'
import { installSheetNetworkFence, startSheetDenyProxy } from '../smoke/sheet/networkFence'

interface Fixture { family: string; row: string; workspace: string; account: string; name: string }
interface Column { key: string; kind: string; optionLabels?: Record<string, string> }
interface Sheet { columns: Column[]; rows: Array<{ id: string; listing: { version: number } | null; values: Record<string, { value: unknown; writable: boolean; mapped?: { warnings: string[] } }> }> }
const fixturePath = process.env.E2E_AMAZON_DRAFT_FIXTURE
const auth = process.env.E2E_AUTH_STATE
const local = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
const warning = (key: string) => `${key.split('__')[0]} cannot be edited on an existing Amazon listing. You can save a draft here, but cannot publish this change.`
const fields = ['brand', 'condition_type', 'externally_assigned_product_identifier', 'externally_assigned_product_identifier__type', 'child_parent_sku_relationship__parent_sku', 'child_parent_sku_relationship__child_relationship_type']
const test = baseTest.extend({
  context: async ({ browser, baseURL, storageState }, use) => {
    const proxy = await startSheetDenyProxy()
    let context: BrowserContext | undefined
    try {
      context = await browser.newContext({ baseURL, storageState, proxy: proxy.proxy, serviceWorkers: 'block' })
      const fence = await installSheetNetworkFence(context)
      await use(context)
      expect(fence.blocked).toEqual([])
      expect(proxy.blocked).toEqual([])
    } finally { try { await context?.close() } finally { await proxy.close() } }
  },
})

/** Layout setup only. Every value edit below uses the real DOM editor and keyboard/mouse handlers. */
async function fieldCell(page: Page, id: string, key: string) {
  await expect(page.locator('.ag-row .ag-cell').first()).toBeVisible({ timeout: 90_000 })
  const index = await page.evaluate(({ id, key }) => {
    interface Grid { forEachNode(visit: (row: { rowIndex: number | null; data?: { id: string } }) => void): void; setColumnsVisible(keys: string[], show: boolean): void; ensureIndexVisible(index: number, where: string): void; ensureColumnVisible(key: string, where: string): void; setFocusedCell(index: number, key: string): void }
    interface Fiber { memoizedProps?: { api?: Grid }; return?: Fiber }
    for (const cell of document.querySelectorAll('.ag-cell, .ag-cell *')) {
      const name = Object.keys(cell).find(name => name.startsWith('__reactFiber$'))
      for (let fiber = name ? (cell as unknown as Record<string, Fiber>)[name] : undefined; fiber; fiber = fiber.return) {
        const api = fiber.memoizedProps?.api
        if (!api?.forEachNode) continue
        let index = -1
        api.forEachNode(row => { if (row.data?.id === id && row.rowIndex !== null) index = row.rowIndex })
        if (index < 0) continue
        api.setColumnsVisible([key], true)
        api.ensureIndexVisible(index, 'middle')
        api.ensureColumnVisible(key, 'middle')
        api.setFocusedCell(index, key)
        return index
      }
    }
    throw new Error('Fixture row not found on the real grid')
  }, { id, key })
  const cell = page.locator(`.ag-row[row-index="${index}"] .ag-cell[col-id="${key}"]`)
  await expect(cell).toBeVisible()
  await cell.focus()
  await expect(cell).toBeFocused()
  await expect(page.locator('.ag-cell-focus')).toHaveAttribute('col-id', key)
  expect(await cell.evaluate(el => el.closest('.ag-row')?.getAttribute('row-id'))).toContain(id)
  expect(await page.locator('.ag-cell-focus').evaluate(el => el.closest('.ag-row')?.getAttribute('row-index'))).toBe(String(index))
  return cell
}

function nextValue(key: string, before: unknown, suffix: string): string | null {
  if (key === 'condition_type') return before === 'new_new' ? 'used_like_new' : 'new_new'
  if (key === 'externally_assigned_product_identifier__type') return before === 'ean' ? 'gtin' : 'ean'
  if (key === 'child_parent_sku_relationship__child_relationship_type') return before === 'variation' ? null : 'variation'
  if (key === 'externally_assigned_product_identifier') return before === '0000000000001' ? '0000000000002' : '0000000000001'
  const value = `Draft ${suffix}`
  return before === value ? `${value} again` : value
}

test.describe('Amazon attribute drafts', () => {
  test.describe.configure({ mode: 'serial' })
  test.use({ storageState: auth })
  test.setTimeout(240_000)
  for (const width of [1680, 390]) for (const theme of ['light', 'dark'] as const) {
    test(`${theme} ${width}px: six draft fields save with warnings and preserve identity`, async ({ page }, info) => {
      if (!fixturePath || !auth) throw new Error('Set E2E_AMAZON_DRAFT_FIXTURE and E2E_AUTH_STATE to this lane\'s private fixture')
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture
      const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3022'
      if (!local(base) || !fixture.family.startsWith('e2e_today02_') || !fixture.row.startsWith('e2e_today02_')) throw new Error('Only the local lane 02 fixture is allowed')
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript(theme => localStorage.setItem('nexus:theme', theme), theme)
      const pageErrors: string[] = [], consoleErrors: string[] = [], saves: Request[] = []
      page.on('pageerror', error => pageErrors.push(error.message))
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
      page.on('request', request => { if (['POST', 'PATCH'].includes(request.method()) && /\/api\/products\/bulk(?:-save)?$/.test(new URL(request.url()).pathname)) saves.push(request) })
      const response = page.waitForResponse(r => r.request().method() === 'GET' && r.url().includes(`/products/${fixture.family}/studio/sheet?`))
      await page.goto(`/w/${fixture.workspace}/products/${fixture.family}/edit/studio?scope=AMAZON&market=IT&account=${fixture.account}&locale=it&tab=sheet`, { waitUntil: 'domcontentloaded' })
      const initial = await response
      expect(initial.status()).toBe(200)
      await expect(page.getByText(fixture.name).first()).toBeVisible({ timeout: 90_000 })
      expect(await page.locator('html').evaluate(el => el.classList.contains('dark'))).toBe(theme === 'dark')
      const read = async () => {
        const url = new URL(initial.url())
        const result = await page.request.get(url.pathname + url.search, { maxRedirects: 0, headers: { 'x-nexus-workspace-id': fixture.workspace } })
        expect(result.status()).toBe(200)
        const sheet = decodeSheetCells(await result.json()) as Sheet
        return { row: sheet.rows.find(row => row.id === fixture.row)!, columns: sheet.columns }
      }
      for (const key of fields) for (const gesture of key === 'brand' ? ['keyboard', 'mouse'] : ['keyboard']) {
        const cell = await fieldCell(page, fixture.row, key)
        const { row: before, columns } = await read()
        const column = columns.find(column => column.key === key)!
        const value = nextValue(key, before.values[key].value, `${theme} ${width} ${gesture}`)
        const requestCount = saves.length
        expect(before.values[key].value).not.toBe(value)
        expect(before.values[key].writable, key).toBe(true)
        expect(typeof before.listing?.version).toBe('number')
        if (gesture === 'keyboard') await page.keyboard.press('Enter')
        else await cell.dblclick()
        const popup = page.locator('.ag-popup-editor')
        await expect(popup).toBeVisible()
        const saved = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/products/bulk-save'))
        if (column.kind === 'select') {
          const choice = popup.getByRole('option', { name: value === null ? 'Clear' : column.optionLabels?.[value] ?? value, exact: true })
          const count = await popup.getByRole('option').count()
          for (let step = 0; step <= count; step++) await page.keyboard.press('ArrowUp')
          for (let step = 0; step <= count; step++) {
            if (await choice.evaluate(el => el === document.activeElement)) break
            await page.keyboard.press('ArrowDown')
          }
          await expect(choice).toBeFocused()
          await page.keyboard.press('Enter')
        } else {
          const editor = popup.locator('input').first()
          await expect(editor).toBeVisible()
          await editor.fill(value!)
          if (gesture === 'keyboard') await editor.press('Enter')
          else await page.locator('h1').first().click()
        }
        const result = await saved
        expect(result.status()).toBe(200)
        const request = result.request().postDataJSON()
        expect(typeof request.operationId).toBe('string')
        expect(request.operationId.length).toBeGreaterThan(0)
        expect(result.request().headers()['idempotency-key']).toBe(request.operationId)
        expect(request.units).toHaveLength(1)
        const unit = request.units[0]
        expect(typeof unit.key).toBe('string')
        expect(unit.changes).toHaveLength(1)
        expect(unit.changes[0]).toMatchObject({ id: fixture.row, field: `attr_${key}`, value, target: 'channel', intent: 'set' })
        expect(unit.marketplaceContexts).toEqual([{ channel: 'AMAZON', marketplace: 'IT', accountId: fixture.account, locale: 'it', aliasKey: '' }])
        expect(unit.expectedVersion).toBe(before.listing!.version)
        const answer = await result.json()
        expect(answer).toMatchObject({ saved: 1, failed: 0 })
        expect(answer.units).toHaveLength(1)
        expect(answer.units[0]).toMatchObject({ key: unit.key, status: 200, body: { updated: 1, versionOf: 'channelListing' } })
        expect(answer.units[0].body.errors ?? []).toEqual([])
        const { row: stored } = await read()
        expect(stored.values[key].value).toBe(value)
        expect(answer.units[0].body.currentVersion).toBe(stored.listing!.version)
        expect(stored.listing!.version).toBeGreaterThan(before.listing!.version)
        await page.reload({ waitUntil: 'domcontentloaded' })
        await expect(page.getByText(fixture.name).first()).toBeVisible()
        const reloaded = await fieldCell(page, fixture.row, key)
        const { row } = await read()
        expect(row.values[key].value).toBe(value)
        expect(row.values[key].mapped?.warnings).toContain(warning(key))
        for (const identity of ['__productRole', '__parentSku']) expect(row.values[identity].writable).toBe(false)
        await reloaded.click({ button: 'right' })
        await page.getByText('Cell details…', { exact: true }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog).toContainText(warning(key))
        await expect(dialog).toContainText(value ?? 'Empty')
        if (key === fields[fields.length - 1]) await page.screenshot({ path: info.outputPath(`amazon-draft-${theme}-${width}.png`), fullPage: true })
        await dialog.getByRole('button', { name: 'Close', exact: true }).click()
        const sent = saves.slice(requestCount)
        expect(sent).toHaveLength(1)
        expect(sent[0].method()).toBe('POST')
        expect(sent[0].postDataJSON()).toEqual(request)
      }
      expect(saves).toHaveLength(7)
      expect(pageErrors).toEqual([])
      expect(consoleErrors).toEqual([])
    })
  }
})
