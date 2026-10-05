/**
 * S11 — the product sheet's first column in a channel scope (plan docs/sheet-ids-sku-rows/PLAN.md): each row carries
 * the SKU Publish sends for its listing (the S2 resolver), whether that differs from the Shared SKU, the SKU the channel
 * holds, and whether the cell can be edited here (with the reason when not). Two halves:
 *   1. the pure rule (`sheetRowSku`) — every kind of row;
 *   2. the real sheet read (`getStudioSheet`, Amazon · IT) on PGlite with the production schema: the facts on every row,
 *      only the flat-file SKU key kept from a snapshot, and the Shared scope carrying none (its first column is Product.sku).
 * Ids invented. Run: npx vitest run src/services/pim/studio-sheet-sku.vitest.test.ts (from apps/api).
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
// The type's rules are the cached row below; any provider read is a fixture failure, never a network call.
vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { throw new Error(`network refused in a test: ${String(url)}`) }))

/** OUTERWEAR with a title only: the sheet needs a cached definition; the SKU facts need none of its fields. */
const AMAZON_DEFINITION = { type: 'object', properties: { item_name: { type: 'array', minUniqueItems: 1, maxUniqueItems: 1,
  items: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } } }
vi.mock('../categories/seller-schema.service.js', async () => {
  const { amazonSpecFromDefinition } = await import('./channel-specs/amazon.js')
  return { amazonSellerSpec: async (_account: string, marketplace: string, productType: string) => amazonSpecFromDefinition({ marketplace, productType, fetchedAt: new Date(), schemaVersion: 'fixture', schemaDefinition: AMAZON_DEFINITION }) }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { getStudioSheet } from './studio-sheet.service.js'
import { readSheetSkuStores, sheetRowSku } from './studio-sheet-sku.js'
import { Prisma } from '@prisma/client'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

describe('sheetRowSku — the rule', () => {
  const HELD = { listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0HELD' }
  const DRAFT = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null }
  const base = { channel: 'AMAZON', marketplace: 'DE', productSku: 'GALE-M', alias: null, band: false }

  it('a listing with no own SKU shows the Shared SKU, no difference, editable (parity with Product.sku)', () => {
    expect(sheetRowSku({ ...base, listing: { channel: 'AMAZON', ...HELD } })).toEqual({
      wanted: 'GALE-M', source: 'product', live: 'GALE-M', liveConfirmed: false, differs: false, editable: true, reason: null })
    expect(sheetRowSku({ ...base, channel: 'EBAY', listing: { channel: 'EBAY', ...DRAFT } })).toMatchObject({
      wanted: 'GALE-M', source: 'product', live: null, differs: false, editable: true })
  })

  it('a listing with its own SKU shows it and differs; the confirmed live SKU is named as such', () => {
    expect(sheetRowSku({ ...base, listing: { channel: 'AMAZON', ...HELD, channelSku: 'GALE-M-DE', liveChannelSku: 'GALE-M-DE' } })).toEqual({
      wanted: 'GALE-M-DE', source: 'channel', live: 'GALE-M-DE', liveConfirmed: true, differs: true, editable: true, reason: null })
    // A draft: nothing on the channel yet.
    expect(sheetRowSku({ ...base, listing: { channel: 'AMAZON', ...DRAFT, channelSku: 'GALE-NEW' } })).toMatchObject({
      wanted: 'GALE-NEW', live: null, liveConfirmed: false, differs: true, editable: true })
  })

  it('an older store is read as Publish reads it (an Amazon flat-file SKU)', () => {
    expect(sheetRowSku({ ...base, listing: { channel: 'AMAZON', ...DRAFT, flatFileSnapshot: { item_sku: 'GALE-FLAT' } } })).toMatchObject({
      wanted: 'GALE-FLAT', source: 'flatFile', differs: true, editable: true })
  })

  it('no single SKU: no value, the resolver\'s sentence, still editable so the person can name the SKU', () => {
    const facts = sheetRowSku({ ...base, listing: { channel: 'AMAZON', ...HELD, offers: [{ sku: 'A-1', isActive: true }, { sku: 'A-2', isActive: true }] } })
    expect(facts).toMatchObject({ wanted: null, source: null, differs: true, editable: true, reason: null })
    expect(facts.conflict).toBe('GALE-M has multiple seller SKUs. Select its offer before publishing.')
  })

  it('no listing on the row: the Shared SKU, read-only, and why — the primary listing and an extra listing', () => {
    const primary = sheetRowSku({ ...base, listing: null })
    expect(primary).toMatchObject({ wanted: 'GALE-M', source: 'product', live: null, differs: false, editable: false })
    expect(primary.reason).toBe('There is no Amazon · DE listing on this row yet, so it has no SKU of its own here: it follows the Shared SKU GALE-M. Start its listing first (for example by setting its Status), then change its SKU here.')
    expect(sheetRowSku({ ...base, listing: null, alias: { id: 'al_1', label: 'Bundle' } }).reason)
      .toBe('There is no Amazon · DE (extra listing) listing for this product, so it has no SKU of its own here.')
  })

  it('F7 — an extra listing\'s own row (its band) shows its SKU and is editable like any listing row; its variations too', () => {
    const band = sheetRowSku({ ...base, channel: 'EBAY', productSku: 'GALE', band: true, alias: { id: 'al_1', label: 'Bundle' },
      listing: { channel: 'EBAY', ...HELD, productId: 'p_root', aliasKey: 'al_1', alias: { sku: 'GALE-BUNDLE', productId: 'p_root' } } })
    expect(band).toMatchObject({ wanted: 'GALE-BUNDLE', source: 'alias', differs: true, editable: true, reason: null })
    // The PRIMARY band (a standalone product's only row) is its listing: editable.
    expect(sheetRowSku({ ...base, band: true, listing: { channel: 'AMAZON', ...HELD } })).toMatchObject({ editable: true, reason: null })
    expect(sheetRowSku({ ...base, alias: { id: 'al_1', label: 'Bundle' }, listing: { channel: 'AMAZON', ...DRAFT, channelSku: 'GALE-M-B' } }))
      .toMatchObject({ wanted: 'GALE-M-B', editable: true })
  })
})

const ids = { parent: '', own: '', flat: '', none: '', twoOffers: '' }
let account = ''
let alias = ''

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'APJ6JRA9NG5V4' } as never })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'sku-facts-sheet', isActive: true, isPrimary: true, externalAccountId: 'FAKE-SELLER',
    authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR', schemaVersion: 'fixture', schemaDefinition: AMAZON_DEFINITION as never, expiresAt: new Date('2099-01-01') } })
  const child = async (sku: string, size: string) => (await prisma.product.create({ data: { sku, name: sku, basePrice: 40, parentId: ids.parent, productType: 'OUTERWEAR', variantAttributes: { size } } as never })).id
  ids.parent = (await prisma.product.create({ data: { sku: 'SF-JACKET', name: 'Jacket', basePrice: 40, isParent: true, productType: 'OUTERWEAR', variationAxes: ['size'] } as never })).id
  ids.own = await child('SF-JACKET-M', 'M')
  ids.flat = await child('SF-JACKET-L', 'L')
  ids.none = await child('SF-JACKET-XL', 'XL')
  ids.twoOffers = await child('SF-JACKET-S', 'S')
  const coord = { channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: account } as const
  const held = { listingStatus: 'ACTIVE', isPublished: true } as const
  const draft = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null } as const
  const parentListing = await prisma.channelListing.create({ data: { ...coord, ...held, productId: ids.parent, externalListingId: 'B0PARENT' } as never })
  await prisma.offer.create({ data: { channelListingId: parentListing.id, sku: 'SF-JACKET', isActive: true, fulfillmentMethod: 'FBM' } as never })
  await prisma.channelListing.create({ data: { ...coord, ...held, productId: ids.own, externalListingId: 'B0OWN', channelSku: 'SF-M-IT', liveChannelSku: 'SF-M-IT' } as never })
  // A big snapshot: only its SKU key is kept.
  await prisma.channelListing.create({ data: { ...coord, ...draft, productId: ids.flat, flatFileSnapshot: { item_sku: 'SF-L-FLAT', item_name: 'x'.repeat(2000) } } as never })
  const two = await prisma.channelListing.create({ data: { ...coord, ...held, productId: ids.twoOffers, externalListingId: 'B0TWO' } as never })
  await prisma.offer.create({ data: { channelListingId: two.id, sku: 'SF-S-FBA', isActive: true, fulfillmentMethod: 'FBA' } as never })
  await prisma.offer.create({ data: { channelListingId: two.id, sku: 'SF-S-FBM', isActive: true, fulfillmentMethod: 'FBM' } as never })
  // An extra listing of the family on the same coordinate: its own row and one variation's listing under it.
  alias = (await prisma.productListingAlias.create({ data: { productId: ids.parent, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: account, label: 'Bundle', position: 1, sku: 'SF-JACKET-BUNDLE' } as never })).id
  await prisma.channelListing.create({ data: { ...coord, ...draft, productId: ids.parent, aliasId: alias, aliasKey: alias, flatFileSnapshot: { item_sku: 'SF-JACKET-BUNDLE' } } as never })
  await prisma.channelListing.create({ data: { ...coord, ...draft, productId: ids.own, aliasId: alias, aliasKey: alias, channelSku: 'SF-M-BUNDLE' } as never })
}), 120_000)
afterAll(async () => { await state.db?.close() }, 30_000)

