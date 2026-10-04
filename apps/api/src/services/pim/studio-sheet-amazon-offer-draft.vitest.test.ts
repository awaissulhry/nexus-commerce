/**
 * Amazon sheet gaps (D4=B) — the product sheet end to end for an Amazon offer column: a price typed on a LIVE listing is
 * saved as an offer draft (the bulk writer routes it through `amazon-offer-writes.ts`, never the generic write), the sheet
 * then shows 44.90 with the live 49.90 beside it, the live price columns are untouched and nothing is queued for Amazon;
 * a still-draft (never published) listing's edit goes to the price door instead; a reset (the sheet's Discard) and the
 * draft door's discard return the cell to live. On an in-process PostgreSQL (PGlite) with the production row policies,
 * the harness of `amazon-variation-parent-type.vitest.test.ts`; ids invented.
 * Run: npx vitest run src/services/pim/studio-sheet-amazon-offer-draft.vitest.test.ts (and with NEXUS_WORKSPACES_ENABLED=1).
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
import { readAmazonOfferDraft } from '../amazon/offer-draft.js'
import { applyProductBulkEdits, ProductBulkError } from '../products/bulk-edit.service.js'
import { discardAmazonOfferDrafts } from './amazon-offer-draft.service.js'
import { OFFER_VERSION_REQUIRED } from './amazon-offer-writes.js'
import { PRICE_PERMISSION_REASON } from './matrix-cells.js'
import { OFFER_DRAFT_WORDS } from './amazon-offer-cells.js'
import { resetSaleWindowColumnCache } from './sale-window.js'
import { getStudioSheet } from './studio-sheet.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const PRICE = 'purchasable_offer__our_price'
const ids = { parent: '', live: '', draft: '' }
const listings = { live: '', draft: '' }
let account = ''

beforeAll(() => scoped(async () => {
  // The sale window lives in two raw columns the Prisma schema does not declare (`sale-window.ts`).
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  resetSaleWindowColumnCache()
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'APJ6JRA9NG5V4' } as never })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'offer-draft-sheet', isActive: true, isPrimary: true, externalAccountId: 'FAKE-SELLER',
    authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR', schemaVersion: 'fixture', schemaDefinition: AMAZON_DEFINITION as never, expiresAt: new Date('2099-01-01') } })
  ids.parent = (await prisma.product.create({ data: { sku: 'OD-JACKET', name: 'Jacket', basePrice: 40, isParent: true, productType: 'OUTERWEAR', variationAxes: ['size'] } as never })).id
  ids.live = (await prisma.product.create({ data: { sku: 'OD-JACKET-M', name: 'Jacket M', basePrice: 40, parentId: ids.parent, productType: 'OUTERWEAR', variantAttributes: { size: 'M' } } as never })).id
  ids.draft = (await prisma.product.create({ data: { sku: 'OD-JACKET-L', name: 'Jacket L', basePrice: 40, parentId: ids.parent, productType: 'OUTERWEAR', variantAttributes: { size: 'L' } } as never })).id
  const base = { channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: account } as const
  const priced = { price: 49.9, priceOverride: 49.9, followMasterPrice: false, quantity: 7, fulfillmentMethod: 'FBM',
    platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 7 }] } } } as const
  await prisma.channelListing.create({ data: { ...base, productId: ids.parent, listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0PARENT' } as never })
  listings.live = (await prisma.channelListing.create({ data: { ...base, ...priced, productId: ids.live, listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0LIVE' } as never })).id
  listings.draft = (await prisma.channelListing.create({ data: { ...base, ...priced, productId: ids.draft, listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: true } as never })).id
}), 120_000)
afterAll(async () => { await state.db?.close() }, 30_000)

const CONTEXTS = [{ channel: 'AMAZON', marketplace: 'IT', locale: 'it', aliasKey: '' }]
async function sheetEdit(productId: string, listingId: string, value: unknown, extra: Record<string, unknown> = {},
  opts: { field?: string; can?: (permission: string) => boolean; noVersion?: boolean } = {}) {
  const { version } = await prisma.channelListing.findUniqueOrThrow({ where: { id: listingId }, select: { version: true } })
  try {
    return await applyProductBulkEdits({ changes: [{ id: productId, field: `attr_${opts.field ?? PRICE}`, value, target: 'channel', intent: 'set', ...extra }] as never,
      expectedVersion: opts.noVersion ? undefined : version, marketplaceContexts: CONTEXTS } as never,
    { formulaCascade: false, contentPerRow: true, userId: 'sheet@test', can: opts.can, logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } as never)
  } catch (error) {
    return error instanceof ProductBulkError ? { status: error.statusCode, ...error.details } : Promise.reject(error)
  }
}
async function priceCell(productId: string) {
  const sheet = await getStudioSheet({ productId: ids.parent, scope: 'channel', channel: 'AMAZON', market: 'IT', locale: 'it', accountId: account } as never)
  const row = (sheet.rows as any[]).find((r) => r.id === productId)
  return row.values[PRICE]
}
const queued = (productId: string) => prisma.outboundSyncQueue.count({ where: { productId } })

describe('the product sheet — an Amazon offer price', () => {
  it('a LIVE listing: saved for Publish — the sheet shows 44.90 beside the live 49.90, nothing queued, live columns untouched', () => scoped(async () => {
    const before = await prisma.channelListing.findUniqueOrThrow({ where: { id: listings.live } })
    // The column is a list (Amazon's price schedule): the sheet sends its one value as a list.
    const saved = await sheetEdit(ids.live, listings.live, 44.9)
    expect(saved, JSON.stringify(saved)).toMatchObject({ success: true })

    const after = await prisma.channelListing.findUniqueOrThrow({ where: { id: listings.live } })
    expect(after.version).toBe(before.version + 1)
    expect(Number(after.price)).toBe(49.9)
    expect(Number(after.priceOverride)).toBe(49.9)
    expect(readAmazonOfferDraft(after.platformAttributes)?.leaves.our_price).toMatchObject({ value: { pin: 44.9 }, base: { pin: 49.9 }, savedBy: 'sheet@test' })
    // The generic writer never wrote the column into the listing's bags.
    expect((after.overrideData as Record<string, unknown> | null)?.[PRICE]).toBeUndefined()
    expect(await queued(ids.live)).toBe(0)

    const cell = await priceCell(ids.live)
    expect(cell.value).toEqual(44.9)
    // Already pinned at 49.90: a new number, not "pins at".
    expect(cell.pendingPublish).toMatchObject({ value: 44.9, live: 49.9, savedBy: 'sheet@test', note: OFFER_DRAFT_WORDS.saved, sent: true })
    expect(typeof cell.pendingPublish.savedAt).toBe('string')
    expect(cell.priceCell).toMatchObject({ value: 49.9, source: 'override', currency: 'EUR' })
    expect(cell).toMatchObject({ editable: true, writable: true })
  }))

  it('a still-draft listing: the edit goes to the price door — the listing is pinned at it, no draft is saved', () => scoped(async () => {
    const saved = await sheetEdit(ids.draft, listings.draft, 44.9)
    expect(saved, JSON.stringify(saved)).toMatchObject({ success: true })
    const after = await prisma.channelListing.findUniqueOrThrow({ where: { id: listings.draft } })
    expect(Number(after.priceOverride ?? after.price)).toBe(44.9)
    expect(after.followMasterPrice).toBe(false)
    expect(readAmazonOfferDraft(after.platformAttributes)).toBeNull()
    const cell = await priceCell(ids.draft)
    expect(cell.value).toEqual(44.9)
    expect(cell.pendingPublish).toBeUndefined()
  }))

  it('the parent row is held with the Matrix\'s sentence', () => scoped(async () => {
    expect(await priceCell(ids.parent)).toMatchObject({ editable: false, writable: false, writeBlockedReason: 'The parent is not buyable — set prices on the variants' })
  }))

  it('a reset on the sheet discards the saved change: the cell is back to live', () => scoped(async () => {
    expect((await priceCell(ids.live)).pendingPublish).toBeDefined()
    const reset = await sheetEdit(ids.live, listings.live, null, { intent: 'reset', reset: true })
    expect(reset, JSON.stringify(reset)).toMatchObject({ success: true })
    const after = await prisma.channelListing.findUniqueOrThrow({ where: { id: listings.live } })
    expect(readAmazonOfferDraft(after.platformAttributes)).toBeNull()
    expect(Number(after.priceOverride)).toBe(49.9)
    const cell = await priceCell(ids.live)
    expect(cell.value).toEqual(49.9)
    expect(cell.pendingPublish).toBeUndefined()
    expect(await queued(ids.live)).toBe(0)
  }))

  it('refused by name, nothing saved: no products.price.edit; no listing version; a Remote Fulfilment code typed in', () => scoped(async () => {
    const before = await prisma.channelListing.findUniqueOrThrow({ where: { id: listings.live } })
    expect(await sheetEdit(ids.live, listings.live, 44.9, {}, { can: (p) => p !== 'products.price.edit' }))
      .toMatchObject({ status: 400, error: PRICE_PERMISSION_REASON })
    expect(JSON.stringify(await sheetEdit(ids.live, listings.live, 44.9, {}, { noVersion: true }))).toContain(OFFER_VERSION_REQUIRED)
    const remote = await sheetEdit(ids.live, listings.live, 'AMAZON_EU_RAFN', {}, { field: 'fulfillment_availability__fulfillment_channel_code' })
    expect(remote).toMatchObject({ status: 400, error: expect.stringMatching(/^Only FBA \(AMAZON_EU\) or FBM \(DEFAULT\) can be set here, not AMAZON_EU_RAFN\. Remote Fulfilment \(EU stock → UK\) is switched on in Seller Central/) })
    const after = await prisma.channelListing.findUniqueOrThrow({ where: { id: listings.live } })
    expect(after.version).toBe(before.version)
    expect(after.platformAttributes).toEqual(before.platformAttributes)
    expect(await queued(ids.live)).toBe(0)
  }))

  it('the draft door\'s discard returns the cell to live too', () => scoped(async () => {
    expect(await sheetEdit(ids.live, listings.live, 45.5)).toMatchObject({ success: true })
    expect((await priceCell(ids.live)).value).toEqual(45.5)
    const { discarded } = await discardAmazonOfferDrafts({ listingIds: [listings.live], actor: 'sheet@test' })
    expect(discarded).toEqual([expect.objectContaining({ listingId: listings.live, leaves: ['our_price'] })])
    const cell = await priceCell(ids.live)
    expect(cell.value).toEqual(49.9)
    expect(cell.pendingPublish).toBeUndefined()
    expect(await queued(ids.live)).toBe(0)
  }))
})
