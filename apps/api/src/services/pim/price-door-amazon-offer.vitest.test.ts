/**
 * Amazon sheet gaps — Amazon's own offer settings through the ONE price door (`writeChannelPrices` `offer`): the minimum
 * and maximum seller price, the MAP price, the offer window and the Automate Pricing rule, kept at EXACTLY
 * `amazonOfferLivePath(leaf)` (`platformAttributes.amazonOffer.*`) inside the door's compare-and-set, with an audit row per
 * leaf and ONE PRICE_UPDATE (held while paused). The price sent is checked against the bounds after the change. Real
 * PostgreSQL in-process (PGlite), the pattern of `price-door-sale-removal.vitest.test.ts`.
 */
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, published: [] as any[] }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: vi.fn() } }))
// The live-sync hint goes out through the real `announceListingValues`; only its last hop is recorded here.
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: vi.fn((event: unknown) => { state.published.push(event) }) }))

import prisma from '../../db.js'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import { activeDatabaseTransaction, inDatabaseTransaction } from '../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { writeChannelPrices, type AmazonOfferWrite } from './channel-price-write.service.js'
import { resetSaleWindowColumnCache } from './sale-window.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const accounts: Record<string, string> = {}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)) }
beforeAll(async () => {
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  resetSaleWindowColumnCache()
  await scoped(async () => {
    for (const channel of ['AMAZON', 'EBAY']) {
      await prisma.marketplace.create({ data: { channel, code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
      accounts[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `offer-door-${channel}`, isActive: true } })).id
    }
  })
})
// Every earlier write's hint lands first (a hint goes out after the tick that wrote it).
beforeEach(async () => { await settle(); state.published.length = 0 })

