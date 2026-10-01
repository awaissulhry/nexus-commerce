/**
 * Shopify draft control on the real local stack (lane01, Plan A). Four modes: light/dark × 1680/390 px, real keyboard.
 *
 * Needs: the private sheet database (`tests/fixtures/sheet-database-target.mjs`, 55530/nexus_pse_test) seeded with
 * `tests/fixtures/shopify-control-seed.mjs`; a LOCAL API on that database whose Shopify reads come from the fixture's
 * synthetic store (`storeSchema` / `storeSnapshot` — no store is contacted, no credentials exist); the local web with
 * NEXT_PUBLIC_API_URL set to that API; a user of the legacy business.
 *
 *   PLAYWRIGHT_BASE_URL=http://localhost:<web> E2E_API_URL=http://127.0.0.1:<api> E2E_DATABASE_URL=… E2E_EMAIL=… E2E_PASSWORD=… \
 *     npx playwright test sheet-shopify-control
 *
 * Every save is checked three ways: the exact request body, the answer, and the stored draft read back with SQL. Each
 * mode starts from the fixture's starting draft (`resetShopifyControlDraft`): the legacy contradictory pin it holds cannot
 * be recreated through the UI — which is exactly what the undo refusal says.
 */
import { expect, test, type Page, type Request } from '@playwright/test'
import pg from 'pg'
import { privateSheetDatabaseConfig } from './fixtures/sheet-database-target.mjs'
import { ACCOUNT, FAMILY, LABEL, NOTE, WORKSPACE, column, familyListingId, members, resetShopifyControlDraft } from './fixtures/shopify-control-fixture.mjs'

const isLocal = (raw: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(raw).hostname)
const noteColumn = column('note'), labelColumn = column('label')
/** A single-cell save names the cell's ContentAddress (channelSheetWriter.ts); a column action sends none. The route accepts
 *  both and takes the language from the scope, so the bodies are compared exactly as each path sends them. */
const contentAddress = { coordinate: { accountId: ACCOUNT, channel: 'SHOPIFY', market: 'GLOBAL' }, language: 'en', tier: 'pin' }
const [family, blue, red] = members
type SheetValue = { ownerId: string; fieldId: string; locale: string; value: string | null; inherited?: true }
type Draft = { sheetValues?: SheetValue[]; sharedFields?: Array<{ key: string; excludedProductIds: string[] }> }

async function withDatabase<T>(run: (db: pg.Client) => Promise<T>, commit = false): Promise<T> {
  const db = new pg.Client(privateSheetDatabaseConfig(process.env.E2E_DATABASE_URL))
  await db.connect()
  try {
    await db.query('BEGIN')
    await db.query("SELECT set_config('nexus.workspace_id', $1, true)", [WORKSPACE])
    const result = await run(db)
    await db.query(commit ? 'COMMIT' : 'ROLLBACK')
    return result
  } catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error } finally { await db.end() }
}
/** The stored family draft, read back with SQL (read-only transaction, rolled back). */
const storedDraft = () => withDatabase(async db => {
  expect((await db.query('SELECT current_database() AS name')).rows[0].name).toBe(privateSheetDatabaseConfig(process.env.E2E_DATABASE_URL).database)
  const listing = (await db.query('SELECT "platformAttributes" AS pa FROM "ChannelListing" WHERE id=$1 AND "productId"=$2 AND "channelConnectionId"=$3', [familyListingId, FAMILY, ACCOUNT])).rows[0]
  expect(listing).toBeTruthy()
  return listing.pa._nexusLinkedProducts as Draft
})
const pin = (draft: Draft, ownerId: string, fieldId: string, locale = '') => draft.sheetValues?.find(v => v.ownerId === ownerId && v.fieldId === fieldId && v.locale === locale)
const labelRule = (draft: Draft) => draft.sharedFields?.find(rule => rule.key === 'label')

