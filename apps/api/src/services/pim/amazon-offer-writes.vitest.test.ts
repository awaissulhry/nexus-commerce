/**
 * Amazon sheet gaps (D4=B) — where a product sheet edit of an Amazon offer column goes (`writeAmazonOfferEdits`): a LIVE
 * listing's to its offer draft (never a queue row, never a live store), a still-draft's to the live doors (the price door,
 * the fulfilment door) exactly as the Matrix writes; one row's three sale columns are ONE write; a partial sale is refused
 * by name. Real PostgreSQL in-process (PGlite).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readAmazonOfferDraft } from '../amazon/offer-draft.js'
import { readSaleWindows, resetSaleWindowColumnCache } from './sale-window.js'
import { ONE_VALUE, SALE_DATE_WITHOUT_PRICE, mergeSaleEdit, writeAmazonOfferEdits, type AmazonOfferEdit } from './amazon-offer-writes.js'
import { PARENT_PRICE_REASON, PRICE_PERMISSION_REASON } from './matrix-cells.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)) }
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const all = () => true
let account = ''
beforeAll(() => scoped(async () => {
  // The sale window lives in two raw columns the Prisma schema does not declare (`sale-window.ts`).
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  resetSaleWindowColumnCache()
  for (const code of ['IT', 'DE']) await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: code, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'offer-writes', isActive: true } })).id
}))
beforeEach(settle)

const LIVE = { listingStatus: 'ACTIVE', isPublished: true }
const STILL_DRAFT = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: true }
async function seed(id: string, listing: Record<string, unknown> = LIVE, product: Record<string, unknown> = {}) {
  await prisma.product.create({ data: { id, sku: id, name: id, basePrice: 40, ...product } })
  return prisma.channelListing.create({ data: {
    productId: id, channel: 'AMAZON', channelConnectionId: account, channelMarket: 'AMAZON_IT', marketplace: 'IT', region: 'EU',
    price: 49.9, followMasterPrice: false, priceOverride: 49.9, quantity: 7, fulfillmentMethod: 'FBM', externalListingId: `ASIN-${id}`,
    platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 7 }] } },
    ...listing,
  } })
}
const fresh = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
const queue = (productId: string) => prisma.outboundSyncQueue.findMany({ where: { productId } })
const edit = (l: { id: string; version: number }, key: string, value: unknown, extra: Partial<AmazonOfferEdit> = {}): AmazonOfferEdit =>
  ({ listingId: l.id, key: `attr_${key}`, value, expectedVersion: l.version, ...extra })
const write = (edits: AmazonOfferEdit[], permissions = all) => writeAmazonOfferEdits({ edits, actor: 'sheet@test', permissions })

describe('mergeSaleEdit — the three sale columns are one sale', () => {
  const current = { price: 39.9, start: '2026-11-01', end: '2026-11-10' }
  it('merges the parts edited with the sale the row shows', () => {
    expect(mergeSaleEdit(current, { end: '2026-11-20' })).toEqual({ sale: { price: 39.9, start: '2026-11-01', end: '2026-11-20' } })
    expect(mergeSaleEdit(null, { value: 35, start: '2026-11-01', end: '2026-11-05' })).toEqual({ sale: { price: 35, start: '2026-11-01', end: '2026-11-05' } })
  })
  it('clearing the sale price removes the sale; a date without one is refused', () => {
    expect(mergeSaleEdit(current, { value: null })).toEqual({ sale: null })
    expect(mergeSaleEdit(null, { start: '2026-11-01' })).toEqual({ refusal: SALE_DATE_WITHOUT_PRICE })
  })
  it('a sale price without both dates is refused with the price door\'s own sentence', () => {
    expect(mergeSaleEdit(null, { value: 35 })).toEqual({ refusal: 'A sale needs a start and an end date — Amazon schedules a sale with both' })
    expect(mergeSaleEdit(null, { value: 35, start: '2026-11-10', end: '2026-11-01' })).toEqual({ refusal: 'A sale ends on or after the day it starts' })
  })
})

describe('a LIVE listing → its offer draft', () => {
  it('a price is saved for Publish: no queue row, the live price unchanged', () => scoped(async () => {
    const l = await seed('ow-live-price')
    const { results } = await write([edit(l, 'purchasable_offer__our_price', '44,90')])
    expect(results).toEqual([{ listingId: l.id, lane: 'draft', outcome: 'applied', version: l.version + 1 }])
    const after = await fresh(l.id)
    expect(Number(after.price)).toBe(49.9)
    expect(readAmazonOfferDraft(after.platformAttributes)?.leaves.our_price?.value).toEqual({ pin: 44.9 })
    await settle()
    expect(await queue('ow-live-price')).toEqual([])
  }))

  it('a price typed on a following listing pins it; reset on a pinned one follows the rule again', () => scoped(async () => {
    const follower = await seed('ow-follow', { ...LIVE, followMasterPrice: true, priceOverride: null })
    await write([edit(follower, 'purchasable_offer__our_price', 44.9)])
    expect(readAmazonOfferDraft((await fresh(follower.id)).platformAttributes)?.leaves.our_price?.value).toEqual({ pin: 44.9 })
    const pinned = await seed('ow-reset')
    await write([edit(pinned, 'purchasable_offer__our_price', null, { reset: true })])
    expect(readAmazonOfferDraft((await fresh(pinned.id)).platformAttributes)?.leaves.our_price?.value).toEqual({ follow: true })
  }))

  it('reset of a column with a saved change discards it', () => scoped(async () => {
    const l = await seed('ow-discard')
    await write([edit(l, 'purchasable_offer__map_price', 30)])
    const saved = await fresh(l.id)
    const { results } = await write([edit(saved, 'purchasable_offer__map_price', null, { reset: true })])
    expect(results[0]).toMatchObject({ outcome: 'applied', version: saved.version + 1 })
    expect(readAmazonOfferDraft((await fresh(l.id)).platformAttributes)).toBeNull()
  }))

  it('the three sale columns of one row are ONE saved sale; a partial sale is refused', () => scoped(async () => {
    const l = await seed('ow-live-sale')
    const { results } = await write([
      edit(l, 'purchasable_offer__discounted_price__value_with_tax', 39.9),
      edit(l, 'purchasable_offer__discounted_price__start_at', day(3)),
      edit(l, 'purchasable_offer__discounted_price__end_at', day(13)),
    ])
    expect(results).toEqual([{ listingId: l.id, lane: 'draft', outcome: 'applied', version: l.version + 1 }])
    expect(readAmazonOfferDraft((await fresh(l.id)).platformAttributes)?.leaves.sale?.value).toEqual({ price: 39.9, start: day(3), end: day(13) })
    // One column later: merged with the saved sale.
    const after = await fresh(l.id)
    await write([edit(after, 'purchasable_offer__discounted_price__end_at', day(20))])
    expect(readAmazonOfferDraft((await fresh(l.id)).platformAttributes)?.leaves.sale?.value).toEqual({ price: 39.9, start: day(3), end: day(20) })

    const other = await seed('ow-live-partial')
    expect((await write([edit(other, 'purchasable_offer__discounted_price__start_at', day(3))])).results[0]).toMatchObject({ outcome: 'refused', reason: SALE_DATE_WITHOUT_PRICE })
    expect((await write([edit(other, 'purchasable_offer__discounted_price__value_with_tax', 39.9)])).results[0])
      .toMatchObject({ outcome: 'refused', reason: 'A sale needs a start and an end date — Amazon schedules a sale with both' })
    expect((await fresh(other.id)).version).toBe(other.version)
  }))
})

describe('a still-draft listing → the live doors (as the Matrix)', () => {
  it('a price goes to the price door: the listing is pinned at it; nothing is saved as a draft', () => scoped(async () => {
    const l = await seed('ow-new-price', STILL_DRAFT)
    const { results } = await write([edit(l, 'purchasable_offer__our_price', 44.9)])
    expect(results[0]).toMatchObject({ listingId: l.id, lane: 'live', outcome: 'applied', version: l.version + 1 })
    const after = await fresh(l.id)
    expect([Number(after.price), Number(after.priceOverride), after.followMasterPrice]).toEqual([44.9, 44.9, false])
    expect(readAmazonOfferDraft(after.platformAttributes)).toBeNull()
    expect(await prisma.channelListingOverride.count({ where: { channelListingId: l.id, fieldName: 'price' } })).toBe(1)
  }))

  it('the three sale columns are ONE price-door write (one version, one audit row)', () => scoped(async () => {
    const l = await seed('ow-new-sale', STILL_DRAFT)
    const { results } = await write([
      edit(l, 'purchasable_offer__discounted_price__value_with_tax', 39.9),
      edit(l, 'purchasable_offer__discounted_price__start_at', day(3)),
      edit(l, 'purchasable_offer__discounted_price__end_at', day(13)),
    ])
    expect(results[0], results[0].reason).toMatchObject({ lane: 'live', outcome: 'applied', version: l.version + 1 })
    expect(Number((await fresh(l.id)).salePrice)).toBe(39.9)
    expect((await readSaleWindows(prisma as never, [l.id])).get(l.id)).toEqual({ start: day(3), end: day(13) })
    expect(await prisma.channelListingOverride.count({ where: { channelListingId: l.id, fieldName: 'salePrice' } })).toBe(1)
  }))

  it('offer settings ride the same price-door write; a handling time goes to the fulfilment door', () => scoped(async () => {
    const l = await seed('ow-new-offer', STILL_DRAFT)
    const { results } = await write([edit(l, 'purchasable_offer__map_price', 30), edit(l, 'fulfillment_availability__lead_time_to_ship_max_days', 3)])
    expect(results[0]).toMatchObject({ lane: 'live', outcome: 'applied', version: l.version + 2 })
    expect((await fresh(l.id)).platformAttributes).toMatchObject({ amazonOffer: { map_price: 30 }, amazonFulfillment: { lead_time_to_ship_max_days: 3 } })
  }))
})

describe('refusals', () => {
  it('a parent writes nothing; without products.price.edit a price leaf is held on both lanes', () => scoped(async () => {
    const parent = await seed('ow-parent', LIVE, { isParent: true })
    expect((await write([edit(parent, 'purchasable_offer__our_price', 44.9)])).results[0]).toMatchObject({ outcome: 'refused', reason: PARENT_PRICE_REASON })
    const noPrice = (p: string) => p !== 'products.price.edit'
    const draft = await seed('ow-perm-new', STILL_DRAFT)
    expect((await write([edit(draft, 'purchasable_offer__map_price', 30)], noPrice)).results[0]).toMatchObject({ outcome: 'refused', reason: PRICE_PERMISSION_REASON })
    const live = await seed('ow-perm-live')
    expect((await write([edit(live, 'purchasable_offer__our_price', 44.9)], noPrice)).results[0]).toMatchObject({ outcome: 'refused', reason: PRICE_PERMISSION_REASON })
    for (const l of [parent, draft, live]) expect((await fresh(l.id)).version).toBe(l.version)
  }))

  it('a list column (Amazon\'s schedule) sends its one value as a list; more than one is refused', () => scoped(async () => {
    const l = await seed('ow-list')
    expect((await write([edit(l, 'purchasable_offer__our_price', [44.9])])).results[0]).toMatchObject({ lane: 'draft', outcome: 'applied' })
    expect(readAmazonOfferDraft((await fresh(l.id)).platformAttributes)?.leaves.our_price?.value).toEqual({ pin: 44.9 })
    const saved = await fresh(l.id)
    expect((await write([edit(saved, 'purchasable_offer__map_price', [30, 31])])).results[0]).toMatchObject({ outcome: 'refused', reason: ONE_VALUE })
    // An emptied list follows the rule again (the price), or removes the value on Amazon (any other leaf).
    expect((await write([edit(saved, 'purchasable_offer__map_price', [])])).results[0]).toMatchObject({ outcome: 'noop' })
  }))

  it('a stale version is a conflict; a key that is not an offer column is refused', () => scoped(async () => {
    const l = await seed('ow-cas')
    expect((await write([edit({ id: l.id, version: l.version + 1 }, 'purchasable_offer__map_price', 30)])).results[0]).toMatchObject({ outcome: 'conflict', version: l.version })
    expect((await write([edit(l, 'fulfillment_availability__quantity', 5)])).results[0]).toMatchObject({ outcome: 'refused', reason: 'attr_fulfillment_availability__quantity is not an Amazon offer field' })
  }))
})
