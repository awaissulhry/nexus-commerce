/**
 * Product-sheet create path, step 3 (the Owner's D1 = A: the first channel-scope save on a market with no listing
 * starts a draft; D2 = A: that draft is inert through `syncPaused`; RESEARCH-2026-09-27.md §5).
 *
 * One save per store kind on a coordinate where the family has NO row: the save starts ONE draft set (parent and
 * variants, through `ensureDraftListings`) in its own transaction and lands the value on the edited product's draft.
 * Version 0 means "I saw no listing": against an existing row it is a 409 with that row's version. The response names
 * the drafts it started. A second save reuses the set. With no account the change is refused with the draft
 * creator's sentence. A shared-tier content write needs no listing and starts none.
 *
 * On an in-process PostgreSQL (PGlite) with the generated schema and the production row policies. Every id is invented.
 * Run: DATABASE_URL=postgresql://nexus@127.0.0.1:1/nexus_unit_test npx vitest run src/services/products/bulk-edit-new-market.vitest.test.ts
 * and again with NEXUS_WORKSPACES_ENABLED=1.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })
const state = vi.hoisted(() => ({ db: null as any, refreshMany: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => {
  state.refreshMany = vi.fn(async () => [])
  return { productReadCacheService: { refresh: vi.fn(), refreshMany: state.refreshMany, refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }
})
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
/** A controlled Amazon product type: a bag attribute (color), a platform path (brand), content (item_name), the fulfilment selector. */
const AMAZON_DEFINITION = vi.hoisted(() => {
  const attribute = () => ({ type: 'array', minUniqueItems: 1, maxUniqueItems: 1, items: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } })
  return { type: 'object', properties: { item_name: attribute(), brand: attribute(), color: attribute(),
    fulfillment_availability: { type: 'array', selectors: ['fulfillment_channel_code'], minUniqueItems: 1, maxUniqueItems: 1, items: { type: 'object', required: ['fulfillment_channel_code'],
      properties: { fulfillment_channel_code: { type: 'string', enum: ['AMAZON_EU', 'DEFAULT'] }, quantity: { type: 'integer', minimum: 0 } } } } } }
})
// The on-demand provider path answers from the same definition as the cached row (no network).
vi.mock('../categories/seller-schema.service.js', async () => {
  const { amazonSpecFromDefinition } = await import('../pim/channel-specs/amazon.js')
  return { amazonSellerSpec: async (_account: string, marketplace: string, productType: string) => amazonSpecFromDefinition({ marketplace, productType, fetchedAt: new Date(), schemaVersion: 'fixture', schemaDefinition: AMAZON_DEFINITION }) }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkEdits, ProductBulkError } from './bulk-edit.service.js'
import { AMAZON_FULFILMENT_KEY } from '../pim/channel-specs/amazon.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const context = { formulaCascade: false, contentPerRow: true, logger: { warn: vi.fn(), error: vi.fn() } }
const amazonSE = { channel: 'AMAZON' as const, marketplace: 'SE', locale: 'sv', aliasKey: '' }
const ebayDE = { channel: 'EBAY' as const, marketplace: 'DE', aliasKey: '' }

type Change = { id: string; field: string; value: unknown; target?: 'master' | 'channel'; intent?: 'set' | 'pin' | 'reset'; contentAddress?: unknown; contentAcknowledged?: boolean }
/** The sheet's save: one cell, the scope's context, the token it read (0 = "I saw no listing"). */
const save = (change: Change, ctx: typeof amazonSE | typeof ebayDE, expectedVersion?: number) => scoped(async () => {
  try {
    return await applyProductBulkEdits({ changes: [{ target: 'channel', intent: 'set', ...change }] as never, marketplaceContexts: [ctx],
      ...(expectedVersion !== undefined ? { expectedVersion } : {}) }, context) as any
  } catch (error) {
    if (error instanceof ProductBulkError) return { status: error.statusCode, ...error.details }
    throw error
  }
})
const listingsOf = (productIds: string[], channel = 'AMAZON') => scoped(() => prisma.channelListing.findMany({ where: { productId: { in: productIds }, channel: channel as never }, orderBy: { productId: 'asc' } }))

const ids: Record<string, string> = {}
const accounts: Record<string, string> = {}
async function family(key: string) {
  ids[key] = (await prisma.product.create({ data: { sku: `NM-${key}`, name: key, basePrice: 10, isParent: true, productType: 'OUTERWEAR' } as never })).id
  for (const variant of ['A', 'B']) ids[`${key}${variant}`] = (await prisma.product.create({ data: { sku: `NM-${key}-${variant}`, name: `${key} ${variant}`, basePrice: 10, parentId: ids[key], productType: 'OUTERWEAR' } as never })).id
}
const members = (key: string) => [ids[key], ids[`${key}A`], ids[`${key}B`]]

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'SE', name: 'Sweden', currency: 'SEK', region: 'EU', language: 'sv', languages: ['sv'], marketplaceId: 'FAKE-SE-ID' } as never })
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'Germany', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } as never })
  accounts.amazon = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'new-market', isActive: true, isPrimary: true, externalAccountId: 'FAKE-SELLER' } as never })).id
  accounts.ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'new-market', isActive: true, isPrimary: true, externalAccountId: 'FAKE-EBAY' } as never })).id
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'SE', productType: 'OUTERWEAR', schemaVersion: 'fixture', schemaDefinition: AMAZON_DEFINITION as never, expiresAt: new Date('2099-01-01') } })
  for (const key of ['bag', 'col', 'plat', 'price', 'ful', 'shared', 'pin', 'taken', 'again', 'none']) await family(key)
  // `taken`: variant A already has its own primary listing on Amazon SE (a sibling save created it first).
  await prisma.channelListing.create({ data: { productId: ids.takenA, channel: 'AMAZON', marketplace: 'SE', channelMarket: 'AMAZON_SE', region: 'SE',
    channelConnectionId: accounts.amazon, listingStatus: 'DRAFT', isPublished: false, syncPaused: true, version: 4 } })
}), 120_000)
afterAll(async () => { await state.db?.close() }, 30_000)
beforeEach(() => { state.refreshMany.mockClear() })

