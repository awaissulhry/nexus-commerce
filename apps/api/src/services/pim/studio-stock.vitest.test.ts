/**
 * Amazon sheet gaps (gaps 4–5) — the product sheet's Mode / Qty / Buffer columns ARE the Matrix's own cells.
 *
 * 🔴 WHAT THIS GUARDS. The sheet must not read a listing's quantity a second way: each row carries the `MatrixCells` the
 * Matrix read builds for its coordinate, unchanged (an Amazon EU market → `AMAZON:EU`, UK → `AMAZON:UK`, an alias →
 * `#<aliasId>`, eBay → `EBAY:IT`), and its `values.stock_*` say exactly what those cells say — value, writable and the
 * Matrix's refusal sentence (FBA "Amazon-managed", shared stock, the parent, no listing, another account's listing).
 * The raw quantity columns leave the SHEET (the specs keep declaring them); the stock columns are never bulk-writable.
 *
 * Real Matrix read over a real PostgreSQL in-process (PGlite). Every id and SKU is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, pooled: new Set<string>() }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => undefined) }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
// Shared stock by SKU: a product in `state.pooled` sells from another business's stock — the ledger source the
// Matrix's own rule reads (the lender's pool door itself is covered by matrix-shared-stock.vitest.test.ts).
vi.mock('../stock-pool/sync-ledgers.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../stock-pool/sync-ledgers.js')>()
  return { ...real, loadSyncLedgers: async (...args: Parameters<typeof real.loadSyncLedgers>) => {
    const out = await real.loadSyncLedgers(...args)
    for (const [id, ledger] of out) if (state.pooled.has(id)) out.set(id, { ...ledger, source: { kind: 'pool', grantId: 'grant-test', ownerWorkspaceId: 'ws-lender', locations: [] } })
    return out
  } }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { MATRIX_COPY, type MatrixCells } from '@nexus/shared/matrix-contract'
import { getMatrixRead } from './matrix.service.js'
import { PARENT_REASON, sharedStockReason } from './matrix-cells.js'
import { isChannelWritable } from './channel-field-map.js'
import { writerAcceptsField } from './master-field-gate.js'
import { buildSheetColumns, type SheetCoordinate } from './sheet-columns.service.js'
import { etsyProductSpec } from './channel-specs/etsy.js'
import { amazonSpecFromDefinition } from './channel-specs/amazon.js'
import type { StudioRow } from './studio-sheet.service.js'
import {
  AMAZON_QUANTITY_KEY, ETSY_LISTING_ID_COPY, ITEM_ID_COPY, LISTING_ASIN_KEY, LISTING_ITEM_ID_KEY, SHOPIFY_PRODUCT_ID_COPY, STUDIO_STOCK_KEYS, attachStudioStock,
  confirmShopifyItemIds, isRawQuantityColumn, isShopifyInventoryColumn, listingItemIdState,
  listingAsinColumn, listingItemIdColumn, listingItemIdValue, shopifyInventoryHeldReason, studioStockColumns, studioStockKeys, studioStockSheetColumns,
  withStudioStockGroups, withoutRawQuantityColumns, type StudioRowStock,
} from './studio-stock.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const acc: Record<string, string> = {}
let warehouse = ''
let aliasId = ''
type Row = StudioRow & { stock?: StudioRowStock }
type Listing = { id: string; version: number; externalListingId: string | null }

beforeAll(() => scoped(async () => {
  const market = (channel: string, code: string, currency = 'EUR', region = 'EU') =>
    prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency, region, language: 'it', languages: ['it'] } })
  await market('AMAZON', 'IT'); await market('AMAZON', 'DE'); await market('AMAZON', 'UK', 'GBP', 'UK'); await market('EBAY', 'IT'); await market('SHOPIFY', 'GLOBAL')
  for (const [key, channelType, isPrimary] of [['AMAZON', 'AMAZON', true], ['AMAZON_B', 'AMAZON', false], ['EBAY', 'EBAY', true], ['SHOPIFY', 'SHOPIFY', true]] as const) {
    acc[key] = (await prisma.channelConnection.create({ data: { channelType, accountLabel: `studio-stock-${key}`, externalAccountId: `seller-${key}`, isActive: true, isPrimary } as never })).id
  }
  warehouse = (await prisma.stockLocation.create({ data: { code: 'TEST-STUDIO-STOCK-WH', name: 'Studio stock warehouse', type: 'WAREHOUSE' } })).id
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

async function product(id: string, opts: { parentId?: string; isParent?: boolean; stock?: number } = {}) {
  await prisma.product.create({ data: { id, sku: `TEST-${id.toUpperCase()}`, name: id, basePrice: 10, isParent: opts.isParent ?? false, parentId: opts.parentId ?? null, fulfillmentMethod: 'FBM' } as never })
  if (opts.stock) await prisma.stockLevel.create({ data: { productId: id, locationId: warehouse, quantity: opts.stock, available: opts.stock } })
}
async function listing(productId: string, channel: string, marketplace: string, o: { account?: string; fba?: boolean; pinned?: number; buffer?: number; alias?: string; asin?: string } = {}): Promise<Listing> {
  return prisma.channelListing.create({ data: {
    productId, channel, marketplace, channelMarket: `${channel}_${marketplace}`, region: marketplace === 'UK' ? 'UK' : 'EU',
    channelConnectionId: o.account ?? acc[channel], aliasId: o.alias ?? null, aliasKey: o.alias ?? '',
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: o.asin ?? `EXT-${productId}-${marketplace}${o.alias ? '-A' : ''}`,
    price: 10, quantity: o.pinned ?? 5, quantityOverride: o.pinned ?? null, followMasterQuantity: o.pinned === undefined,
    stockBuffer: o.buffer ?? 0, fulfillmentMethod: o.fba ? 'FBA' : 'FBM',
  } as never, select: { id: true, version: true, externalListingId: true } })
}
/** A sheet row as `studioSheetRead` builds it (only what the stock pass reads). */
const row = (id: string, l: Listing | null, o: { aliasId?: string | null; isParent?: boolean; syncPaused?: boolean } = {}): Row => ({
  id, sku: id, aliasId: o.aliasId ?? null, isParent: o.isParent ?? false, parentId: o.isParent ? null : 'p', values: {},
  listing: l ? { id: l.id, version: l.version, externalListingId: l.externalListingId, syncPaused: o.syncPaused ?? false, follows: { followMasterQuantity: true } } : null,
} as unknown as Row)

