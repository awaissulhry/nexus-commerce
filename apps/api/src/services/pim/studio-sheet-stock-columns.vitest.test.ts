/**
 * Amazon sheet gaps (gaps 4–5, D1 = A, D2 = A) — the product sheet READ and the bulk SAVE wired to the stock modules.
 *
 * 🔴 WHAT THIS GUARDS. A channel sheet shows Mode / Qty / Buffer as the Matrix's own cells (each row carries them in
 * `row.stock`), Amazon adds the market's ASIN, and the raw quantity columns (Amazon's quantity leaf, eBay's `quantity`)
 * are gone from the sheet. Shopify's inventory field is held while Nexus sends the quantity. The Shared (master) sheet is
 * unchanged. A bulk save of a listing quantity goes through the Matrix's Mode / Qty door (a pin: snapshot, one
 * QUANTITY_UPDATE, one version) and never the generic channel writer; a stock column is never written by the bulk save.
 *
 * In-process PostgreSQL (PGlite) with the production row policies, the harness of
 * `studio-sheet-amazon-offer-draft.vitest.test.ts`; every id and SKU is invented.
 * Run: npx vitest run src/services/pim/studio-sheet-stock-columns.vitest.test.ts (and with NEXUS_WORKSPACES_ENABLED=1).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../outbound-enqueue.js', async (importOriginal) => ({ ...await importOriginal<any>(), fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(async () => undefined), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: vi.fn(), subscribeListingEvents: vi.fn() }))
vi.mock('../listing-values-events.js', () => ({ announceListingValues: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(async () => []), refreshInTransaction: vi.fn() },
  FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('./readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { throw new Error(`network refused in a test: ${String(url)}`) }))

/** OUTERWEAR with Amazon's own offer and fulfilment roots (the cached IT definition's), and a title. */
const AMAZON_DEFINITION = await vi.hoisted(async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const fixture = fileURLToPath(new URL('./channel-specs/__tests__/fixtures/amazon-it-outerwear.trimmed.json', import.meta.url))
  const cached = JSON.parse(readFileSync(fixture, 'utf8'))
  const text = { type: 'array', minUniqueItems: 1, maxUniqueItems: 1, items: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }
  return { type: 'object', properties: { item_name: text, purchasable_offer: cached.properties.purchasable_offer, fulfillment_availability: cached.properties.fulfillment_availability } }
})
vi.mock('../categories/seller-schema.service.js', async () => {
  const { amazonSpecFromDefinition } = await import('./channel-specs/amazon.js')
  return { amazonSellerSpec: async (_account: string, marketplace: string, productType: string) => amazonSpecFromDefinition({ marketplace, productType, fetchedAt: new Date(), schemaVersion: 'fixture', schemaDefinition: AMAZON_DEFINITION }) }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkEdits, ProductBulkError } from '../products/bulk-edit.service.js'
import { AMAZON_FULFILMENT_KEY } from './channel-specs/amazon.js'
import { PARENT_REASON } from './matrix-cells.js'
import { getSheetColumns } from './sheet-columns.service.js'
import { getStudioSheet, resolveWriteRouting, type StudioSheet } from './studio-sheet.service.js'
import { AMAZON_QUANTITY_KEY, LISTING_ASIN_KEY, LISTING_ITEM_ID_KEY, STUDIO_STOCK_KEYS, isRawQuantityColumn, isShopifyInventoryColumn, stockControlRouting } from './studio-stock.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const acc: Record<string, string> = {}
const ids = { parent: 'stock-sheet-parent', child: 'stock-sheet-child' }
const listing: Record<string, { id: string; version: number }> = {}
const STOCK = 12

beforeAll(() => scoped(async () => {
  const market = (channel: string, code: string, marketplaceId?: string) => prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], ...(marketplaceId ? { marketplaceId } : {}) } as never })
  await market('AMAZON', 'IT', 'APJ6JRA9NG5V4'); await market('EBAY', 'IT'); await market('SHOPIFY', 'GLOBAL')
  for (const channel of ['AMAZON', 'EBAY', 'SHOPIFY']) {
    acc[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `stock-sheet-${channel}`, externalAccountId: `seller-${channel}`, isActive: true, isPrimary: true } as never })).id
  }
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR', schemaVersion: 'fixture', schemaDefinition: AMAZON_DEFINITION as never, expiresAt: new Date('2099-01-01') } })
  const warehouse = (await prisma.stockLocation.create({ data: { code: 'TEST-STOCK-SHEET-WH', name: 'Stock sheet warehouse', type: 'WAREHOUSE' } })).id
  await prisma.product.create({ data: { id: ids.parent, sku: 'TEST-STOCK-SHEET', name: 'Jacket', basePrice: 40, isParent: true, productType: 'OUTERWEAR', variationAxes: ['size'], fulfillmentMethod: 'FBM' } as never })
  await prisma.product.create({ data: { id: ids.child, sku: 'TEST-STOCK-SHEET-M', name: 'Jacket M', basePrice: 40, parentId: ids.parent, productType: 'OUTERWEAR', variantAttributes: { size: 'M' }, fulfillmentMethod: 'FBM' } as never })
  await prisma.stockLevel.create({ data: { productId: ids.child, locationId: warehouse, quantity: STOCK, available: STOCK } })
  for (const [channel, marketplace] of [['AMAZON', 'IT'], ['EBAY', 'IT'], ['SHOPIFY', 'GLOBAL']] as const) {
    for (const productId of [ids.parent, ids.child]) {
      listing[`${channel}:${productId}`] = await prisma.channelListing.create({ data: {
        productId, channel, marketplace, channelMarket: `${channel}_${marketplace}`, region: 'EU', channelConnectionId: acc[channel],
        listingStatus: 'ACTIVE', isPublished: true, externalListingId: `EXT-${channel}-${productId}`, price: 49.9,
        quantity: 5, followMasterQuantity: true, stockBuffer: 2, fulfillmentMethod: channel === 'AMAZON' ? 'FBM' : null,
      } as never, select: { id: true, version: true } })
    }
  }
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