/** A live listing on IT pinned at 49.90 (a price of its own). */
async function seed(id: string, over: Record<string, unknown> = {}, channel: 'AMAZON' | 'EBAY' = 'AMAZON') {
  await prisma.product.create({ data: { id, sku: id, name: id, basePrice: 45 } })
  return prisma.channelListing.create({ data: {
    productId: id, channel, channelConnectionId: accounts[channel], channelMarket: `${channel}_IT`, marketplace: 'IT', region: 'EU',
    price: 49.9, priceOverride: 49.9, followMasterPrice: false, listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ASIN-${id}`,
    syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS', ...over,
  } })
}
const fresh = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
const write = async (listingId: string, change: { offer?: AmazonOfferWrite; price?: number | null; sale?: { value: number | null; start: string | null; end: string | null } }, version?: number) =>
  (await writeChannelPrices({ targets: [{ listingId, ...change, expectedVersion: version ?? (await fresh(listingId)).version }], actor: 'sheet@test', source: 'MANUAL_OVERRIDE' })).results[0]
const rows = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId }, orderBy: { createdAt: 'asc' } })
const FULL: AmazonOfferWrite = {
  minimum_seller_allowed_price: 30, maximum_seller_allowed_price: 60, map_price: 40,
  offer_start_at: '2026-01-01', offer_end_at: '2027-12-31', automated_pricing_rule_id: ' R1 ',
}

it('writes EXACTLY amazonOffer.* with an audit row per leaf, removes the old sheet values, and queues ONE PRICE_UPDATE', () => scoped(async () => {
  const listing = await seed('offer-applied', {
    platformAttributes: { vendor: 'ACME', amazonFulfillment: { lead_time_to_ship_max_days: 2 } },
    overrideData: { purchasable_offer__minimum_seller_allowed_price: 12, purchasable_offer__map_price: 13, purchasable_offer__our_price: 41, item_name: 'kept' },
  })
  const result = await write(listing.id, { offer: FULL })
  expect(result).toMatchObject({ outcome: 'applied', guarded: true, version: listing.version + 1, sentPrice: 49.9 })
  const after = await fresh(listing.id)
  expect(after.platformAttributes).toEqual({
    vendor: 'ACME', amazonFulfillment: { lead_time_to_ship_max_days: 2 },
    amazonOffer: { minimum_seller_allowed_price: 30, maximum_seller_allowed_price: 60, map_price: 40, start_at: '2026-01-01', end_at: '2027-12-31', automated_pricing_rule_id: 'R1' },
  })
  // The written leaves' old sheet values go; the price's old value stays until the price itself is written.
  expect(after.overrideData).toEqual({ purchasable_offer__our_price: 41, item_name: 'kept' })
  expect(after).toMatchObject({ syncStatus: 'PENDING', followMasterPrice: false })
  expect(Number(after.price)).toBe(49.9)
  const audit = await prisma.channelListingOverride.findMany({ where: { channelListingId: listing.id }, orderBy: { fieldName: 'asc' } })
  expect(audit.map((a) => [a.fieldName, a.previousValue, a.newValue])).toEqual([
    ['amazonOffer.automated_pricing_rule_id', null, 'R1'], ['amazonOffer.end_at', null, '2027-12-31'], ['amazonOffer.map_price', null, '40'],
    ['amazonOffer.maximum_seller_allowed_price', null, '60'], ['amazonOffer.minimum_seller_allowed_price', null, '30'], ['amazonOffer.start_at', null, '2026-01-01'],
  ])
  expect(audit[0].reason).toContain('minimum price — → EUR 30.00')
  const queued = await rows(listing.id)
  expect(queued).toHaveLength(1)
  expect(queued[0]).toMatchObject({ id: result.queueId, syncType: 'PRICE_UPDATE', syncStatus: 'PENDING', payload: { source: 'CHANNEL_PRICE_WRITE', price: 49.9 } })
  // The same settings again change nothing.
  expect(await write(listing.id, { offer: { ...FULL, automated_pricing_rule_id: 'R1' } })).toMatchObject({ outcome: 'noop', version: after.version })
}))

it('null removes a setting on Amazon: kept as an explicit null in Nexus\'s store, audited with the value it replaced', () => scoped(async () => {
  const listing = await seed('offer-null', { platformAttributes: { amazonOffer: { map_price: 40, automated_pricing_rule_id: 'R1' } } })
  expect(await write(listing.id, { offer: { map_price: null } })).toMatchObject({ outcome: 'applied' })
  expect((await fresh(listing.id)).platformAttributes).toEqual({ amazonOffer: { map_price: null, automated_pricing_rule_id: 'R1' } })
  expect(await prisma.channelListingOverride.findFirstOrThrow({ where: { channelListingId: listing.id } })).toMatchObject({ fieldName: 'amazonOffer.map_price', previousValue: '40', newValue: null })
  // Removing what neither Nexus nor Amazon holds is nothing.
  expect(await write(listing.id, { offer: { minimum_seller_allowed_price: null } })).toMatchObject({ outcome: 'noop' })
}))

it('a stale version is a conflict (MATRIX_COPY.changedElsewhere) and writes nothing', () => scoped(async () => {
  const listing = await seed('offer-cas')
  expect(await write(listing.id, { offer: { map_price: 40 } }, listing.version + 3)).toMatchObject({ outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: listing.version })
  expect((await fresh(listing.id)).platformAttributes).toBeNull()
  expect(await rows(listing.id)).toHaveLength(0)
}))

it('min above max is refused — against the stored bounds too', () => scoped(async () => {
  const listing = await seed('offer-min-max', { platformAttributes: { amazonOffer: { maximum_seller_allowed_price: 60 } } })
  expect(await write(listing.id, { offer: { minimum_seller_allowed_price: 70, maximum_seller_allowed_price: 65 } })).toMatchObject({
    outcome: 'refused', reason: 'offer-min-max on AMAZON IT: The minimum price on Amazon (70.00) is above its maximum (65.00). Fix the two before a price is sent. Nothing was changed.' })
  expect(await write(listing.id, { offer: { minimum_seller_allowed_price: 61 } })).toMatchObject({
    outcome: 'refused', reason: 'offer-min-max on AMAZON IT: The minimum price on Amazon (61.00) is above its maximum (60.00). Fix the two before a price is sent. Nothing was changed.' })
  expect((await fresh(listing.id)).platformAttributes).toEqual({ amazonOffer: { maximum_seller_allowed_price: 60 } })
}))

it('the price sent must sit inside [min, max] after the change — Amazon\'s reported bounds count too', () => scoped(async () => {
  const listing = await seed('offer-inside', { platformAttributes: { attributes: { purchasable_offer: [{ marketplace_id: 'APJ6JRA9NG5V4', currency: 'EUR', minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 20 }] }] }] } } })
  expect(await write(listing.id, { offer: { maximum_seller_allowed_price: 40 } })).toMatchObject({ outcome: 'refused',
    reason: 'offer-inside on AMAZON IT: 49.90 is above the maximum price on Amazon (40.00), so Amazon would refuse it. Change the price or the maximum price. Nothing was changed.' })
  expect(await write(listing.id, { price: 15 })).toMatchObject({ outcome: 'refused',
    reason: 'offer-inside on AMAZON IT: 15.00 is below the minimum price on Amazon (20.00), so Amazon would refuse it. Change the price or the minimum price. Nothing was changed.' })
  // Price and bounds in ONE change: checked together, after it.
  expect(await write(listing.id, { price: 35, offer: { maximum_seller_allowed_price: 40 } })).toMatchObject({ outcome: 'applied' })
  expect(await write(listing.id, { sale: { value: 10, start: '2026-11-01', end: '2026-11-10' } })).toMatchObject({ outcome: 'refused',
    reason: 'offer-inside on AMAZON IT: The sale price 10.00 is below the minimum price on Amazon (20.00), so Amazon would refuse it. Change the price or the minimum price. Nothing was changed.' })
}))

it.each([
  ['a negative price', 'neg', { map_price: -1 }, 'A price is a number of zero or more'],
  ['a price that is not a number', 'nan', { map_price: '40' as never }, 'A price is a number of zero or more'],
  ['a date that is not one', 'date', { offer_start_at: '01/02/2026' }, 'Dates are YYYY-MM-DD'],
  ['an empty rule id', 'rule-empty', { automated_pricing_rule_id: '  ' }, 'An Automate Pricing rule is named by its rule id'],
  ['a rule id over 100 characters', 'rule-long', { automated_pricing_rule_id: 'R'.repeat(101) }, 'An Automate Pricing rule id is at most 100 characters'],
])('refuses %s, by name', (_label, tag, offer, why) => scoped(async () => {
  const listing = await seed(`offer-check-${tag}`)
  expect(await write(listing.id, { offer: offer as AmazonOfferWrite })).toMatchObject({ outcome: 'refused', reason: `${listing.productId} on AMAZON IT: ${why}. Nothing was changed.` })
}))

it('the offer ends on or after the day it starts — checked against the stored window too', () => scoped(async () => {
  const listing = await seed('offer-window', { platformAttributes: { amazonOffer: { start_at: '2026-06-01' } } })
  expect(await write(listing.id, { offer: { offer_end_at: '2026-05-31' } })).toMatchObject({ outcome: 'refused', reason: 'offer-window on AMAZON IT: the offer ends on or after the day it starts. Nothing was changed.' })
  expect(await write(listing.id, { offer: { offer_end_at: '2026-06-01' } })).toMatchObject({ outcome: 'applied' })
}))

it('price + sale + offer in one change are ONE PRICE_UPDATE; a later change in the grace window replaces it', () => scoped(async () => {
  const listing = await seed('offer-one-row')
  const first = await write(listing.id, { price: 52, sale: { value: 45, start: '2026-11-01', end: '2026-11-10' }, offer: { minimum_seller_allowed_price: 40, maximum_seller_allowed_price: 60 } })
  expect(first).toMatchObject({ outcome: 'applied', sentPrice: 52 })
  expect((await rows(listing.id)).map((r) => r.syncStatus)).toEqual(['PENDING'])
  const second = await write(listing.id, { offer: { map_price: 50 } })
  expect((await rows(listing.id)).map((r) => [r.id, r.syncStatus])).toEqual([[first.queueId, 'CANCELLED'], [second.queueId, 'PENDING']])
  expect((await rows(listing.id))[1].payload).toMatchObject({ price: 52, salePrice: 45, salePriceStart: '2026-11-01', salePriceEnd: '2026-11-10' })
}))

it('held while paused: saved in Nexus, nothing queued, ONE held row for the resume', () => scoped(async () => {
  const listing = await seed('offer-paused', { syncPaused: true })
  const result = await write(listing.id, { offer: { map_price: 40 } })
  expect(result).toMatchObject({ outcome: 'applied', queueId: null, notSent: 'The offer change is saved in Nexus. Nothing was sent: this listing\'s sync is paused. It is sent when the listing resumes.' })
  expect((await fresh(listing.id)).platformAttributes).toEqual({ amazonOffer: { map_price: 40 } })
  expect((await rows(listing.id)).map((r) => [r.syncType, r.syncStatus, r.errorCode])).toEqual([['PRICE_UPDATE', 'SKIPPED', 'PUSH_SYNC_PAUSED']])
}))

it('refused on eBay by name; nothing written', () => scoped(async () => {
  const listing = await seed('offer-ebay', {}, 'EBAY')
  expect(await write(listing.id, { offer: { map_price: 40 } })).toMatchObject({ outcome: 'refused', reason: 'Only an Amazon listing has a minimum, maximum or MAP price, an offer window or an Automate Pricing rule' })
  expect((await fresh(listing.id)).platformAttributes).toBeNull()
}))

it('the product sheet\'s old price and sale values (overrideData, never sent) go when the price door writes those', () => scoped(async () => {
  const listing = await seed('offer-old-keys', { overrideData: {
    purchasable_offer__our_price: 41, purchasable_offer__discounted_price__value_with_tax: 30, purchasable_offer__discounted_price__start_at: '2026-01-01', item_name: 'kept',
  } })
  expect(await write(listing.id, { price: 45 })).toMatchObject({ outcome: 'applied' })
  expect((await fresh(listing.id)).overrideData).toEqual({ purchasable_offer__discounted_price__value_with_tax: 30, purchasable_offer__discounted_price__start_at: '2026-01-01', item_name: 'kept' })
  expect(await write(listing.id, { sale: { value: 40, start: '2026-11-01', end: '2026-11-10' } })).toMatchObject({ outcome: 'applied' })
  expect((await fresh(listing.id)).overrideData).toEqual({ item_name: 'kept' })
  // A pinned listing whose only difference is that old key: writing the same price is a write (it clears the key).
  const other = await seed('offer-old-key-only', { overrideData: { purchasable_offer__our_price: 41 } })
  expect(await write(other.id, { price: 49.9 })).toMatchObject({ outcome: 'applied' })
  expect((await fresh(other.id)).overrideData).toEqual({})
}))

it('announces listing.values_changed after COMMIT, with the fields that changed and the committed version', () => scoped(async () => {
  const listing = await seed('offer-announce')
  const result = await write(listing.id, { price: 50, offer: { map_price: 40 } })
  await settle()
  expect(state.published).toEqual([expect.objectContaining({
    type: 'listing.values_changed', productId: listing.productId, fields: ['price', 'offer'], reason: 'price',
    listings: [{ listingId: listing.id, productId: listing.productId, version: result.version }],
  })])
}))

it('inside a caller\'s transaction: nothing is announced (or written) when it rolls back; after its commit, one event', () => scoped(async () => {
  const listing = await seed('offer-announce-tx')
  await expect(inDatabaseTransaction(prisma as never, async () => {
    const r = await writeChannelPrices({ targets: [{ listingId: listing.id, offer: { map_price: 40 }, expectedVersion: listing.version }], actor: 'sheet@test', source: 'MANUAL_OVERRIDE', tx: activeDatabaseTransaction() as never })
    expect(r.results[0].outcome).toBe('applied')
    throw new Error('the caller rolls back')
  })).rejects.toThrow('the caller rolls back')
  await settle()
  expect(state.published).toEqual([])
  expect((await fresh(listing.id)).platformAttributes).toBeNull()
  await inDatabaseTransaction(prisma as never, async () => {
    await writeChannelPrices({ targets: [{ listingId: listing.id, offer: { map_price: 40 }, expectedVersion: listing.version }], actor: 'sheet@test', source: 'MANUAL_OVERRIDE', tx: activeDatabaseTransaction() as never })
    await settle()
    expect(state.published).toEqual([])
  })
  await settle()
  expect(state.published).toEqual([expect.objectContaining({ fields: ['offer'], listings: [expect.objectContaining({ listingId: listing.id, version: listing.version + 1 })] })])
}))
