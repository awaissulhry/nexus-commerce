/** Local-only regression: Clear is a keyboard choice, including in short lists. */
import { expect, test, type Page } from '@playwright/test'
import { LEGACY_WORKSPACE_ID } from '@nexus/database/workspace-context'
import pg from 'pg'

const database = process.env.E2E_DATABASE_URL
const family = 'e2e_listbox_clear'
const workspace = process.env.E2E_WORKSPACE_ID ?? LEGACY_WORKSPACE_ID
const variants = ['desktop-light', 'desktop-dark', 'phone-light', 'phone-dark']

async function fixture(action: 'seed' | 'remove') {
  const url = new URL(database!)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.includes('test')) throw Error('A local test database is required')
  const db = new pg.Client({ connectionString: database })
  await db.connect()
  try {
    await db.query('BEGIN')
    await db.query(`SELECT set_config('nexus.workspace_id', $1, true)`, [workspace])
    await db.query(`DELETE FROM "ChannelListing" WHERE "productId" = $1 OR "productId" = ANY($2::text[])`, [family, variants.map(v => `${family}_${v}`)])
    await db.query(`DELETE FROM "Product" WHERE "parentId" = $1`, [family])
    await db.query(`DELETE FROM "Product" WHERE id = $1`, [family])
    if (action === 'seed') {
      await db.query(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "isParent", "updatedAt") VALUES ($1, $2, 'E2E-LISTBOX-CLEAR', 'Keyboard Clear family', 10, true, now())`, [family, workspace])
      for (const variant of variants) {
        await db.query(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "parentId", "updatedAt") VALUES ($1, $2, $3, $3, 10, $4, now())`, [`${family}_${variant}`, workspace, `E2E-CLEAR-${variant}`, family])
      }
      for (const [channel, market] of [['EBAY', 'IT'], ['ETSY', 'GLOBAL']]) {
        const connection = (await db.query(`SELECT id FROM "ChannelConnection" WHERE "workspaceId" = $1 AND "channelType" = $2 AND "isActive" ORDER BY "isPrimary" DESC, id LIMIT 1`, [workspace, channel])).rows[0]?.id
        if (!connection) throw Error(`The local fixture needs an active ${channel} connection; no channel call is made`)
        for (const id of [family, ...variants.map(v => `${family}_${v}`)]) {
          await db.query(`INSERT INTO "ChannelListing" (id, "workspaceId", "productId", channel, "channelMarket", marketplace, region, "channelConnectionId", "listingStatus", "isPublished", "platformAttributes", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, 'EU', $7, 'DRAFT', false, $8::jsonb, now())`, [`l_${channel}_${id}`, workspace, id, channel, `${channel}_${market}`, market, connection, JSON.stringify(channel === 'EBAY' ? { conditionId: '1000' } : { item_weight_unit: 'kg' })])
        }
      }
    }
    await db.query('COMMIT')
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  } finally { await db.end() }
}

async function focusColumn(page: Page, row: number, column: string) {
  await page.keyboard.press('Escape')
  await page.locator(`.ag-row[row-index="${row}"] .ag-cell[col-id="ag-Grid-AutoColumn"]`).click({ position: { x: 100, y: 3 } })
  for (let i = 0; i < 90; i++) {
    if (await page.locator('.ag-cell-focus').getAttribute('col-id') === column) break
    await page.keyboard.press('ArrowRight')
  }
  await expect(page.locator('.ag-cell-focus')).toHaveAttribute('col-id', column)
}

test.describe('product sheet — Clear by keyboard', () => {
  test.skip(!database || !process.env.E2E_EMAIL || !process.env.E2E_PASSWORD || !process.env.E2E_API_URL, 'Needs the local E2E database, API and login')
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)
  test.beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.E2E_API_URL!).hostname)) throw Error('A local API is required')
    await fixture('seed')
  })
  test.afterAll(async () => { await fixture('remove') })

  for (const variant of variants) {
    for (const [channel, market, column] of [['EBAY', 'IT', 'conditionId'], ['ETSY', 'GLOBAL', 'weightUnit']]) {
      const commitKey = variant.endsWith('dark') ? 'Tab' : 'Enter'
      test(`${channel} ${variant}: ArrowUp reaches Clear and ${commitKey} saves it once`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: variant.startsWith('phone') ? 390 : 1680, height: 1000 })
        // Theme is a preference under test; set it before the app mounts.
        await page.addInitScript((theme) => { localStorage.setItem('nexus:theme', theme) }, variant.endsWith('dark') ? 'dark' : 'light')
        await page.route(url => !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), route => route.abort())
        await page.goto('/login')
        await page.getByLabel('Email').fill(process.env.E2E_EMAIL!)
        await page.getByLabel('Password').fill(process.env.E2E_PASSWORD!)
        await page.getByRole('button', { name: 'Sign in' }).click()
        await page.waitForURL(url => !url.pathname.startsWith('/login'))
        const path = `/w/${workspace}/products/${family}/edit/studio?scope=${channel}&market=${market}&locale=${channel === 'ETSY' ? 'en' : 'it'}&tab=sheet`
        await page.goto(path)
        await expect(page.locator('.ag-row[row-index="1"]')).toBeVisible({ timeout: 90_000 })
        await expect.poll(() => page.locator('html').evaluate(el => el.classList.contains('dark'))).toBe(variant.endsWith('dark'))
        const row = variants.indexOf(variant) + 1
        await focusColumn(page, row, column)
        await page.keyboard.press('Enter')
        const popup = page.locator('.ag-popup-editor')
        await expect(popup).toBeVisible()
        await expect(popup.locator('input')).toHaveCount(0)
        await expect(popup.getByRole('option', { name: 'Clear', exact: true })).toHaveAttribute('aria-selected', 'false')
        const count = await popup.getByRole('option').count()
        for (let i = 0; i < count; i++) await page.keyboard.press('ArrowUp')
        await expect(popup.getByRole('option', { name: 'Clear', exact: true })).toBeFocused()
        await page.screenshot({ path: testInfo.outputPath(`${channel}-${variant}-clear.png`) })
        const requests: unknown[] = []
        page.on('request', request => {
          if (request.method() === 'POST' && request.url().endsWith('/api/products/bulk-save')) requests.push(request.postDataJSON())
        })
        const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/products/bulk-save'), { timeout: 30_000 })
        await page.keyboard.press(commitKey)
        const result = await (await response).json()
        expect(result.failed).toBe(0)
        expect(result.units).toHaveLength(1)
        expect(result.units[0].body.errors ?? []).toHaveLength(0)
        if (commitKey === 'Tab') {
          await expect(page.locator('.ag-cell-focus')).not.toHaveAttribute('col-id', column)
          // Tab continues editing in the next cell; cancel that untouched editor.
          await page.keyboard.press('Escape')
        }
        await expect(popup).toBeHidden()
        expect(requests).toHaveLength(1)
        expect(requests[0]).toMatchObject({ units: [{ changes: [{ field: `attr_${column}`, value: null, intent: 'set' }] }] })
        await page.reload()
        await expect(page.locator('.ag-row[row-index="1"]')).toBeVisible({ timeout: 90_000 })
        await focusColumn(page, row, column)
        await page.keyboard.press('Enter')
        await expect(popup.getByRole('option', { name: 'Clear', exact: true })).toHaveAttribute('aria-selected', 'true')
        await page.keyboard.press('Escape')
        expect(requests).toHaveLength(1)
      })
    }
  }
})