const L: Record<string, Listing> = {}
beforeAll(() => scoped(async () => {
  await product('ss-p', { isParent: true })
  for (const c of ['ss-c1', 'ss-c2', 'ss-c3', 'ss-c4']) await product(c, { parentId: 'ss-p', stock: 20 })
  aliasId = (await prisma.productListingAlias.create({ data: { productId: 'ss-p', channel: 'EBAY', marketplace: 'IT', channelConnectionId: acc.EBAY, label: 'Second', position: 1, status: 'ACTIVE' } as never })).id
  L.pIt = await listing('ss-p', 'AMAZON', 'IT', { asin: 'B0PARENTIT' }); L.pDe = await listing('ss-p', 'AMAZON', 'DE', { asin: 'B0PARENTDE' })
  L.c1It = await listing('ss-c1', 'AMAZON', 'IT'); L.c1De = await listing('ss-c1', 'AMAZON', 'DE', { asin: 'B0C1DE' })
  L.c1Uk = await listing('ss-c1', 'AMAZON', 'UK', { pinned: 4 })
  L.c1Eb = await listing('ss-c1', 'EBAY', 'IT', { buffer: 2 }); L.c1EbA = await listing('ss-c1', 'EBAY', 'IT', { alias: aliasId, pinned: 3 })
  L.c2It = await listing('ss-c2', 'AMAZON', 'IT', { fba: true }); L.c2De = await listing('ss-c2', 'AMAZON', 'DE', { fba: true })
  L.c3It = await listing('ss-c3', 'AMAZON', 'IT') // no DE listing
  L.c4De = await listing('ss-c4', 'AMAZON', 'DE'); state.pooled.add('ss-c4')
}), 120_000)

/** The read the sheet takes (its stock pass asks no price permission: the price cells are not the sheet's). */
const read = () => scoped(() => getMatrixRead({ productId: 'ss-p', accountId: acc.AMAZON, canEditPrice: false }))
const attach = (rows: Row[], channel: string, marketplace: string, accountId = acc[channel]) =>
  scoped(() => attachStudioStock({ rows, rootId: 'ss-p', channel, marketplace, accountId }))
/** The sheet values say what the cells say. */
function expectValuesMatchCells(r: Row, cells: MatrixCells) {
  expect(r.values.stock_mode).toMatchObject({ value: cells.sync?.mode ?? null, writable: cells.writable.syncMode === true })
  expect(r.values.stock_qty).toMatchObject({ value: cells.sync?.intended ?? null, writable: cells.writable.syncQty === true })
  expect(r.values.stock_buffer).toMatchObject({ value: cells.sync?.buffer ?? null, writable: cells.writable.syncBuffer === true })
  for (const [k, kind] of [['stock_mode', 'syncMode'], ['stock_qty', 'syncQty'], ['stock_buffer', 'syncBuffer']] as const) {
    if (cells.writable[kind] !== true) expect(r.values[k]!.writeBlockedReason).toBe(cells.writeBlockedReason[kind])
  }
}

