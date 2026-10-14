/**
 * Amazon Business step 5 (Part 4) — the product sheet's B2B price and Quantity discounts columns are the Matrix's own
 * business cells, READ ONLY: the Amazon sheet read carries, for each row, its MARKET's Matrix cells (`row.business`,
 * `AMAZON:IT` — never the EU group: the business offer is per market) and two cells that are never writable, whose
 * sentence says where they are set ("Set on the Matrix") or why the Matrix holds them (the parent, a market without B2B,
 * no listing there, no `products.price.edit`). Every other channel has neither the columns nor the cells.
 *
 * End to end through the sheet read (`getStudioSheet`, `stockCells` — the sheet a person sees) over a real PostgreSQL
 * in-process (PGlite), with the harness of `studio-sheet-amazon-offer-draft.vitest.test.ts` and the business audience
 * fixtures of `matrix-business.vitest.test.ts`. Every id and SKU is invented.
 * Run: npx vitest run src/services/pim/studio-sheet-business.vitest.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(async () => []), refreshInTransaction: vi.fn() },
  FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('./readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
// The type's rules are the cached rows below; any provider read is a fixture failure, never a network call.
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
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import { SHEET_GROUPS } from '@nexus/shared/sheet-groups'
import { OFFER_AUDIENCE_FIELD_KEY } from '../categories/seller-offer-audience.service.js'
import { isChannelWritable } from './channel-field-map.js'
import { writerAcceptsField } from './master-field-gate.js'
import { getMatrixRead } from './matrix.service.js'
import { PARENT_PRICE_REASON, PRICE_PERMISSION_REASON } from './matrix-cells.js'
import { resetSaleWindowColumnCache } from './sale-window.js'
import { getStudioSheet } from './studio-sheet.service.js'
import {
  STUDIO_BUSINESS_COPY, STUDIO_BUSINESS_KEYS, attachStudioStock, businessCellReason, studioBusinessColumns, studioStockSheetColumns, type StudioRowBusiness,
} from './studio-stock.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids = { parent: '', m: '', l: '' }
const listing: Record<string, string> = {}
let account = ''
let ebay = ''

beforeAll(() => scoped(async () => {
  // The sale window lives in two raw columns the Prisma schema does not declare (`sale-window.ts`).
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  resetSaleWindowColumnCache()
  for (const [code, marketplaceId] of [['IT', 'APJ6JRA9NG5V4'], ['DE', 'A1PA6795UKMFR9']] as const) {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId } as never })
    await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: code, productType: 'OUTERWEAR', schemaVersion: 'fixture', schemaDefinition: AMAZON_DEFINITION as never, expiresAt: new Date('2099-01-01') } })
  }
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'b2b-sheet', isActive: true, isPrimary: true, externalAccountId: 'FAKE-SELLER',
    authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
  ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'b2b-sheet-ebay', isActive: true, isPrimary: true } as never })).id
  ids.parent = (await prisma.product.create({ data: { sku: 'BS-JACKET', name: 'Jacket', basePrice: 105, isParent: true, productType: 'OUTERWEAR', variationAxes: ['size'] } as never })).id
  ids.m = (await prisma.product.create({ data: { sku: 'BS-JACKET-M', name: 'Jacket M', basePrice: 105, parentId: ids.parent, productType: 'OUTERWEAR', variantAttributes: { size: 'M' } } as never })).id
  ids.l = (await prisma.product.create({ data: { sku: 'BS-JACKET-L', name: 'Jacket L', basePrice: 105, parentId: ids.parent, productType: 'OUTERWEAR', variantAttributes: { size: 'L' } } as never })).id
  const make = async (key: string, productId: string, marketplace: string, extra: Record<string, unknown> = {}) => {
    listing[key] = (await prisma.channelListing.create({ data: {
      productId, channel: 'AMAZON', marketplace, channelMarket: `AMAZON_${marketplace}`, region: 'EU', channelConnectionId: account,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `B0${key.toUpperCase().replace('-', '')}`, price: 105, priceOverride: 105, followMasterPrice: false,
      quantity: 3, fulfillmentMethod: 'FBM', ...extra,
    } as never })).id
  }
  await make('p-it', ids.parent, 'IT'); await make('p-de', ids.parent, 'DE')
  await make('m-it', ids.m, 'IT', { businessPriceRule: 'PERCENT_OFF', businessPricePercent: 5, businessTiers: { type: 'percent', levels: [{ minQty: 2, value: 3 }] } })
  await make('m-de', ids.m, 'DE')
  await make('l-it', ids.l, 'IT') // no business price kept; no DE listing
  listing['m-ebay'] = (await prisma.channelListing.create({ data: {
    productId: ids.m, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'EU', channelConnectionId: ebay,
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'EXT-BS-EBAY', price: 105, quantity: 3,
  } as never })).id
  // What Amazon told this account: B2B on IT for OUTERWEAR, not on DE (the nightly schema refresh's measure).
  const audience = (marketplace: string, labels: Record<string, string>) => prisma.sellerReferenceLabel.create({ data: {
    channel: 'AMAZON', connectionId: account, marketplace, productType: 'OUTERWEAR', fieldKey: OFFER_AUDIENCE_FIELD_KEY, labels,
  } as never })
  await audience('IT', { B2B: 'Amazon Business (B2B)', ALL: 'Vendita su Amazon' })
  await audience('DE', { ALL: 'Bei Amazon verkaufen' })
}), 120_000)
afterAll(async () => { await state.db?.close() }, 30_000)

type SheetRow = { id: string; values: Record<string, any>; business?: StudioRowBusiness; stock?: unknown }
async function sheet(market: string, opts: { canEditPrice?: boolean } = {}) {
  return scoped(() => getStudioSheet({ productId: ids.parent, scope: 'channel', channel: 'AMAZON', market, locale: 'it', accountId: account,
    stockCells: true, canEditPrice: opts.canEditPrice ?? true } as never))
}
const rowOf = (s: { rows: unknown[] }, id: string) => (s.rows as SheetRow[]).find((r) => r.id === id)!
const matrixCell = async (productId: string, key: string, canEditPrice = true) =>
  (await scoped(() => getMatrixRead({ productId: ids.parent, accountId: account, canEditPrice }))).rows.find((r) => r.id === productId)!.cells[key]

describe('the Amazon sheet read carries the B2B pair, read only', () => {
  it('two columns in Offer, after the stock columns: never editable, bulk- or formula-writable, saying where they are set', async () => {
    const s = await sheet('IT')
    const cols = (s.columns as Array<Record<string, any>>).filter((c) => (STUDIO_BUSINESS_KEYS as readonly string[]).includes(c.key))
    expect(cols.map((c) => [c.key, c.label])).toEqual([['business_price', 'B2B price'], ['business_tiers', 'Quantity discounts']])
    for (const c of cols) {
      expect(c).toMatchObject({ group: SHEET_GROUPS.offer.label, groupKey: SHEET_GROUPS.offer.key, editable: false, writable: false, formulaWritable: false, requiredBy: [] })
      expect(c.helpText).toContain('Set on the Matrix')
    }
    const keys = (s.columns as Array<{ key: string }>).map((c) => c.key)
    expect(keys.indexOf('business_price')).toBeGreaterThan(keys.indexOf('stock_buffer'))
    expect(keys.indexOf('business_tiers')).toBe(keys.indexOf('business_price') + 1)
  })

  it('IT, a variant with a business price: its MARKET\'s Matrix cells unchanged (rule, price, tiers, send) — read only, "Set on the Matrix"', async () => {
    const r = rowOf(await sheet('IT'), ids.m)
    expect(r.business!.key).toBe('AMAZON:IT')
    expect(r.business!.coordinate).toMatchObject({ key: 'AMAZON:IT', kind: 'market' })
    expect(r.business!.cells).toEqual(await matrixCell(ids.m, 'AMAZON:IT'))
    expect(r.business!.cells!.business).toMatchObject({ rule: 'PERCENT_OFF', percent: 5, price: 99.75, normalPrice: 105, tiers: { type: 'percent', levels: [{ minQty: 2, value: 3, unitPrice: 96.76 }] } })
    // The Matrix lets this person set it — on the Matrix. Here: never writable, and the sentence says where.
    expect(r.business!.cells!.writable).toMatchObject({ businessPrice: true, businessTiers: true })
    expect(r.values.business_price).toMatchObject({ value: 99.75, editable: false, writable: false, writeBlockedReason: STUDIO_BUSINESS_COPY.setOnMatrix, source: 'matrix' })
    expect(r.values.business_tiers).toMatchObject({ value: { type: 'percent', levels: [{ minQty: 2, value: 3, unitPrice: 96.76 }] }, writable: false, writeBlockedReason: STUDIO_BUSINESS_COPY.setOnMatrix })
  })

  it('IT, a variant without a business price: empty, still "Set on the Matrix"; the parent: held with the Matrix\'s parent sentence', async () => {
    const s = await sheet('IT')
    const l = rowOf(s, ids.l)
    expect(l.business!.cells!.business).toMatchObject({ rule: null, price: null })
    expect(l.values.business_price).toMatchObject({ value: null, writable: false, writeBlockedReason: STUDIO_BUSINESS_COPY.setOnMatrix })
    const p = rowOf(s, ids.parent)
    expect(p.business!.cells!.business).toBeNull()
    for (const k of STUDIO_BUSINESS_KEYS) expect(p.values[k]).toMatchObject({ value: null, writable: false, writeBlockedReason: PARENT_PRICE_REASON })
  })

  it('without products.price.edit: the Matrix\'s permission sentence (the Matrix would not let this person set it either)', async () => {
    const r = rowOf(await sheet('IT', { canEditPrice: false }), ids.m)
    expect(r.business!.cells).toEqual(await matrixCell(ids.m, 'AMAZON:IT', false))
    expect(r.values.business_price).toMatchObject({ value: 99.75, writable: false, writeBlockedReason: PRICE_PERMISSION_REASON })
  })

  it('DE (Amazon lists no B2B there for this account): the cells are held with the market\'s reason; a row with no DE listing says so', async () => {
    const s = await sheet('DE')
    const m = rowOf(s, ids.m)
    expect(m.business!.key).toBe('AMAZON:DE')
    expect(m.business!.cells).not.toHaveProperty('business')
    expect(m.business!.coordinate!.cells).not.toContain('businessPrice')
    for (const k of STUDIO_BUSINESS_KEYS) expect(m.values[k]).toMatchObject({ value: null, writable: false, writeBlockedReason: MATRIX_COPY.absentBusiness('OUTERWEAR') })
    const l = rowOf(s, ids.l)
    expect(l.business).toMatchObject({ key: 'AMAZON:DE', cells: null })
    expect(l.values.business_price).toMatchObject({ value: null, writable: false, writeBlockedReason: MATRIX_COPY.noListingYet })
  })
})

describe('no other channel has the B2B pair', () => {
  it('the columns are Amazon\'s only, and no bulk or formula write can name them', () => {
    expect(studioBusinessColumns('AMAZON').map((c) => c.key)).toEqual(['business_price', 'business_tiers'])
    for (const c of studioStockSheetColumns('AMAZON').filter((col) => (STUDIO_BUSINESS_KEYS as readonly string[]).includes(col.key))) {
      // Not a channel field and not a master field: the bulk PATCH refuses it; the routing holds it with its help.
      expect(isChannelWritable(c.writeField)).toBe(false)
      expect(writerAcceptsField(c.writeField)).toBe(false)
      expect(c).toMatchObject({ editable: false, writable: false, formulaWritable: false, writeBlockedReason: c.helpText })
    }
    for (const channel of ['EBAY', 'SHOPIFY', 'ETSY', 'WOOCOMMERCE']) {
      expect(studioBusinessColumns(channel), channel).toEqual([])
      expect(studioStockSheetColumns(channel).map((c) => c.key), channel).not.toContain('business_price')
    }
  })

  it('an eBay sheet\'s stock pass gives no row a business projection or a business cell', async () => {
    const row = { id: ids.m, sku: 'BS-JACKET-M', aliasId: null, isParent: false, parentId: ids.parent, values: {},
      listing: { id: listing['m-ebay'], version: 0, externalListingId: 'EXT-BS-EBAY', syncPaused: false, follows: { followMasterQuantity: true } } } as never as SheetRow
    await scoped(() => attachStudioStock({ rows: [row as never], rootId: ids.parent, channel: 'EBAY', marketplace: 'IT', accountId: ebay, canEditPrice: true }))
    expect(row.stock).toBeDefined()
    expect(row).not.toHaveProperty('business')
    for (const k of STUDIO_BUSINESS_KEYS) expect(row.values).not.toHaveProperty(k)
  })
})

describe('the read-only sentence (pure)', () => {
  const coord = (cells: string[], absent: Array<{ cell: string; reason: string }> = []) => ({ cells, absent }) as never
  const cells = (writable: Record<string, boolean>, reasons: Record<string, string> = {}) => ({ writable, writeBlockedReason: reasons }) as never
  it('held first, then no cells, then the market\'s absence, then the Matrix\'s own hold, else "Set on the Matrix"', () => {
    expect(businessCellReason('businessPrice', cells({ businessPrice: true }), coord(['businessPrice']), MATRIX_COPY.accountMismatch)).toBe(MATRIX_COPY.accountMismatch)
    expect(businessCellReason('businessPrice', null, coord(['businessPrice']), null)).toBe(MATRIX_COPY.noListingYet)
    expect(businessCellReason('businessTiers', cells({}), coord([], [{ cell: 'businessTiers', reason: 'No B2B here' }]), null)).toBe('No B2B here')
    expect(businessCellReason('businessTiers', cells({}), coord([]), null)).toBe(MATRIX_COPY.absentBusinessUnchecked())
    expect(businessCellReason('businessPrice', cells({ businessPrice: false }, { businessPrice: PARENT_PRICE_REASON }), coord(['businessPrice']), null)).toBe(PARENT_PRICE_REASON)
    expect(businessCellReason('businessPrice', cells({ businessPrice: true }), coord(['businessPrice']), null)).toBe(STUDIO_BUSINESS_COPY.setOnMatrix)
  })
})