/** ONE draft set: the parent and both variants, inert, on the scope's primary account, the edited row moved once. */
async function expectDraftSet(key: string, edited: string, channel: 'AMAZON' | 'EBAY', market: string, account: string, result: any, editedVersion = 2) {
  const rows = await listingsOf(members(key), channel)
  expect(rows).toHaveLength(3)
  for (const row of rows) {
    expect(row).toMatchObject({ marketplace: market, channelConnectionId: account, aliasKey: '', listingStatus: 'DRAFT', isPublished: false, syncPaused: true, externalListingId: null })
  }
  const own = rows.find(row => row.productId === edited)!
  expect(own.version).toBe(editedVersion)
  // The response names every draft it started, with the version each holds now, and reads back the edited one.
  expect(result.createdListings).toEqual(expect.arrayContaining(rows.map(row => ({ productId: row.productId, listingId: row.id, version: row.version }))))
  expect(result.createdListings).toHaveLength(3)
  expect(result).toMatchObject({ currentVersion: editedVersion, versionOf: 'channelListing' })
  // The read cache is refreshed after commit for every product whose draft was started.
  expect(state.refreshMany.mock.calls.flat(2)).toEqual(expect.arrayContaining(members(key)))
  return own
}

describe('a save on a coordinate with no listing starts one draft set and lands the value', () => {
  it('override bag (Amazon color)', async () => {
    const result = await save({ id: ids.bagA, field: 'attr_color', value: 'Nero' }, amazonSE, 0)
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, updated: 1 })
    const own = await expectDraftSet('bag', ids.bagA, 'AMAZON', 'SE', accounts.amazon, result)
    expect((own.overrideData as Record<string, unknown>).color).toBe('Nero')
  })

  it('listing column (eBay quantity)', async () => {
    const result = await save({ id: ids.colA, field: 'ebay_quantity', value: 7 }, ebayDE, 0)
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, updated: 1 })
    const own = await expectDraftSet('col', ids.colA, 'EBAY', 'DE', accounts.ebay, result)
    expect(own).toMatchObject({ quantity: 7, followMasterQuantity: false })
  })

  it('platform path (Amazon brand)', async () => {
    const result = await save({ id: ids.platA, field: 'attr_brand', value: 'Fake Brand' }, amazonSE, 0)
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, updated: 1 })
    const own = await expectDraftSet('plat', ids.platA, 'AMAZON', 'SE', accounts.amazon, result)
    expect((own.platformAttributes as Record<string, unknown>).brand).toBe('Fake Brand')
  })

  it('price (the price door, guarded on the draft\'s fresh version)', async () => {
    const result = await save({ id: ids.priceA, field: 'ebay_price', value: 49.5 }, ebayDE, 0)
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, updated: 1 })
    const own = await expectDraftSet('price', ids.priceA, 'EBAY', 'DE', accounts.ebay, result)
    expect(Number(own.price)).toBe(49.5)
  })

  it('fulfilment (the fulfilment door, guarded on the draft\'s fresh version)', async () => {
    const result = await save({ id: ids.fulA, field: `attr_${AMAZON_FULFILMENT_KEY}`, value: 'DEFAULT' }, amazonSE, 0)
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, updated: 1 })
    const own = await expectDraftSet('ful', ids.fulA, 'AMAZON', 'SE', accounts.amazon, result)
    expect(own.fulfillmentMethod).toBe('FBM')
  })

  it('content pin (a Swedish title pinned on Amazon SE)', async () => {
    const result = await save({ id: ids.pinA, field: 'amazon_title', value: 'Svensk titel', contentAcknowledged: true,
      contentAddress: { tier: 'pin', language: 'sv', coordinate: { channel: 'AMAZON', market: 'SE' } } }, amazonSE, 0)
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, updated: 1 })
    const own = await expectDraftSet('pin', ids.pinA, 'AMAZON', 'SE', accounts.amazon, result)
    const pinned = await scoped(() => prisma.channelListingTranslation.findMany({ where: { channelListingId: own.id } }))
    expect(pinned).toEqual([expect.objectContaining({ language: 'sv', name: 'Svensk titel' })])
  })

  it('shared content from the channel scope needs no listing and starts none', async () => {
    const result = await save({ id: ids.sharedA, field: 'amazon_title', value: 'Delad titel', target: 'master', contentAcknowledged: true,
      contentAddress: { tier: 'language', language: 'sv' } }, amazonSE, 1)
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, updated: 1 })
    expect(result.createdListings).toBeUndefined()
    expect(await listingsOf(members('shared'))).toHaveLength(0)
    const translation = await scoped(() => prisma.productTranslation.findMany({ where: { productId: ids.sharedA } }))
    expect(translation).toEqual([expect.objectContaining({ language: 'sv', name: 'Delad titel' })])
  })
})