const read = (channel: string | null, market: string, stockCells = true) => scoped(() => getStudioSheet({ productId: ids.parent, market, locale: 'it', stockCells,
  ...(channel ? { scope: 'channel', channel, accountId: acc[channel] } : { scope: 'master' }) } as never))
const row = (sheet: StudioSheet, id: string) => sheet.rows.find((r) => r.id === id && r.aliasId === null)!
const keys = (sheet: StudioSheet) => sheet.columns.map((c) => c.key)

describe('the channel sheet READ — the stock columns are the Matrix\'s cells', () => {
  it('Amazon: Mode / Qty / Buffer and the ASIN columns; no quantity leaf column (its root\'s other leaf stays); rows carry `stock`', async () => {
    const sheet = await read('AMAZON', 'IT')
    expect(keys(sheet)).toEqual(expect.arrayContaining([...STUDIO_STOCK_KEYS, LISTING_ASIN_KEY, AMAZON_FULFILMENT_KEY]))
    expect(keys(sheet)).not.toContain(AMAZON_QUANTITY_KEY)
    expect(sheet.columns.filter((c) => isRawQuantityColumn(c, 'AMAZON'))).toEqual([])
    const qty = sheet.columns.find((c) => c.key === 'stock_qty')!
    expect(qty).toMatchObject({ kind: 'stockControl', matrixCell: 'syncQty', writeTarget: 'channelListing', formulaWritable: false, writable: true })
    // The sheet's one set of groups (#246, `groupSheetColumns`): Mode / Qty / Buffer sit in Offer, the ASIN in Offer Identity.
    expect(qty).toMatchObject({ groupKey: 'sheet:offer', group: 'Offer' })
    expect(sheet.columns.find((c) => c.key === LISTING_ASIN_KEY)).toMatchObject({ groupKey: 'sheet:offer-identity', group: 'Offer Identity' })
    expect(sheet.groups.map((g) => g.key)).toEqual(expect.arrayContaining(['sheet:offer', 'sheet:offer-identity']))
    expect(typeof sheet.meta.phases?.stock).toBe('number')

    const child = row(sheet, ids.child)
    expect(child.stock).toMatchObject({ key: 'AMAZON:EU', marketKey: 'AMAZON:IT' })
    expect(child.stock!.cells).toMatchObject({ listingId: listing[`AMAZON:${ids.child}`].id })
    expect(child.values.stock_mode).toMatchObject({ value: child.stock!.cells!.sync!.mode, writeTarget: 'channelListing' })
    expect(child.values.stock_qty.value).toBe(child.stock!.cells!.sync!.intended)
    expect(child.values.stock_buffer.value).toBe(2)
    // Item ID control (I4): the ASIN cell is its control's door on a row with a listing; a live offer's ASIN stays Amazon's.
    expect(child.values[LISTING_ASIN_KEY]).toMatchObject({ value: `EXT-AMAZON-${ids.child}`, writable: true })
    expect(child.values[AMAZON_QUANTITY_KEY]).toBeUndefined()
    expect(keys(sheet)).not.toContain(LISTING_ITEM_ID_KEY)
  })

  it('a stock column routes through `stockControlRouting` in `resolveWriteRouting` too — never as a bulk field', async () => {
    const sheet = await read('AMAZON', 'IT')
    const col = sheet.columns.find((c) => c.key === 'stock_buffer')!
    expect(resolveWriteRouting(col, { channel: 'AMAZON' }, null)).toEqual(stockControlRouting(col))
  })

  it('eBay: the stock columns, no raw `quantity` column (the write contract still declares it), no ASIN', async () => {
    const sheet = await read('EBAY', 'IT')
    expect(keys(sheet)).toEqual(expect.arrayContaining([...STUDIO_STOCK_KEYS]))
    expect(keys(sheet)).not.toContain(LISTING_ASIN_KEY)
    expect(sheet.columns.filter((c) => isRawQuantityColumn(c, 'EBAY'))).toEqual([])
    const contract = await scoped(() => getSheetColumns({ market: 'IT', locale: 'it', accountId: acc.EBAY, onlyChannels: ['EBAY'], includeEmptyChannels: true, scopeKind: 'channel' } as never))
    expect(contract.columns.filter((c) => isRawQuantityColumn(c, 'EBAY')).length).toBeGreaterThan(0)
    const child = row(sheet, ids.child)
    expect(child.stock).toMatchObject({ key: 'EBAY:IT', marketKey: 'EBAY:IT' })
    expect(child.values.stock_qty.value).toBe(STOCK - 2)
    // Item ID control (I1): the eBay Item ID sits where the ASIN sits on Amazon. The main row's item is shown and is the
    // row's control; this variation holds ANOTHER item than its main row, so it reads "Not confirmed" (100% honest).
    expect(sheet.columns.find((c) => c.key === LISTING_ITEM_ID_KEY)).toMatchObject({ label: 'Item ID', groupKey: 'sheet:offer-identity', editable: false, formulaWritable: false })
    expect(row(sheet, ids.parent).values[LISTING_ITEM_ID_KEY]).toMatchObject({ value: `EXT-EBAY-${ids.parent}`, writable: true })
    expect(child.values[LISTING_ITEM_ID_KEY]).toMatchObject({ value: null, writable: false, writeBlockedReason: expect.stringContaining(`Not confirmed: this row holds Item ID EXT-EBAY-${ids.child}`) })
  })

  it('D2 — Shopify\'s inventory cells are held while Nexus sends the quantity, and not once sync is paused', async () => {
    const following = await read('SHOPIFY', 'GLOBAL')
    const inventory = following.columns.filter(isShopifyInventoryColumn)
    expect(inventory.length).toBeGreaterThan(0)
    for (const col of inventory) {
      expect(row(following, ids.child).values[col.key]).toMatchObject({ editable: false, writable: false,
        writeBlockedReason: 'Nexus sends this quantity to Shopify (Mode: Follow). Change it in the Qty column, or pause sync to edit it here.' })
      // The family row keeps its own reason (the field belongs to the variant rows).
      expect(row(following, ids.parent).values[col.key]).toMatchObject({ writable: false, writeBlockedReason: expect.not.stringMatching(/^Nexus sends this quantity/) })
    }
    await scoped(() => prisma.channelListing.update({ where: { id: listing[`SHOPIFY:${ids.child}`].id }, data: { syncPaused: true } }))
    try {
      const paused = await read('SHOPIFY', 'GLOBAL')
      for (const col of inventory) expect(row(paused, ids.child).values[col.key].writeBlockedReason).not.toMatch(/^Nexus sends this quantity/)
    } finally {
      await scoped(() => prisma.channelListing.update({ where: { id: listing[`SHOPIFY:${ids.child}`].id }, data: { syncPaused: false } }))
    }
  })

  it('Shopify (I3): the Product ID column; a held id reads "Not confirmed" until Shopify\'s read returns the row (not run here)', async () => {
    const sheet = await read('SHOPIFY', 'GLOBAL')
    expect(sheet.columns.find((c) => c.key === LISTING_ITEM_ID_KEY)).toMatchObject({ label: 'Product ID', editable: false, formulaWritable: false })
    expect(row(sheet, ids.parent).values[LISTING_ITEM_ID_KEY]).toMatchObject({ value: null, writable: true })
    expect(row(sheet, ids.child).values[LISTING_ITEM_ID_KEY]).toMatchObject({ value: null, writable: false,
      writeBlockedReason: expect.stringContaining(`Not confirmed: Nexus holds Shopify product EXT-SHOPIFY-${ids.child}, but Shopify did not return it`) })
    // The listing wire carries the last channel read's verdict (Etsy MISSING), never as a time.
    expect(row(sheet, ids.child).listing).toHaveProperty('lastSyncStatus', null)
    // E5 — the "Differs on Etsy" view is read for Etsy sheets only; every other sheet carries null.
    expect(row(sheet, ids.child).listing).toHaveProperty('contentDrift', null)
  })

  it('the Shared sheet is unchanged: no stock or ASIN columns, no `stock` on the rows', async () => {
    const sheet = await read(null, 'IT')
    expect(keys(sheet).filter((k) => (STUDIO_STOCK_KEYS as readonly string[]).includes(k) || k === LISTING_ASIN_KEY)).toEqual([])
    expect(sheet.rows.every((r) => r.stock === undefined)).toBe(true)
    expect(sheet.meta.phases?.stock).toBeUndefined()
  })

  it('an internal read (readiness, import preview, transfer) keeps the columns but skips the extra Matrix read', async () => {
    const sheet = await read('AMAZON', 'IT', false)
    expect(keys(sheet)).toEqual(expect.arrayContaining([...STUDIO_STOCK_KEYS, LISTING_ASIN_KEY]))
    expect(sheet.rows.every((r) => r.stock === undefined)).toBe(true)
    expect(sheet.meta.phases?.stock).toBeUndefined()
  })
})