const channelSheet = () => scoped(() => getStudioSheet({ productId: ids.parent, scope: 'channel', channel: 'AMAZON', market: 'IT', locale: 'it', accountId: account } as never))
const rowOf = (sheet: { rows: unknown[] }, productId: string, aliasId: string | null = null) =>
  (sheet.rows as Array<{ id: string; aliasId: string | null; sku: string; skuFacts?: Record<string, unknown> }>).find(r => r.id === productId && r.aliasId === aliasId)!

describe('the sheet read — Amazon · IT', () => {
  it('every channel row carries its SKU facts; the row\'s own `sku` stays the Shared SKU', async () => {
    const sheet = await channelSheet()
    // The parent follows the Shared SKU (its one offer names it): no difference.
    expect(rowOf(sheet, ids.parent).skuFacts).toEqual({ wanted: 'SF-JACKET', source: 'offer', live: 'SF-JACKET', liveConfirmed: false, differs: false, editable: true, reason: null })
    expect(rowOf(sheet, ids.own)).toMatchObject({ sku: 'SF-JACKET-M',
      skuFacts: { wanted: 'SF-M-IT', source: 'channel', live: 'SF-M-IT', liveConfirmed: true, differs: true, editable: true, reason: null } })
    expect(rowOf(sheet, ids.flat).skuFacts).toMatchObject({ wanted: 'SF-L-FLAT', source: 'flatFile', live: null, differs: true, editable: true })
    expect(rowOf(sheet, ids.twoOffers).skuFacts).toMatchObject({ wanted: null, differs: true, editable: true,
      conflict: 'SF-JACKET-S has multiple seller SKUs. Select its offer before publishing.' })
    expect(rowOf(sheet, ids.none).skuFacts).toMatchObject({ wanted: 'SF-JACKET-XL', source: 'product', differs: false, editable: false })
    expect(String(rowOf(sheet, ids.none).skuFacts?.reason)).toContain('There is no Amazon · IT listing on this row yet')
  })

  it('F7 — the extra listing: its own row and its variation\'s listing are editable like any listing row', async () => {
    const sheet = await channelSheet()
    expect(rowOf(sheet, ids.parent, alias).skuFacts).toMatchObject({ wanted: 'SF-JACKET-BUNDLE', differs: true, editable: true, reason: null })
    expect(rowOf(sheet, ids.own, alias).skuFacts).toMatchObject({ wanted: 'SF-M-BUNDLE', source: 'channel', editable: true })
    // A variation with no listing under the extra listing: read-only, and why.
    expect(rowOf(sheet, ids.flat, alias).skuFacts).toMatchObject({ wanted: 'SF-JACKET-L', editable: false,
      reason: 'There is no Amazon · IT (extra listing) listing for this product, so it has no SKU of its own here.' })
  })

  it('the Shared scope carries no SKU facts: its first column is Product.sku', async () => {
    const sheet = await scoped(() => getStudioSheet({ productId: ids.parent, scope: 'master', market: 'IT', locale: 'it' } as never))
    expect(sheet.rows.length).toBeGreaterThan(0)
    for (const row of sheet.rows as Array<{ skuFacts?: unknown }>) expect(row.skuFacts).toBeUndefined()
  })

  it('the store read: only the flat-file SKU key of a snapshot (Amazon only), active offers oldest first', () => scoped(async () => {
    const listings = await prisma.channelListing.findMany({ where: { productId: { in: [ids.flat, ids.twoOffers] }, aliasKey: '' }, select: { id: true, productId: true } })
    const stores = await readSheetSkuStores(prisma as never, listings.map(l => l.id), 'AMAZON')
    const flat = stores.get(listings.find(l => l.productId === ids.flat)!.id)!
    expect(flat.flatFileSnapshot).toEqual({ item_sku: 'SF-L-FLAT' })
    expect(stores.get(listings.find(l => l.productId === ids.twoOffers)!.id)!.offers.map(o => o.sku)).toEqual(['SF-S-FBA', 'SF-S-FBM'])
    // Another channel never reads the flat-file snapshot.
    expect((await readSheetSkuStores(prisma as never, [listings[0].id], 'EBAY')).get(listings[0].id)!.flatFileSnapshot).toBeNull()
    expect(await readSheetSkuStores(prisma as never, [], 'AMAZON')).toEqual(new Map())
  }))

  it('💰 the Amazon read never selects the snapshot: only the SKU key\'s value, in one statement for every listing', async () => {
    const findMany = vi.fn(async () => [{ id: 'l1', channelSku: null, liveChannelSku: null, offers: [], alias: null }, { id: 'l2', channelSku: null, liveChannelSku: null, offers: [], alias: null }])
    const statements: Prisma.Sql[] = []
    const queryRaw = vi.fn(async (strings: TemplateStringsArray, ...args: unknown[]) => {
      statements.push(Prisma.sql(strings, ...args))
      return [{ id: 'l1', skus: ['SF-FLAT'] }]
    })
    const stores = await readSheetSkuStores({ channelListing: { findMany }, $queryRaw: queryRaw } as never, ['l1', 'l2', 'l1'], 'AMAZON')
    const select = (findMany.mock.calls[0] as unknown as [{ select: Record<string, unknown> }])[0].select
    expect(select).not.toHaveProperty('flatFileSnapshot')
    expect(queryRaw).toHaveBeenCalledTimes(1)
    // The statement selects the JSON path's value, never the column itself; one statement for every listing id.
    const text = statements[0].text
    expect(text).toMatch(/SELECT id, ARRAY\["flatFileSnapshot" ->> \$1::text\]::text\[\] AS skus/)
    expect(text.replace(/"flatFileSnapshot" ->> \$\d+::text/g, '').replace(/"flatFileSnapshot" IS NOT NULL/, '')).not.toContain('flatFileSnapshot')
    expect(statements[0].values).toEqual(['item_sku', ['l1', 'l2']])
    expect(stores.get('l1')!.flatFileSnapshot).toEqual({ item_sku: 'SF-FLAT' })
    expect(stores.get('l2')!.flatFileSnapshot).toBeNull()
    // Off Amazon: no statement at all.
    queryRaw.mockClear()
    await readSheetSkuStores({ channelListing: { findMany }, $queryRaw: queryRaw } as never, ['l1'], 'EBAY')
    expect(queryRaw).not.toHaveBeenCalled()
  })
})
