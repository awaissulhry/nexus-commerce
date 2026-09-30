/**
 * P0 item 8 — an eBay sheet whose category has no field list in the business's cache loads it BY ITSELF, once per open
 * sheet, then reloads (`channel/MissingFieldsBanner.tsx`, `useMissingFieldsBanner`).
 *
 * Why a browser test: `apps/api/.../schema-download-sheet.vitest.test.ts` drives the download route, which already
 * fetched through the gateway before the fix — it passes on the commit before #186 (tests lens, 2026-09-30). What the fix
 * added is the SHEET asking for it; before it the sheet opened with only its fixed columns and sent no download at all,
 * so this spec's first assertion (one `POST …/categories/schema/download`) fails there.
 *
 * The download is answered HERE (`route.fulfill`): nothing reaches the API's download, and nothing can reach eBay. The
 * family, its made-up category and its credential-less account are seeded into E2E_DATABASE_URL (a LOCAL test database).
 * Env: `fixtures/sheet-e2e.ts`; CI: the `sheet` job.
 */
import { expect, test } from '@playwright/test'
import pg from 'pg'
import { isLocal, sheetEnv, studioPath } from './fixtures/sheet-e2e'

const FAMILY = 'e2e_missing_fields'
const CHILD = `${FAMILY}_1`
/** Made up: no eBay category has this id, so no business has its field list cached. */
const CATEGORY = '99990001'

async function fixture(action: 'seed' | 'remove') {
  const url = new URL(sheetEnv.database!)
  if (!isLocal(url.href) || !url.pathname.includes('test')) throw Error('A local test database is required')
  const db = new pg.Client({ connectionString: url.href })
  await db.connect()
  try {
    await db.query('BEGIN')
    await db.query(`SELECT set_config('nexus.workspace_id', $1, true)`, [sheetEnv.workspace])
    await db.query(`DELETE FROM "ChannelListing" WHERE "productId" = ANY($1::text[])`, [[FAMILY, CHILD]])
    await db.query(`DELETE FROM "Product" WHERE id = $1`, [CHILD])
    await db.query(`DELETE FROM "Product" WHERE id = $1`, [FAMILY])
    await db.query(`DELETE FROM "CategorySchema" WHERE channel = 'EBAY' AND "productType" = $1`, [CATEGORY])
    if (action === 'seed') {
      const market = await db.query(`SELECT 1 FROM "Marketplace" WHERE channel = 'EBAY' AND code = 'IT' AND "workspaceId" = $1`, [sheetEnv.workspace])
      if (!market.rowCount) {
        await db.query(`INSERT INTO "Marketplace" (id, "workspaceId", channel, code, name, currency, region, language, languages, "isActive", "marketplaceId", "updatedAt")
          VALUES ('e2e_market_ebay_it', $1, 'EBAY', 'IT', 'Italy', 'EUR', 'EU', 'it', ARRAY['it'], true, 'EBAY_IT', now())`, [sheetEnv.workspace])
      }
      let connection = (await db.query(`SELECT id FROM "ChannelConnection" WHERE "channelType" = 'EBAY' AND "isActive" AND "workspaceId" = $1
        ORDER BY "isPrimary" DESC, id LIMIT 1`, [sheetEnv.workspace])).rows[0]?.id
      if (!connection) {
        connection = 'e2e_ebay_connection'
        await db.query(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "isActive", "isPrimary", "displayName", "updatedAt")
          VALUES ($1, $2, 'EBAY', true, true, 'E2E eBay (no credentials)', now()) ON CONFLICT (id) DO UPDATE SET "isActive" = true`, [connection, sheetEnv.workspace])
      }
      await db.query(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "isParent", "updatedAt") VALUES ($1, $2, 'E2E-MISSING-FIELDS', 'E2E missing fields family', 10, true, now())`, [FAMILY, sheetEnv.workspace])
      await db.query(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "parentId", "updatedAt") VALUES ($1, $2, 'E2E-MISSING-FIELDS-1', 'E2E missing fields variation', 10, $3, now())`, [CHILD, sheetEnv.workspace, FAMILY])
      for (const productId of [FAMILY, CHILD]) {
        await db.query(`INSERT INTO "ChannelListing" (id, "workspaceId", "productId", channel, "channelMarket", marketplace, region, "channelConnectionId", "listingStatus", "isPublished", "syncPaused", "platformAttributes", "updatedAt")
          VALUES ($1, $2, $3, 'EBAY', 'EBAY_IT', 'IT', 'EU', $4, 'DRAFT', false, true, $5::jsonb, now())`, [`l_${productId}`, sheetEnv.workspace, productId, connection, JSON.stringify({ categoryId: CATEGORY })])
      }
    }
    await db.query('COMMIT')
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  } finally { await db.end() }
}

test.describe('product sheet — a missing eBay field list', () => {
  test.skip(!sheetEnv.database || !sheetEnv.auth, 'Needs E2E_DATABASE_URL (a LOCAL test database) and E2E_AUTH_STATE — see fixtures/sheet-e2e.ts.')
  test.use({ storageState: sheetEnv.auth, viewport: { width: 1680, height: 1000 } })
  test.beforeAll(async () => { await fixture('seed') })
  test.afterAll(async () => { await fixture('remove') })

  test('the sheet loads it by itself, once, then reads the sheet again', async ({ page }) => {
    await page.route((url) => !isLocal(url.href), (route) => route.abort())
    const downloads: unknown[] = []
    let sheetReads = 0
    let readsAtDownload = -1
    page.on('response', (response) => { if (response.url().includes('/studio/sheet?') && response.ok()) sheetReads++ })
    // Answered here as the API answers a successful load: nothing reaches the API's download or eBay.
    await page.route((url) => url.pathname.endsWith('/api/categories/schema/download'), async (route) => {
      downloads.push(route.request().postDataJSON())
      readsAtDownload = sheetReads
      await route.fulfill({ status: 200, json: { channel: 'EBAY', market: 'IT', remaining: 0, results: [{ productType: CATEGORY, outcome: 'added' }] } })
    })

    await page.goto(studioPath(FAMILY, 'scope=EBAY&market=IT&locale=it'))
    await expect(page.locator('.ag-row[row-index="1"]')).toBeVisible({ timeout: 90_000 })
    await expect(page.getByText('eBay fields for IT are not loaded yet.')).toBeVisible()

    // The fix: the sheet asks for the list it lacks, without the operator pressing anything.
    await expect.poll(() => downloads.length, { timeout: 30_000 }).toBe(1)
    expect(downloads[0]).toEqual({ channel: 'EBAY', market: 'IT', productTypes: [CATEGORY] })
    // …and on success it reads the sheet again, to show the new columns.
    await expect.poll(() => sheetReads, { timeout: 30_000 }).toBeGreaterThan(readsAtDownload)

    // One automatic attempt per open sheet: the list is still missing (this test stored nothing), so the banner offers
    // the button and the sheet does not ask again by itself.
    const button = page.getByRole('button', { name: 'Load eBay fields', exact: true })
    await expect(button).toBeVisible()
    await expect(button).toBeEnabled()
    expect(downloads).toHaveLength(1)

    // The button is the operator's retry: exactly one more download.
    await button.click()
    await expect.poll(() => downloads.length, { timeout: 30_000 }).toBe(2)
  })
})
