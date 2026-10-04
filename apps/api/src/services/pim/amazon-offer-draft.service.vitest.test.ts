/**
 * Amazon sheet gaps (D4=B) — the offer DRAFT door of a live Amazon listing (`saveAmazonOfferDrafts`): saved in Nexus, sent
 * only on Publish; compare-and-set; every refusal by name (nothing saved); a fulfilment leaf on every open EU row of the SKU;
 * a value equal to live removed; the old sheet key gone in the same write; the hint after COMMIT only; Discard; and
 * Publish's `clearPromotedDraftLeaves`, which keeps a newer saved value. Nothing is ever queued. Real PostgreSQL in-process
 * (PGlite), the pattern of `amazon-fulfilment-settings.vitest.test.ts`.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, published: [] as any[] }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: vi.fn((event: unknown) => { state.published.push(event) }) }))

import prisma from '../../db.js'
import { resetSaleWindowColumnCache } from './sale-window.js'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readAmazonOfferDraft } from '../amazon/offer-draft.js'
import { FBA_FULFILMENT_REASON, type AmazonOfferLeaf } from '../amazon/offer-fields.js'
import {
  NOT_LIVE_REASON, clearPromotedDraftLeaves, discardAmazonOfferDrafts, saveAmazonOfferDrafts,
} from './amazon-offer-draft.service.js'
import { PARENT_PRICE_REASON, PARENT_REASON, PRICE_PERMISSION_REASON } from './matrix-cells.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)) }
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const all = () => true
let account = ''
beforeAll(() => scoped(async () => {
  // The sale window lives in two raw columns the Prisma schema does not declare (`sale-window.ts`).
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  resetSaleWindowColumnCache()
  for (const code of ['IT', 'DE', 'FR', 'ES', 'UK']) {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: code, currency: code === 'UK' ? 'GBP' : 'EUR', region: code === 'UK' ? 'UK' : 'EU', language: 'it', languages: ['it'] } })
  }
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'offer-draft', isActive: true } })).id
}))
beforeEach(async () => { await settle(); state.published.length = 0 })

/** One SKU's LIVE Amazon listings, pinned at 49.90, merchant-fulfilled. */
async function seed(id: string, markets: string[] = ['IT'], over: (market: string) => Record<string, unknown> = () => ({}), product: Record<string, unknown> = {}) {
  await prisma.product.create({ data: { id, sku: id, name: id, basePrice: 40, ...product } })
  const out: Record<string, any> = {}
  for (const market of markets) {
    out[market] = await prisma.channelListing.create({ data: {
      productId: id, channel: 'AMAZON', channelConnectionId: account, channelMarket: `AMAZON_${market}`, marketplace: market, region: market === 'UK' ? 'UK' : 'EU',
      price: 49.9, followMasterPrice: false, priceOverride: 49.9, quantity: 7, quantityOverride: 7, followMasterQuantity: false, fulfillmentMethod: 'FBM',
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ASIN-${id}`, syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS',
      platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 7, lead_time_to_ship_max_days: 2 }] } },
      ...over(market),
    } })
  }
  return out
}
const fresh = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
const draftOf = async (id: string) => readAmazonOfferDraft((await fresh(id)).platformAttributes)
const queue = (productId: string) => prisma.outboundSyncQueue.findMany({ where: { productId } })
const save = (listing: { id: string; version: number }, leaf: AmazonOfferLeaf, value: unknown, permissions = all) =>
  saveAmazonOfferDrafts({ changes: [{ listingId: listing.id, leaf, value, expectedVersion: listing.version }], actor: 'sheet@test', permissions })

describe('saving a draft', () => {
  it('a price on a live listing is saved for Publish: the live columns, the queue and the jobs are untouched', () => scoped(async () => {
    const { IT } = await seed('od-price')
    const result = await save(IT, 'our_price', { pin: 44.9 })
    expect(result).toMatchObject({ outcome: 'applied', written: [{ listingId: IT.id, marketplace: 'IT', version: IT.version + 1 }], versions: { [IT.id]: IT.version + 1 } })
    const after = await fresh(IT.id)
    expect(Number(after.price)).toBe(49.9)
    expect(after.syncStatus).toBe('IN_SYNC')
    expect((await draftOf(IT.id))?.leaves.our_price).toMatchObject({ value: { pin: 44.9 }, base: { pin: 49.9 }, savedBy: 'sheet@test' })
    expect(await queue('od-price')).toEqual([])
    const audit = await prisma.channelListingOverride.findMany({ where: { channelListingId: IT.id } })
    expect(audit.map((a) => [a.fieldName, a.previousValue, a.newValue, a.changedBy])).toEqual([['amazonOfferDraft.our_price', null, '{"pin":44.9}', 'sheet@test']])
  }))

  it('a stale version is a conflict, in the Matrix\'s words; nothing is saved', () => scoped(async () => {
    const { IT } = await seed('od-cas')
    expect(await save({ id: IT.id, version: IT.version + 3 }, 'map_price', 30)).toEqual({
      outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, conflict: { listingId: IT.id, version: IT.version }, written: [], versions: {} })
    expect((await fresh(IT.id)).version).toBe(IT.version)
  }))

  it('a value equal to live removes the saved change; the same value with nothing saved changes nothing', () => scoped(async () => {
    const { IT } = await seed('od-equal')
    expect(await save(IT, 'our_price', { pin: 49.9 })).toMatchObject({ outcome: 'noop', written: [], versions: { [IT.id]: IT.version } })
    const saved = await save(IT, 'our_price', { pin: 44.9 })
    const back = await save({ id: IT.id, version: saved.versions[IT.id] }, 'our_price', { pin: 49.9 })
    expect(back).toMatchObject({ outcome: 'applied' })
    const after = await fresh(IT.id)
    expect(readAmazonOfferDraft(after.platformAttributes)).toBeNull()
    expect(after.platformAttributes).not.toHaveProperty('amazonOfferDraft')
  }))

  it('the field\'s old product-sheet key in overrideData goes in the same write', () => scoped(async () => {
    const { IT } = await seed('od-legacy', ['IT'], () => ({ overrideData: { purchasable_offer__map_price: 31, item_name: 'kept' } }))
    expect(await save(IT, 'map_price', 30)).toMatchObject({ outcome: 'applied' })
    expect((await fresh(IT.id)).overrideData).toEqual({ item_name: 'kept' })
  }))

  it('a fulfilment leaf lands on every open EU row of the SKU, each against its own live value', () => scoped(async () => {
    const rows = await seed('od-eu', ['IT', 'DE', 'FR', 'ES', 'UK'], (m) => ({
      ...(m === 'FR' ? { offerClosedAt: new Date() } : {}),
      ...(m === 'DE' ? { platformAttributes: { amazonFulfillment: { lead_time_to_ship_max_days: 5 } } } : {}),
    }))
    const result = await save(rows.IT, 'lead_time_to_ship_max_days', 3)
    expect(result.outcome).toBe('applied')
    expect(result.written.map((w) => w.marketplace)).toEqual(['IT', 'DE', 'ES'])
    expect((await draftOf(rows.IT.id))?.leaves.lead_time_to_ship_max_days).toMatchObject({ value: 3, base: 2 })
    expect((await draftOf(rows.DE.id))?.leaves.lead_time_to_ship_max_days).toMatchObject({ value: 3, base: 5 })
    expect((await draftOf(rows.ES.id))?.leaves.lead_time_to_ship_max_days).toMatchObject({ value: 3, base: 2 })
    for (const untouched of [rows.FR, rows.UK]) expect((await fresh(untouched.id)).version).toBe(untouched.version)
    // The live store is untouched: the stock job keeps sending 2.
    expect((await fresh(rows.IT.id)).platformAttributes).not.toHaveProperty('amazonFulfillment')
    expect(await queue('od-eu')).toEqual([])
  }))

  it('one change on each of two leaves of one listing: one write, one version', () => scoped(async () => {
    const { IT } = await seed('od-two')
    const result = await saveAmazonOfferDrafts({ changes: [
      { listingId: IT.id, leaf: 'map_price', value: 30, expectedVersion: IT.version },
      { listingId: IT.id, leaf: 'sale', value: { price: 39.9, start: day(5), end: day(15) }, expectedVersion: IT.version },
    ], actor: 'sheet@test', permissions: all })
    expect(result).toMatchObject({ outcome: 'applied', versions: { [IT.id]: IT.version + 1 } })
    expect(Object.keys((await draftOf(IT.id))!.leaves).sort()).toEqual(['map_price', 'sale'])
  }))
})

describe('refusals save nothing', () => {
  it.each([
    ['a parent price', 'parent', 'our_price', { pin: 44.9 }, {}, { isParent: true }, PARENT_PRICE_REASON],
    ['a parent handling time', 'parent-lead', 'lead_time_to_ship_max_days', 3, {}, { isParent: true }, PARENT_REASON],
    ['a price of 0', 'zero', 'our_price', { pin: 0 }, {}, {}, 'od-ref-zero on AMAZON IT was not pinned: the new price would be 0.00, and a price must be above 0. Nothing was changed.'],
    ['a price under the product floor', 'floor', 'our_price', { pin: 30 }, {}, { minPrice: 35 },
      'od-ref-floor on AMAZON IT cannot be pinned at 30.00: 30.00 is below its pricing floor of 35.00. Change the price, or the floor or ceiling on the product. Nothing was changed.'],
    ['a price under Amazon\'s minimum', 'amz-min', 'our_price', { pin: 35 }, { platformAttributes: { amazonOffer: { minimum_seller_allowed_price: 40, maximum_seller_allowed_price: 60 } } }, {},
      'od-ref-amz-min on AMAZON IT: 35.00 is below the minimum price on Amazon (40.00), so Amazon would refuse it. Change the price or the minimum price. Nothing was changed.'],
    ['a minimum above the maximum', 'min-max', 'minimum_seller_allowed_price', 70, { platformAttributes: { amazonOffer: { maximum_seller_allowed_price: 60 } } }, {},
      'od-ref-min-max on AMAZON IT: The minimum price on Amazon (70.00) is above its maximum (60.00). Fix the two before a price is sent. Nothing was changed.'],
    ['a sale date without a sale price', 'sale-date', 'sale', { price: null, start: day(2), end: day(9) }, {}, {}, 'Set the sale price first — a sale date belongs to a sale price.'],
    ['a sale without its end date', 'sale-end', 'sale', { price: 39.9, start: day(2), end: null }, {}, {}, 'A sale needs a start and an end date — Amazon schedules a sale with both'],
    ['a handling time that is not whole', 'lead-half', 'lead_time_to_ship_max_days', 2.5, {}, {}, 'Handling time is a whole number of days, 0 to 120'],
    ['a handling time above 120', 'lead-high', 'lead_time_to_ship_max_days', 121, {}, {}, 'Handling time is a whole number of days, 0 to 120'],
    ['a restock date in the past', 'restock', 'restock_date', day(-1), {}, {}, 'A restock date is today or later — Amazon ignores a date that has passed'],
    ['a handling time on an FBA listing', 'fba', 'lead_time_to_ship_max_days', 3, { fulfillmentMethod: 'FBA' }, {}, FBA_FULFILMENT_REASON],
    ['always available on a Remote Fulfilment listing', 'rafn', 'is_inventory_available', true,
      { platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 2 }, { fulfillment_channel_code: 'AMAZON_EU_RAFN' }] } } }, {}, FBA_FULFILMENT_REASON],
    ['a never-published listing (the live doors take it)', 'still-draft', 'map_price', 30, { listingStatus: 'DRAFT', isPublished: false, externalListingId: null }, {}, NOT_LIVE_REASON],
  ])('%s', (_label, tag, leaf, value, listing, product, reason) => scoped(async () => {
    const { IT } = await seed(`od-ref-${tag}`, ['IT'], () => listing, product)
    expect(await save(IT, leaf as AmazonOfferLeaf, value)).toEqual({ outcome: 'refused', reason, written: [], versions: {} })
    expect((await fresh(IT.id)).version).toBe(IT.version)
  }))

  it('no products.price.edit: every leaf the price door writes is held; a handling time is not a price', () => scoped(async () => {
    const { IT } = await seed('od-perm')
    const noPrice = (p: string) => p !== 'products.price.edit'
    for (const [leaf, value] of [['our_price', { pin: 44.9 }], ['map_price', 30], ['sale', { price: 39.9, start: day(1), end: day(3) }]] as const) {
      expect(await save(IT, leaf, value, noPrice)).toMatchObject({ outcome: 'refused', reason: PRICE_PERMISSION_REASON })
    }
    expect(await save(IT, 'lead_time_to_ship_max_days', 4, noPrice)).toMatchObject({ outcome: 'applied' })
  }))
})

describe('the hint and the transaction', () => {
  it('announces `offerDraft` after COMMIT only; a rollback leaves nothing and announces nothing', () => scoped(async () => {
    const { IT } = await seed('od-tx')
    await expect(inDatabaseTransaction(prisma as never, async () => {
      expect(await save(IT, 'map_price', 30)).toMatchObject({ outcome: 'applied' })
      throw new Error('the caller rolls back')
    })).rejects.toThrow('the caller rolls back')
    await settle()
    expect((await fresh(IT.id)).version).toBe(IT.version)
    expect(state.published).toEqual([])

    await inDatabaseTransaction(prisma as never, async () => {
      await save(IT, 'map_price', 30)
      await settle()
      expect(state.published).toEqual([])
    })
    await settle()
    expect(state.published).toEqual([expect.objectContaining({ type: 'listing.values_changed', fields: ['offerDraft'], productId: 'od-tx' })])
  }))
})

describe('discard', () => {
  it('drops the named leaves — a fulfilment leaf from the whole EU group — and announces', () => scoped(async () => {
    const rows = await seed('od-discard', ['IT', 'DE'])
    await save(rows.IT, 'lead_time_to_ship_max_days', 3)
    const it1 = await fresh(rows.IT.id)
    await save(it1, 'map_price', 30)
    // Each save announces after its COMMIT (a database read away): wait for both, then count the discard's alone.
    await vi.waitFor(() => expect(state.published).toHaveLength(2)); state.published.length = 0
    const result = await discardAmazonOfferDrafts({ listingIds: [rows.IT.id], leaves: ['lead_time_to_ship_max_days'], actor: 'sheet@test' })
    expect(result.discarded.map((d) => [d.listingId, d.leaves])).toEqual([[rows.IT.id, ['lead_time_to_ship_max_days']], [rows.DE.id, ['lead_time_to_ship_max_days']]])
    expect(Object.keys((await draftOf(rows.IT.id))!.leaves)).toEqual(['map_price'])
    expect(await draftOf(rows.DE.id)).toBeNull()
    await vi.waitFor(() => expect(state.published).toHaveLength(1))
    await settle()
    expect(state.published).toHaveLength(1)
    // Everything else, then nothing left.
    expect((await discardAmazonOfferDrafts({ listingIds: [rows.IT.id], actor: 'sheet@test' })).discarded.map((d) => d.leaves)).toEqual([['map_price']])
    expect(await draftOf(rows.IT.id)).toBeNull()
  }))
})

describe('clearPromotedDraftLeaves (Publish, after Amazon accepted)', () => {
  it('removes a leaf that still holds the sent value; keeps a newer saved value', () => scoped(async () => {
    const rows = await seed('od-promote', ['IT', 'DE'])
    await saveAmazonOfferDrafts({ changes: [
      { listingId: rows.IT.id, leaf: 'our_price', value: { pin: 44.9 }, expectedVersion: rows.IT.version },
      { listingId: rows.IT.id, leaf: 'map_price', value: 30, expectedVersion: rows.IT.version },
      { listingId: rows.IT.id, leaf: 'lead_time_to_ship_max_days', value: 3, expectedVersion: rows.IT.version },
    ], actor: 'sheet@test', permissions: all })
    // Saved again after the send: newer.
    await save(await fresh(rows.IT.id), 'map_price', 31)
    const result = await clearPromotedDraftLeaves({ listingId: rows.IT.id, sent: { our_price: { pin: 44.9 }, map_price: 30, lead_time_to_ship_max_days: 3, restock_date: day(9) } })
    expect(result).toEqual({ removed: ['our_price', 'lead_time_to_ship_max_days'], kept: ['map_price'] })
    expect((await draftOf(rows.IT.id))?.leaves).toEqual({ map_price: expect.objectContaining({ value: 31 }) })
    // The EU group's copy of the promoted fulfilment leaf goes too.
    expect(await draftOf(rows.DE.id)).toBeNull()
    // A second run is a no-op.
    expect(await clearPromotedDraftLeaves({ listingId: rows.IT.id, sent: { our_price: { pin: 44.9 } } })).toEqual({ removed: [], kept: [] })
  }))
})