describe('the coordinate a sheet row shows and writes', () => {
  it('Amazon DE → AMAZON:EU (its own market AMAZON:DE), UK → AMAZON:UK, an alias → #id, eBay → EBAY:IT', () => {
    expect(studioStockKeys('AMAZON', 'DE', null)).toEqual({ key: 'AMAZON:EU', marketKey: 'AMAZON:DE' })
    expect(studioStockKeys('amazon', 'it', null)).toEqual({ key: 'AMAZON:EU', marketKey: 'AMAZON:IT' })
    expect(studioStockKeys('AMAZON', 'UK', null)).toEqual({ key: 'AMAZON:UK', marketKey: 'AMAZON:UK' })
    expect(studioStockKeys('EBAY', 'IT', 'al-1')).toEqual({ key: 'EBAY:IT#al-1', marketKey: 'EBAY:IT#al-1' })
    expect(studioStockKeys('EBAY', 'IT', null)).toEqual({ key: 'EBAY:IT', marketKey: 'EBAY:IT' })
    expect(studioStockKeys('SHOPIFY', 'GLOBAL', null)).toEqual({ key: 'SHOPIFY:GLOBAL', marketKey: 'SHOPIFY:GLOBAL' })
  })
})

describe('the Matrix read\'s `only` filter', () => {
  it('computes only the named coordinates\' cells; every coordinate is still listed, and the cells are the full read\'s', async () => {
    const full = await read()
    const some = await scoped(() => getMatrixRead({ productId: 'ss-p', accountId: acc.AMAZON, canEditPrice: false, only: ['AMAZON:EU', 'AMAZON:DE'] }))
    expect(some.coordinates.map((c) => c.key)).toEqual(full.coordinates.map((c) => c.key))
    const c1 = some.rows.find((r) => r.id === 'ss-c1')!
    expect(Object.keys(c1.cells).sort()).toEqual(['AMAZON:DE', 'AMAZON:EU'])
    expect(c1.cells['AMAZON:EU']).toEqual(full.rows.find((r) => r.id === 'ss-c1')!.cells['AMAZON:EU'])
  })
})

describe('a sheet row carries the Matrix cells of its coordinate, unchanged', () => {
  it('Amazon DE: the EU group cells (one quantity for every EU market) — the same object the Matrix read holds; values == cells', async () => {
    const r = row('ss-c1', L.c1De!)
    await attach([r], 'AMAZON', 'DE')
    const m = await read()
    const cells = m.rows.find((x) => x.id === 'ss-c1')!.cells['AMAZON:EU']!
    expect(r.stock!.key).toBe('AMAZON:EU')
    expect(r.stock!.marketKey).toBe('AMAZON:DE')
    expect(r.stock!.cells).toEqual(cells)
    expect(r.stock!.coordinate).toMatchObject({ key: 'AMAZON:EU', kind: 'region-inventory', sharedInventoryWith: ['IT', 'DE'] })
    expect(cells.sync).toMatchObject({ kind: 'FOLLOW', mode: 'FOLLOW', intended: 20, buffer: 0 })
    expectValuesMatchCells(r, cells)
    expect(r.values.stock_qty).toMatchObject({ value: 20, writable: true, writeBlockedReason: null, writeTarget: 'channelListing', resettable: false })
  })

  it('Amazon UK: its own market coordinate; a pinned row holds its buffer with the Matrix sentence', async () => {
    const r = row('ss-c1', L.c1Uk!)
    await attach([r], 'AMAZON', 'UK')
    const cells = (await read()).rows.find((x) => x.id === 'ss-c1')!.cells['AMAZON:UK']!
    expect(r.stock!.key).toBe('AMAZON:UK')
    expect(r.stock!.cells).toEqual(cells)
    expect(r.values.stock_mode!.value).toBe('PINNED')
    expect(r.values.stock_qty!.value).toBe(4)
    expect(r.values.stock_buffer).toMatchObject({ writable: false, writeBlockedReason: 'A pinned listing ignores its buffer — set it to Follow first' })
    expectValuesMatchCells(r, cells)
  })

  it('eBay IT and its alias: EBAY:IT and EBAY:IT#<aliasId>, each with its own listing and numbers (never summed)', async () => {
    const primary = row('ss-c1', L.c1Eb!)
    const second = row('ss-c1', L.c1EbA!, { aliasId })
    await attach([primary, second], 'EBAY', 'IT')
    const cells = (await read()).rows.find((x) => x.id === 'ss-c1')!.cells
    expect(primary.stock).toMatchObject({ key: 'EBAY:IT', cells: cells['EBAY:IT'] })
    expect(second.stock).toMatchObject({ key: `EBAY:IT#${aliasId}`, cells: cells[`EBAY:IT#${aliasId}`] })
    expect(primary.stock!.cells!.listingId).toBe(L.c1Eb!.id)
    expect(second.stock!.cells!.listingId).toBe(L.c1EbA!.id)
    expect(primary.values.stock_qty!.value).toBe(18) // 20 − buffer 2
    expect(primary.values.stock_buffer!.value).toBe(2)
    expect(second.values.stock_qty!.value).toBe(3)
    expect(second.values.stock_qty!.layer).toBe('alias')
    expectValuesMatchCells(primary, cells['EBAY:IT']!)
    expectValuesMatchCells(second, cells[`EBAY:IT#${aliasId}`]!)
  })
})