const EBAY_IT = [{ channel: 'EBAY', marketplace: 'IT', locale: 'it', aliasKey: '' }]
const raw = async (id: string) => (await state.db.db.query(`SELECT quantity, "quantityOverride", "followMasterQuantity", "overrideData", version FROM "ChannelListing" WHERE id = $1`, [id])).rows[0]
const queued = async (id: string) => (await state.db.db.query(`SELECT count(*)::int AS n FROM "OutboundSyncQueue" WHERE "channelListingId" = $1 AND "syncType" = 'QUANTITY_UPDATE'`, [id])).rows[0].n
const save = (changes: unknown[], expectedVersion?: number) => scoped(() => applyProductBulkEdits({ changes, expectedVersion, marketplaceContexts: EBAY_IT } as never,
  { formulaCascade: false, contentPerRow: true, userId: 'sheet@test', logger: { warn: vi.fn(), error: vi.fn() } } as never))
  .catch((error) => error instanceof ProductBulkError ? { status: error.statusCode, ...error.details } as Record<string, any> : Promise.reject(error))

describe('the bulk SAVE — a listing quantity goes through the Matrix door', () => {
  it('eBay `ebay_quantity`: the listing is PINNED by the door (snapshot, one QUANTITY_UPDATE, one version) — never the generic write', async () => {
    const id = listing[`EBAY:${ids.child}`].id
    const before = await raw(id)
    expect(await save([{ id: ids.child, field: 'ebay_quantity', value: 4, target: 'channel' }], before.version)).toMatchObject({ success: true })
    const after = await raw(id)
    // The generic writer set `quantity` only (no override, nothing queued) and spent a second version.
    expect(after).toMatchObject({ quantity: 4, quantityOverride: 4, followMasterQuantity: false, version: before.version + 1 })
    expect(after.overrideData?.quantity).toBeUndefined()
    expect(await queued(id)).toBe(1)
  })

  it('eBay `attr_quantity` reset: back to Follow through the same door (the stock minus the buffer)', async () => {
    const id = listing[`EBAY:${ids.child}`].id
    const before = await raw(id)
    expect(await save([{ id: ids.child, field: 'attr_quantity', value: null, target: 'channel', intent: 'reset' }], before.version)).toMatchObject({ success: true })
    expect(await raw(id)).toMatchObject({ quantity: STOCK - 2, quantityOverride: null, followMasterQuantity: true, version: before.version + 1 })
    expect(await queued(id)).toBe(2)
  })

  it('a door refusal names its cell with the Matrix\'s sentence, and nothing is written', async () => {
    const id = listing[`EBAY:${ids.parent}`].id
    const before = await raw(id)
    const out = await save([{ id: ids.parent, field: 'ebay_quantity', value: 3, target: 'channel' }], before.version)
    expect(out).toMatchObject({ status: 400, error: PARENT_REASON, code: 'QUANTITY_REFUSED', errors: [{ id: ids.parent, field: 'ebay_quantity', error: PARENT_REASON }] })
    expect(await raw(id)).toEqual(before)
  })

  it('a stock column (`stock_*`) is refused by name and never written', async () => {
    const id = listing[`EBAY:${ids.child}`].id
    const before = await raw(id)
    const out = await save([{ id: ids.child, field: 'stock_qty', value: 9, target: 'channel' }, { id: ids.child, field: 'attr_stock_mode', value: 'PINNED', target: 'channel' }])
    expect(out.status).toBe(400)
    expect(out.errors).toEqual([
      { id: ids.child, field: 'stock_qty', error: expect.stringContaining('Mode, Qty and Buffer save through the Matrix') },
      { id: ids.child, field: 'attr_stock_mode', error: expect.stringContaining('Mode, Qty and Buffer save through the Matrix') },
    ])
    expect(await raw(id)).toEqual(before)
  })
})