/** Focus a cell of the family row by keyboard (the auto column first, then →). */
async function focusCell(page: Page, colId: string) {
  await page.keyboard.press('Escape')
  const row = page.locator(`.ag-row[row-id="primary:${FAMILY}"]`)
  await expect(row).toBeVisible({ timeout: 90_000 })
  const focused = page.locator('.ag-cell-focus')
  if (await focused.count()) await focused.press('Home')
  await row.locator('.ag-cell[col-id="ag-Grid-AutoColumn"]').click({ position: { x: 100, y: 3 } })
  for (let i = 0; i < 150 && await page.locator('.ag-cell-focus').getAttribute('col-id') !== colId; i++) await page.keyboard.press('ArrowRight')
  await expect(page.locator('.ag-cell-focus')).toHaveAttribute('col-id', colId)
}
async function openField(page: Page, colId: string, label: string) {
  await focusCell(page, colId)
  await page.keyboard.press('Enter')
  const popup = page.getByRole('dialog', { name: new RegExp(label) })
  await expect(popup).toBeVisible()
  return popup
}
const cellsRequest = (page: Page) => page.waitForRequest(r => r.method() === 'POST' && r.url().includes('/shopify-linked/cells?'))
async function confirmed(request: Request) {
  const response = await request.response()
  expect(response?.status()).toBe(200)
  const body = await response!.json()
  expect(Object.values(body.cells).every((cell: unknown) => (cell as { ok: boolean }).ok)).toBe(true)
  return body
}
/** One single-cell save of the family's Care note: exact body (one stable action id, one receipt) and answer. */
async function commitNote(page: Page, value: string | null, key = 'Enter') {
  const sent = cellsRequest(page)
  await page.keyboard.press(key)
  const request = await sent
  expect(request.postDataJSON()).toEqual({ operationId: expect.any(String), cells: [{ ownerId: family.id, fieldId: NOTE, token: expect.any(String), baseline: 'Gentle wash',
    colId: noteColumn, contentAddress, intent: 'set', value, receiptKey: expect.any(String) }] })
  await confirmed(request)
}