describe('every refusal is the Matrix sentence', () => {
  it('FBA: Mode / Qty / Buffer held "Amazon-managed"', async () => {
    const r = row('ss-c2', L.c2De!)
    await attach([r], 'AMAZON', 'DE')
    for (const k of STUDIO_STOCK_KEYS) expect(r.values[k]).toMatchObject({ writable: false, editable: false, writeBlockedReason: MATRIX_COPY.amazonManaged })
    expect(r.stock!.cells!.sync!.kind).toBe('FBA_EXCLUDED')
  })

  it('shared stock: Qty held with the lender sentence; Buffer stays writable', async () => {
    const r = row('ss-c4', L.c4De!)
    await attach([r], 'AMAZON', 'DE')
    expect(r.values.stock_qty).toMatchObject({ writable: false, writeBlockedReason: sharedStockReason('another business') })
    expect(r.values.stock_mode).toMatchObject({ writable: false, writeBlockedReason: sharedStockReason('another business') })
    expect(r.values.stock_buffer!.writable).toBe(true)
  })

  it('the parent: held with the parent sentence; its ASIN is the parent ASIN', async () => {
    const r = row('ss-p', L.pDe!, { isParent: true })
    await attach([r], 'AMAZON', 'DE')
    for (const k of STUDIO_STOCK_KEYS) expect(r.values[k]).toMatchObject({ value: null, writable: false, writeBlockedReason: PARENT_REASON })
    // Item ID control (I4): a row with a listing is the ASIN control's door (writable); the control decides what may change.
    expect(r.values[LISTING_ASIN_KEY]).toMatchObject({ value: 'B0PARENTDE', writable: true, writeBlockedReason: null })
  })

  it('no listing on this market: held "No listing on this coordinate yet", no cells, no ASIN', async () => {
    const r = row('ss-c3', null)
    await attach([r], 'AMAZON', 'DE')
    expect(r.stock).toMatchObject({ key: 'AMAZON:EU', cells: null })
    for (const k of STUDIO_STOCK_KEYS) expect(r.values[k]).toMatchObject({ value: null, writable: false, writeBlockedReason: MATRIX_COPY.noListingYet })
    expect(r.values[LISTING_ASIN_KEY]).toMatchObject({ value: null, writeBlockedReason: MATRIX_COPY.noListingYet })
  })

  it('another listing than the Matrix holds for this market (another account\'s): held, and its cells are not shown', async () => {
    const r = row('ss-c1', { id: 'listing-of-another-account', version: 1, externalListingId: 'B0OTHER' })
    await attach([r], 'AMAZON', 'DE')
    expect(r.stock!.cells).toBeNull()
    for (const k of STUDIO_STOCK_KEYS) expect(r.values[k]).toMatchObject({ writable: false, writeBlockedReason: MATRIX_COPY.accountMismatch })
  })

  it('an EU row on another account than the Matrix EU group: held (the group would write the other account\'s rows)', async () => {
    await scoped(async () => {
      await product('ss2-p', { isParent: true })
      await product('ss2-c', { parentId: 'ss2-p', stock: 5 })
      await listing('ss2-c', 'AMAZON', 'IT')
      L.ss2De = await listing('ss2-c', 'AMAZON', 'DE', { account: acc.AMAZON_B })
    })
    const r = row('ss2-c', L.ss2De!)
    await scoped(() => attachStudioStock({ rows: [r], rootId: 'ss2-p', channel: 'AMAZON', marketplace: 'DE', accountId: acc.AMAZON_B }))
    expect(r.stock!.cells).toBeNull()
    for (const k of STUDIO_STOCK_KEYS) expect(r.values[k]).toMatchObject({ writable: false, writeBlockedReason: MATRIX_COPY.accountMismatch })
  })
})

describe('a standalone product is its own buyable listing', () => {
  it('its row is a variant row: its stock cells are read and writable (not held as a parent)', async () => {
    let l: Listing | null = null
    await scoped(async () => { await product('ss-solo', { stock: 7 }); l = await listing('ss-solo', 'EBAY', 'IT') })
    const r = row('ss-solo', l, { isParent: true })
    await scoped(() => attachStudioStock({ rows: [r], rootId: 'ss-solo', channel: 'EBAY', marketplace: 'IT', accountId: acc.EBAY }))
    const m = await scoped(() => getMatrixRead({ productId: 'ss-solo', canEditPrice: false }))
    expect(m.rows[0]).toMatchObject({ id: 'ss-solo', role: 'variant' })
    expect(r.values.stock_qty).toMatchObject({ value: 7, writable: true })
    expect(r.stock!.cells).toEqual(m.rows[0]!.cells['EBAY:IT'])
  })
})