describe('version 0 means "I saw no listing"', () => {
  it('against a listing that exists: 409 with THAT listing\'s id and version, and nothing is started or written', async () => {
    const before = await listingsOf(members('taken'))
    const taken = before.find(row => row.productId === ids.takenA)!
    const result = await save({ id: ids.takenA, field: 'attr_color', value: 'Rosso' }, amazonSE, 0)
    // The id lets the sheet adopt the row at once, without a refresh.
    expect(result).toMatchObject({ status: 409, code: 'VERSION_CONFLICT', expectedVersion: 0, currentVersion: 4, listingId: taken.id, versionOf: 'channelListing' })
    expect(await listingsOf(members('taken'))).toEqual(before)
  })

  it('a pin against a listing that exists: the same 409', async () => {
    const [taken] = await listingsOf([ids.takenA])
    const result = await save({ id: ids.takenA, field: 'amazon_title', value: 'Svensk titel', contentAcknowledged: true,
      contentAddress: { tier: 'pin', language: 'sv', coordinate: { channel: 'AMAZON', market: 'SE' } } }, amazonSE, 0)
    expect(result).toMatchObject({ status: 409, code: 'VERSION_CONFLICT', expectedVersion: 0, currentVersion: 4, listingId: taken.id, versionOf: 'channelListing' })
  })

  it('a second save reuses the set: nothing new is started, and the returned version chains', async () => {
    const first = await save({ id: ids.againA, field: 'attr_color', value: 'Nero' }, amazonSE, 0)
    const set = await listingsOf(members('again'))
    expect(first.createdListings).toHaveLength(3)
    // The sibling's row was adopted from `createdListings` at version 1; its save sends that version.
    const sibling = await save({ id: ids.againB, field: 'attr_color', value: 'Rosso' }, amazonSE, set.find(row => row.productId === ids.againB)!.version)
    expect(sibling, JSON.stringify(sibling)).toMatchObject({ success: true, updated: 1, currentVersion: 2, versionOf: 'channelListing' })
    expect(sibling.createdListings).toBeUndefined()
    const second = await save({ id: ids.againA, field: 'attr_color', value: 'Blu' }, amazonSE, first.currentVersion)
    expect(second, JSON.stringify(second)).toMatchObject({ success: true, updated: 1, currentVersion: 3, versionOf: 'channelListing' })
    expect(second.createdListings).toBeUndefined()
    const after = await listingsOf(members('again'))
    expect(after.map(row => row.id)).toEqual(set.map(row => row.id))
    expect(after.find(row => row.productId === ids.againA)!.overrideData).toMatchObject({ color: 'Blu' })
    expect(after.find(row => row.productId === ids.againB)!.overrideData).toMatchObject({ color: 'Rosso' })
  })
})

describe('no account, no draft', () => {
  it('the change is refused with the draft creator\'s sentence, not a 500, and nothing is started', async () => {
    await scoped(() => prisma.channelConnection.update({ where: { id: accounts.amazon }, data: { isActive: false } }))
    try {
      for (const change of [{ id: ids.noneA, field: 'attr_color', value: 'Nero' }, { id: ids.noneA, field: 'amazon_title', value: 'Svensk titel', contentAcknowledged: true,
        contentAddress: { tier: 'pin', language: 'sv', coordinate: { channel: 'AMAZON', market: 'SE' } } }]) {
        const result = await save(change, amazonSE, 0)
        const errors = result.errors ?? []
        expect(errors, JSON.stringify(result)).toEqual([{ id: ids.noneA, field: change.field, error: 'Connect an Amazon account before listing on SE.' }])
      }
      expect(await listingsOf(members('none'))).toHaveLength(0)
    } finally {
      await scoped(() => prisma.channelConnection.update({ where: { id: accounts.amazon }, data: { isActive: true } }))
    }
  })
})