test.describe('Shopify draft control against the real local writer', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)
  test.beforeAll(() => {
    for (const key of ['PLAYWRIGHT_BASE_URL', 'E2E_API_URL', 'E2E_DATABASE_URL', 'E2E_EMAIL', 'E2E_PASSWORD']) {
      if (!process.env[key]) throw Error(`${key} is required for the local Shopify proof`)
    }
    if (!isLocal(process.env.PLAYWRIGHT_BASE_URL!) || !isLocal(process.env.E2E_API_URL!)) throw Error('Only local web/API targets are allowed')
  })
  // Every mode starts from the same stored draft (the legacy pin included).
  test.beforeEach(() => withDatabase(db => resetShopifyControlDraft(db), true))

  for (const width of [1680, 390]) for (const theme of ['light', 'dark'] as const) {
    test(`${width}px ${theme}: conflict pop-up, draft warnings, Set column and undo with its refusal`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.addInitScript(value => localStorage.setItem('nexus:theme', value), theme)
      await page.route(url => !isLocal(url.href), route => route.abort())
      const errors: string[] = []
      let cellSaves = 0
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/shopify-linked/cells?')) cellSaves++ })
      await page.goto('/login')
      await page.getByLabel('Email').fill(process.env.E2E_EMAIL!)
      await page.getByLabel('Password').fill(process.env.E2E_PASSWORD!)
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.waitForURL(url => !url.pathname.startsWith('/login'))
      await page.goto(`/w/${WORKSPACE}/products/${FAMILY}/edit/studio?scope=SHOPIFY&market=GLOBAL&account=${ACCOUNT}&locale=en&tab=sheet`)

      // 1 — the kept pin and the value Shopify receives, before and after a reload; reading writes nothing.
      for (const reload of [false, true]) {
        if (reload) await page.reload()
        const popup = await openField(page, labelColumn, 'Shared label')
        await expect(popup.getByLabel('Shared label', { exact: true })).toHaveValue('Saved separate label')
        await expect(popup.getByText('Publishing uses the shared value')).toBeVisible()
        await expect(popup.getByRole('definition').filter({ hasText: /^Saved separate label$/ })).toBeVisible()
        await expect(popup.getByRole('definition').filter({ hasText: /^Shared source$/ })).toBeVisible()
        if (!reload) await page.screenshot({ path: info.outputPath(`shopify-sharing-conflict-${width}-${theme}.png`) })
        await page.keyboard.press('Enter') // unchanged: closes without a write
        await expect(popup).toBeHidden()
      }
      expect(cellSaves).toBe(0)

      // 2 — draft warnings: an over-long and a cleared required value are stored with a warning, and read back.
      const long = `Care note ${width} ${theme} needs more room`
      let popup = await openField(page, noteColumn, 'Care note')
      await popup.getByLabel('Care note', { exact: true }).fill(long)
      await expect(popup.getByText('Can save as a Nexus draft')).toBeVisible()
      await page.screenshot({ path: info.outputPath(`shopify-warning-${width}-${theme}.png`) })
      await commitNote(page, long)
      await expect.poll(async () => pin(await storedDraft(), family.id, NOTE)?.value).toBe(long)
      await page.reload()
      popup = await openField(page, noteColumn, 'Care note')
      await expect(popup.getByLabel('Care note', { exact: true })).toHaveValue(long)
      await popup.getByRole('button', { name: 'Clear value', exact: true }).press('Enter')
      await expect(popup.getByText(/Shopify needs this field/)).toBeVisible()
      await commitNote(page, null, 'Control+Enter')
      await expect.poll(async () => pin(await storedDraft(), family.id, NOTE)?.value).toBeNull()
      await page.reload()
      popup = await openField(page, noteColumn, 'Care note')
      await expect(popup.getByLabel('Care note', { exact: true })).toHaveValue('')
      await popup.getByLabel('Care note', { exact: true }).fill('Gentle wash')
      await commitNote(page, 'Gentle wash')
      await expect.poll(async () => pin(await storedDraft(), family.id, NOTE)?.value).toBe('Gentle wash')
      expect(cellSaves).toBe(3)

      // 3 — "Set every row…" from the column menu, by keyboard: one request, one stable action id, followers detached first.
      await focusCell(page, labelColumn)
      for (let i = 0; i < 20 && !(await page.evaluate(() => !!document.activeElement?.closest('.ag-header-cell'))); i++) await page.keyboard.press('ArrowUp')
      await expect(page.locator(`.ag-header-cell[col-id="${labelColumn}"]`)).toBeFocused()
      await page.keyboard.press('Alt+ArrowDown')
      const active = page.locator('.ag-menu-option-active')
      for (let i = 0; i < 30 && !/Set every row/.test(await active.textContent().catch(() => '') ?? ''); i++) await page.keyboard.press('ArrowDown')
      await expect(active).toContainText('Set every row')
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: /Set every row · Shared label/ })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('textbox').focus()
      await page.keyboard.type('Unified label')
      await page.screenshot({ path: info.outputPath(`shopify-set-column-${width}-${theme}.png`) })
      for (let i = 0; i < 10 && !/^Set 3 rows$/.test(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')); i++) await page.keyboard.press('Tab')
      const setSent = cellsRequest(page)
      await page.keyboard.press('Enter')
      const setRequest = await setSent
      const setBody = setRequest.postDataJSON()
      const setCell = (owner: typeof family, baseline: string) => ({ ownerId: owner.id, fieldId: LABEL, token: expect.any(String), baseline, colId: labelColumn, intent: 'set', value: 'Unified label', receiptKey: expect.any(String) })
      // Detach both followers (their tokens hold the source's state) before the source itself changes.
      expect(setBody).toEqual({ operationId: expect.any(String), cells: [setCell(family, 'Original'), setCell(red, 'Other'), setCell(blue, 'Shared source')] })
      expect(new Set(setBody.cells.map((cell: { receiptKey: string }) => cell.receiptKey)).size).toBe(3)
      await confirmed(setRequest)
      await expect.poll(async () => {
        const draft = await storedDraft()
        return { values: [family, blue, red].map(owner => pin(draft, owner.id, LABEL)?.value), excluded: [...labelRule(draft)!.excludedProductIds].sort() }
      }).toEqual({ values: ['Unified label', 'Unified label', 'Unified label'], excluded: [family.id, red.id].sort() })
      expect(cellSaves).toBe(4)

      // 4 — undo by keyboard: the source and the plain follower go back to FOLLOWING (reset, equal values or not); the
      // family's legacy pin under a following rule cannot be recreated, so undo refuses it and names the earlier value.
      await focusCell(page, labelColumn)
      const undoSent = cellsRequest(page)
      await page.keyboard.press('ControlOrMeta+z')
      const undoRequest = await undoSent
      const resetCell = (owner: typeof family, baseline: string) => ({ ownerId: owner.id, fieldId: LABEL, token: expect.any(String), baseline, colId: labelColumn, intent: 'reset', value: null, receiptKey: expect.any(String) })
      expect(undoRequest.postDataJSON()).toEqual({ operationId: expect.any(String), cells: [resetCell(blue, 'Shared source'), resetCell(red, 'Other')] })
      expect(undoRequest.postDataJSON().operationId).not.toBe(setBody.operationId)
      await confirmed(undoRequest)
      await expect(page.getByText(/Undo did not change Shared label on E2E-SHOPIFY-CONTROL\b/)).toBeVisible()
      await expect(page.getByText(/Saved separate label/).last()).toBeVisible()
      await page.screenshot({ path: info.outputPath(`shopify-undo-refusal-${width}-${theme}.png`) })
      await expect.poll(async () => {
        const draft = await storedDraft()
        return { family: pin(draft, family.id, LABEL)?.value, blue: pin(draft, blue.id, LABEL), red: pin(draft, red.id, LABEL) ?? null, excluded: labelRule(draft)!.excludedProductIds }
      }).toEqual({ family: 'Unified label', blue: expect.objectContaining({ value: 'Shared source', inherited: true }), red: null, excluded: [family.id] })
      expect(cellSaves).toBe(5)
      // The Italian pins of another language were never touched.
      expect((await storedDraft()).sheetValues!.filter(v => v.locale === 'it').map(v => v.value)).toEqual(['Lavare piano', 'Lavare piano', 'Lavare piano'])
      expect(errors).toEqual([])
    })
  }
})