describe('the ASIN column', () => {
  it('per market externalListingId on Amazon (read-only, Amazon assigns it); not on another channel', async () => {
    const it = row('ss-c1', L.c1It!), de = row('ss-c1', L.c1De!)
    await attach([it], 'AMAZON', 'IT'); await attach([de], 'AMAZON', 'DE')
    expect(it.values[LISTING_ASIN_KEY]).toMatchObject({ value: L.c1It!.externalListingId, writable: true, editable: true })
    expect(it.values[LISTING_ASIN_KEY]).not.toHaveProperty('pendingId')
    expect(de.values[LISTING_ASIN_KEY]!.value).toBe('B0C1DE')
    const eb = row('ss-c1', L.c1Eb!)
    await attach([eb], 'EBAY', 'IT')
    expect(eb.values[LISTING_ASIN_KEY]).toBeUndefined()
    expect(listingAsinColumn()).toMatchObject({ key: LISTING_ASIN_KEY, kind: 'text', editable: false, groupKey: 'master:identifiers' })
    expect(studioStockSheetColumns('AMAZON').map((c) => c.key)).toEqual([...STUDIO_STOCK_KEYS, LISTING_ASIN_KEY])
    expect(studioStockSheetColumns('EBAY').map((c) => c.key)).toEqual([...STUDIO_STOCK_KEYS, LISTING_ITEM_ID_KEY])
  })
})

describe('the eBay Item ID column (Item ID control, step I1)', () => {
  type ItemRow = Parameters<typeof listingItemIdValue>[0]
  const r = (id: string, listing: ItemRow['listing'], o: { parentId?: string | null; aliasId?: string | null } = {}): ItemRow =>
    ({ id, parentId: o.parentId ?? null, aliasId: o.aliasId ?? null, listing })
  const live = (externalListingId: string | null, listingStatus = 'ACTIVE', isPublished = true) => ({ externalListingId, listingStatus, isPublished })

  it('a column on eBay only, beside the ASIN\'s group; never a bulk, formula or grid edit (its own control writes it)', () => {
    expect(listingItemIdColumn('EBAY')).toMatchObject({ key: LISTING_ITEM_ID_KEY, label: 'Item ID', kind: 'text', editable: false, formulaWritable: false, defaultVisible: true, groupKey: 'master:identifiers', width: 168 })
    // I2 / I3: Etsy's Listing ID and Shopify's Product ID take the same column; Amazon keeps its ASIN column.
    expect(listingItemIdColumn('ETSY')).toMatchObject({ key: LISTING_ITEM_ID_KEY, label: 'Listing ID', editable: false, formulaWritable: false })
    expect(listingItemIdColumn('SHOPIFY')).toMatchObject({ key: LISTING_ITEM_ID_KEY, label: 'Product ID', editable: false, formulaWritable: false })
    for (const ch of ['AMAZON', 'WOOCOMMERCE']) expect(listingItemIdColumn(ch)).toBeNull()
    const col = studioStockSheetColumns('EBAY').find((c) => c.key === LISTING_ITEM_ID_KEY)!
    expect(col).toMatchObject({ writable: false, formulaWritable: false })
    expect(isChannelWritable(col.writeField)).toBe(false)
    expect(writerAcceptsField(col.writeField)).toBe(false)
    expect(withStudioStockGroups([], 'EBAY').map((g) => g.key)).toEqual(['master:inventory', 'master:identifiers'])
  })

  it('the id only when it counts: live (Active, Inactive) and Ended; the main row is writable, its hover the state', () => {
    expect(listingItemIdValue(r('p', live('520000000001')), null)).toMatchObject({ value: '520000000001', writable: true, editable: true, writeBlockedReason: null })
    expect(listingItemIdValue(r('p', live('520000000001', 'INACTIVE')), null)).toMatchObject({ value: '520000000001' })
    expect(listingItemIdValue(r('p', live('520000000001', 'ENDED')), null)).toMatchObject({ value: '520000000001', writable: true })
  })

  it('held but not confirmed (a Draft, an Error with an id): no value; Nexus cannot vouch for it', () => {
    for (const status of ['DRAFT', 'ERROR', 'REMOVED']) {
      expect(listingItemIdValue(r('p', live('520000000001', status, false)), null)).toMatchObject({ value: null, writable: true })
    }
    const child = r('c', live('520000000001', 'DRAFT', false), { parentId: 'p' })
    expect(listingItemIdValue(child, r('p', live('520000000001')))).toMatchObject({ value: null, writable: false,
      writeBlockedReason: `${ITEM_ID_COPY.notConfirmed('520000000001', 'DRAFT')} ${ITEM_ID_COPY.variation}` })
  })

  it('a variation: the main row\'s item, read-only "Set on the main row"; another item than the main row\'s is "Not confirmed"', () => {
    const main = r('p', live('520000000001'))
    expect(listingItemIdValue(r('c', live('520000000001'), { parentId: 'p' }), main)).toMatchObject({ value: '520000000001', writable: false, editable: false, writeBlockedReason: ITEM_ID_COPY.variation })
    expect(listingItemIdValue(r('c', live('520000000002'), { parentId: 'p' }), main)).toMatchObject({ value: null, writable: false, writeBlockedReason: ITEM_ID_COPY.otherItem('520000000002', '520000000001') })
    expect(listingItemIdValue(r('c', live('520000000002'), { parentId: 'p' }), r('p', live(null, 'DRAFT', false)))).toMatchObject({ value: null, writeBlockedReason: ITEM_ID_COPY.otherItem('520000000002', null) })
  })

  it('a draft, live without a number, no listing', () => {
    expect(listingItemIdValue(r('p', live(null, 'DRAFT', false)), null)).toMatchObject({ value: null, writable: true })
    expect(listingItemIdValue(r('c', live(null, 'DRAFT', false), { parentId: 'p' }), null)).toMatchObject({ value: null, writable: false, writeBlockedReason: `${ITEM_ID_COPY.draft} ${ITEM_ID_COPY.variation}` })
    expect(listingItemIdValue(r('c', live(null), { parentId: 'p' }), null)).toMatchObject({ value: null, writeBlockedReason: `${ITEM_ID_COPY.noNumber} ${ITEM_ID_COPY.variation}` })
    expect(listingItemIdValue(r('p', null), null)).toMatchObject({ value: null, writable: false, writeBlockedReason: MATRIX_COPY.noListingYet })
  })

  it('the sheet pass fills it on eBay rows, each variation compared with ITS group\'s main row (an alias is its own group)', async () => {
    const parent = { ...row('ss-p', { id: 'l-p', version: 1, externalListingId: '520000000001' }, { isParent: true }), id: 'ss-p' } as Row
    const child = { ...row('ss-c1', L.c1Eb!), parentId: 'ss-p' } as Row
    const aliased = { ...row('ss-c1', L.c1EbA!, { aliasId }), parentId: 'ss-p' } as Row
    for (const x of [parent, child, aliased]) Object.assign(x.listing!, { listingStatus: 'ACTIVE', isPublished: true })
    Object.assign(child.listing!, { externalListingId: '520000000001' })
    await attach([parent, child, aliased], 'EBAY', 'IT')
    expect(parent.values[LISTING_ITEM_ID_KEY]).toMatchObject({ value: '520000000001', writable: true })
    expect(child.values[LISTING_ITEM_ID_KEY]).toMatchObject({ value: '520000000001', writable: false, writeBlockedReason: ITEM_ID_COPY.variation })
    // The alias row has no main row in ITS group here: nothing to compare with, so its own state stands.
    expect(aliased.values[LISTING_ITEM_ID_KEY]).toMatchObject({ value: L.c1EbA!.externalListingId, writable: false })
    const amazon = row('ss-c1', L.c1It!)
    await attach([amazon], 'AMAZON', 'IT')
    expect(amazon.values[LISTING_ITEM_ID_KEY]).toBeUndefined()
  })
})

describe('the Etsy Listing ID and the Shopify Product ID (Item ID control, steps I2 and I3)', () => {
  type ItemRow = Parameters<typeof listingItemIdValue>[0]
  const r = (id: string, listing: ItemRow['listing'], parentId: string | null = null): ItemRow => ({ id, parentId, aliasId: null, listing })
  const etsy = (externalListingId: string | null, listingStatus = 'ACTIVE', lastSyncStatus: string | null = 'SUCCESS', isPublished = true) => ({ externalListingId, listingStatus, isPublished, lastSyncStatus })

  it('Etsy: live, inactive and ended count; a listing Etsy did not return on its last read (MISSING) is "Not confirmed"', () => {
    expect(listingItemIdValue(r('p', etsy('1234567890')), null, 'ETSY')).toMatchObject({ value: '1234567890', writable: true })
    expect(listingItemIdValue(r('p', etsy('1234567890', 'INACTIVE')), null, 'ETSY')).toMatchObject({ value: '1234567890' })
    expect(listingItemIdValue(r('p', etsy('1234567890', 'ENDED')), null, 'ETSY')).toMatchObject({ value: '1234567890' })
    expect(listingItemIdState(r('p', etsy('1234567890', 'ACTIVE', 'MISSING')), null, 'ETSY')).toEqual({ state: 'notConfirmed', value: null, sentence: ETSY_LISTING_ID_COPY.missing('1234567890') })
    // A FAILED or never-stamped read says nothing against the record: the Nexus record stands (D-A2 = A).
    expect(listingItemIdValue(r('p', etsy('1234567890', 'ACTIVE', 'FAILED')), null, 'ETSY')).toMatchObject({ value: '1234567890' })
    expect(listingItemIdValue(r('p', etsy('1234567890', 'ACTIVE', null)), null, 'ETSY')).toMatchObject({ value: '1234567890' })
    expect(listingItemIdState(r('p', etsy('1234567890', 'DRAFT', 'SUCCESS', false)), null, 'ETSY').state).toBe('notConfirmed')
  })

  it('Etsy: one listing per family — a variation says "Set on the main row"; another listing than the main row\'s is "Not confirmed"', () => {
    const main = r('p', etsy('1234567890'))
    expect(listingItemIdValue(r('c', etsy('1234567890'), 'p'), main, 'ETSY')).toMatchObject({ value: '1234567890', writable: false, writeBlockedReason: ETSY_LISTING_ID_COPY.variation })
    expect(listingItemIdValue(r('c', etsy('999'), 'p'), main, 'ETSY')).toMatchObject({ value: null, writeBlockedReason: ETSY_LISTING_ID_COPY.otherItem('999', '1234567890') })
    expect(listingItemIdValue(r('c', etsy(null, 'DRAFT', null, false), 'p'), null, 'ETSY')).toMatchObject({ writeBlockedReason: `${ETSY_LISTING_ID_COPY.draft} ${ETSY_LISTING_ID_COPY.variation}` })
  })

  it('Shopify: a held Product ID is "Not confirmed" until the open sheet\'s Shopify read returns the row; then it counts', () => {
    const shop = (externalListingId: string | null, listingStatus = 'ACTIVE', isPublished = true) => ({ externalListingId, listingStatus, isPublished })
    expect(listingItemIdState(r('p', shop('7001')), null, 'SHOPIFY')).toEqual({ state: 'notConfirmed', value: null, sentence: SHOPIFY_PRODUCT_ID_COPY.notConfirmed('7001') })
    // Colour stores: a variation's product differs from the root's — never "another item" (Shopify's read decides).
    expect(listingItemIdValue(r('c', shop('7002'), 'p'), r('p', shop(null, 'DRAFT', false)), 'SHOPIFY')).toMatchObject({ value: null, writable: false,
      writeBlockedReason: `${SHOPIFY_PRODUCT_ID_COPY.notConfirmed('7002')} ${SHOPIFY_PRODUCT_ID_COPY.variation}` })
    expect(listingItemIdValue(r('p', shop(null, 'DRAFT', false)), null, 'SHOPIFY')).toMatchObject({ value: null, writable: true })
    const rows = [
      { id: 'p', parentId: null, listing: shop('7001'), shopify: { productId: 'gid://shopify/Product/7001', listingId: 'l-p' }, values: { [LISTING_ITEM_ID_KEY]: listingItemIdValue(r('p', shop('7001')), null, 'SHOPIFY') } },
      { id: 'c', parentId: 'p', listing: shop('7001'), shopify: { productId: 'gid://shopify/Product/7001', listingId: 'l-p' }, values: { [LISTING_ITEM_ID_KEY]: listingItemIdValue(r('c', shop('7001'), 'p'), null, 'SHOPIFY') } },
      { id: 'd', parentId: 'p', listing: shop('7009'), values: { [LISTING_ITEM_ID_KEY]: listingItemIdValue(r('d', shop('7009'), 'p'), null, 'SHOPIFY') } },
    ] as unknown as StudioRow[]
    const [p, c, d] = confirmShopifyItemIds(rows)
    expect(p.values[LISTING_ITEM_ID_KEY]).toMatchObject({ value: '7001', writable: true, writeBlockedReason: null })
    expect(c.values[LISTING_ITEM_ID_KEY]).toMatchObject({ value: '7001', writable: false, writeBlockedReason: SHOPIFY_PRODUCT_ID_COPY.variation })
    // Not returned by Shopify: unchanged, "Not confirmed".
    expect(d).toBe(rows[2])
    expect(d.values[LISTING_ITEM_ID_KEY]).toMatchObject({ value: null })
  })

  it('Amazon (I4): a row not on Amazon carries the ASIN it lists on at Publish, never as its value; a live row carries none', async () => {
    const draft = await scoped(async () => {
      await product('ss-c5', { parentId: 'ss-p', stock: 2 })
      return prisma.channelListing.create({ data: { productId: 'ss-c5', channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: acc.AMAZON,
        listingStatus: 'DRAFT', isPublished: false, externalListingId: null, overrideData: { merchant_suggested_asin: 'b0sugg0001' } } as never, select: { id: true, version: true, externalListingId: true } })
    })
    const r5 = row('ss-c5', draft)
    Object.assign(r5.listing!, { listingStatus: 'DRAFT', isPublished: false })
    const live = row('ss-c1', L.c1It!)
    Object.assign(live.listing!, { listingStatus: 'ACTIVE', isPublished: true })
    await attach([r5, live], 'AMAZON', 'IT')
    expect(r5.values[LISTING_ASIN_KEY]).toMatchObject({ value: null, writable: true, pendingId: { id: 'B0SUGG0001', sentence: 'Lists on B0SUGG0001 at Publish' } })
    expect(live.values[LISTING_ASIN_KEY]).not.toHaveProperty('pendingId')
  })
})

describe('the columns', () => {
  it('Mode / Qty / Buffer on every channel the Matrix covers, with the Matrix labels — never bulk- or formula-writable', () => {
    for (const ch of ['AMAZON', 'EBAY', 'ETSY', 'WOOCOMMERCE', 'SHOPIFY']) {
      const cols = studioStockColumns(ch)
      expect(cols.map((c) => [c.key, c.label, c.matrixCell, c.kind])).toEqual([
        ['stock_mode', 'Mode', 'syncMode', 'stockControl'], ['stock_qty', 'Qty', 'syncQty', 'stockControl'], ['stock_buffer', 'Buffer', 'syncBuffer', 'stockControl'],
      ])
      for (const c of cols) expect(c).toMatchObject({ groupKey: 'master:inventory', storage: 'listing', formulaWritable: false, requiredBy: [], defaultVisible: true })
    }
    expect(studioStockColumns('ZALANDO')).toEqual([])
    for (const c of studioStockSheetColumns('SHOPIFY')) {
      // Not a channel field (no attr_ prefix, not mapped) and not a master field: the bulk PATCH refuses it.
      expect(isChannelWritable(c.writeField)).toBe(false)
      expect(writerAcceptsField(c.writeField)).toBe(false)
      expect(c).toMatchObject({ writeField: c.key, writeTarget: 'channelListing', writeVerb: 'channel', affectsAllChannels: false, formulaWritable: false })
    }
  })

  it('the raw quantity columns leave the sheet while the specs still declare them (Etsy quantity, Amazon fulfilment quantity)', () => {
    const etsy = etsyProductSpec()
    expect(etsy.fields.find((f) => f.key === 'quantity')?.channelStore).toEqual({ kind: 'listingColumn', column: 'quantity', followFlag: 'followMasterQuantity' })
    const coordinate: SheetCoordinate = { channel: 'ETSY', marketplace: 'GLOBAL', label: 'Etsy · GLOBAL', inMarket: true }
    const { columns } = buildSheetColumns({ fields: [], specs: [{ coordinate, spec: etsy }], coordinates: [coordinate], scopeKind: 'channel' })
    expect(columns.some((c) => c.key === 'quantity')).toBe(true)
    const kept = withoutRawQuantityColumns(columns, 'ETSY')
    expect(kept.some((c) => c.key === 'quantity')).toBe(false)
    expect(kept.length).toBe(columns.length - 1)
    expect(etsyProductSpec().fields.some((f) => f.key === 'quantity')).toBe(true)

    const amazon = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'TEST', schemaDefinition: { properties: { fulfillment_availability: {
      type: 'array', items: { type: 'object', properties: { fulfillment_channel_code: { type: 'string' }, quantity: { type: 'integer' } } } } } } })
    expect(amazon.fields.some((f) => f.key === AMAZON_QUANTITY_KEY)).toBe(true)
    expect(isRawQuantityColumn({ key: AMAZON_QUANTITY_KEY }, 'AMAZON')).toBe(true)
    expect(isRawQuantityColumn({ key: 'fulfillment_availability__fulfillment_channel_code' }, 'AMAZON')).toBe(false)
    // Shopify's inventory quantity is its own field (D2 holds it), not a listing quantity column.
    expect(isRawQuantityColumn({ key: 'availableQuantity', channels: { 'Shopify · GLOBAL': { store: { kind: 'platformAttributes', path: ['availableQuantity'] } } as never } }, 'SHOPIFY')).toBe(false)
  })
})

describe('D2 — Shopify\'s inventory field while Nexus sends the quantity', () => {
  const sync = (over: Partial<NonNullable<MatrixCells['sync']>>) => ({ cells: { sync: { kind: 'FOLLOW', mode: 'FOLLOW', intended: 5, held: 5, ...over } } }) as unknown as StudioRowStock
  const listing = { syncPaused: false, follows: { followMasterQuantity: true } }
  it('held while it follows or is pinned, with a sentence pointing to Qty; free while paused or without a listing', () => {
    expect(shopifyInventoryHeldReason({ listing, stock: sync({}) })).toBe('Nexus sends this quantity to Shopify (Mode: Follow). Change it in the Qty column, or pause sync to edit it here.')
    expect(shopifyInventoryHeldReason({ listing, stock: sync({ kind: 'PINNED', mode: 'PINNED', intended: 4 }) })).toContain('Mode: Pinned at 4')
    expect(shopifyInventoryHeldReason({ listing, stock: sync({ kind: 'PAUSED', via: 'POLICY' }) })).toBeNull()
    expect(shopifyInventoryHeldReason({ listing: null })).toBeNull()
    // Without Matrix cells, the listing's own flags decide.
    expect(shopifyInventoryHeldReason({ listing: { syncPaused: true, follows: {} } })).toBeNull()
    expect(shopifyInventoryHeldReason({ listing: { syncPaused: false, follows: { followMasterQuantity: false } } })).toContain('Mode: Pinned')
    expect(isShopifyInventoryColumn({ shopifyField: { id: 'inventory' } as never })).toBe(true)
    expect(isShopifyInventoryColumn({ shopifyField: { id: 'price' } as never })).toBe(false)
  })
})
