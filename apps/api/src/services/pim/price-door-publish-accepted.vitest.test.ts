/**
 * Amazon sheet gaps — the price door's `publish-accepted` reason, for Publish's promotion: Amazon ACCEPTED the published
 * price / sale / offer settings, so Nexus records them as live with no bounds re-check (Amazon took them), cancels the
 * price rows waiting for the listing (a follower price queued meanwhile would overwrite the published one) and queues ONE
 * re-send of the live values. Real PostgreSQL in-process (PGlite), the pattern of `price-door-sale-removal.vitest.test.ts`.
 */
import { beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: vi.fn() } }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { createOutboundRow } from '../outbound-rows.js'
import { writeChannelPrices, type PriceWriteTarget } from './channel-price-write.service.js'
import { resetSaleWindowColumnCache } from './sale-window.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let account = ''
beforeAll(async () => {
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  resetSaleWindowColumnCache()
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'publish-accepted', isActive: true } })).id
  })
})

/** A live Amazon IT listing that follows the master (45.00) at 49.90; the product's floor 40, ceiling 50. */
async function seed(id: string, over: Record<string, unknown> = {}) {
  await prisma.product.create({ data: { id, sku: id, name: id, basePrice: 49.9, minPrice: 40, maxPrice: 50 } })
  return prisma.channelListing.create({ data: {
    productId: id, channel: 'AMAZON', channelConnectionId: account, channelMarket: 'AMAZON_IT', marketplace: 'IT', region: 'EU',
    price: 49.9, priceOverride: null, followMasterPrice: true, listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ASIN-${id}`,
    syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS', ...over,
  } })
}
const fresh = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
const rows = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId }, orderBy: { createdAt: 'asc' } })
const accepted = (target: Omit<PriceWriteTarget, 'unguardedReason' | 'expectedVersion' | 'expectedPrice'>) =>
  writeChannelPrices({ targets: [{ ...target, unguardedReason: 'publish-accepted' } as PriceWriteTarget], actor: 'publish', source: 'MANUAL_OVERRIDE', reason: 'Publish accepted' })
/** A follower price row the master cascade queued while Publish was processing. */
const followerRow = (l: { id: string; productId: string }) => createOutboundRow(prisma, { data: {
  productId: l.productId, channelListingId: l.id, targetChannel: 'AMAZON' as never, targetRegion: 'EU', syncStatus: 'PENDING' as never,
  syncType: 'PRICE_UPDATE', holdUntil: new Date(Date.now() + 30_000), maxRetries: 3,
  payload: { source: 'MASTER_PRICE_CHANGE', price: 47, marketplace: 'IT' },
}, select: { id: true } })

it('records what Amazon accepted with no bounds re-check — a guarded write of the same values is refused', () => scoped(async () => {
  const listing = await seed('accepted-bounds', { platformAttributes: { amazonOffer: { maximum_seller_allowed_price: 40 } } })
  // Above the product's ceiling (50) AND Amazon's stored maximum (40): the door refuses it from a person…
  const typed = await writeChannelPrices({ targets: [{ listingId: listing.id, price: 55, offer: { maximum_seller_allowed_price: 60 }, expectedVersion: listing.version }], actor: 'sheet', source: 'MANUAL_OVERRIDE' })
  expect(typed.results[0]).toMatchObject({ outcome: 'refused' })
  // …but Amazon took it on Publish: Nexus records it as live.
  const result = (await accepted({ listingId: listing.id, price: 55, offer: { maximum_seller_allowed_price: 60, map_price: 52 } })).results[0]
  expect(result).toMatchObject({ outcome: 'applied', guarded: false, sentPrice: 55 })
  const after = await fresh(listing.id)
  expect(after).toMatchObject({ followMasterPrice: false, version: listing.version + 1 })
  expect(Number(after.price)).toBe(55)
  expect(after.platformAttributes).toEqual({ amazonOffer: { maximum_seller_allowed_price: 60, map_price: 52 } })
  const reason = (await prisma.channelListingOverride.findFirstOrThrow({ where: { channelListingId: listing.id, fieldName: 'price' } })).reason
  expect(reason).toMatch(/^Publish accepted: .*accepted by Amazon \(Publish\)$/)
}))

it('cancels the price rows waiting for the listing and queues ONE re-send of the live values', () => scoped(async () => {
  const listing = await seed('accepted-cancels')
  const waiting = await followerRow(listing)
  const result = (await accepted({ listingId: listing.id, price: 44.9, offer: { minimum_seller_allowed_price: 35 } })).results[0]
  expect(result).toMatchObject({ outcome: 'applied', sentPrice: 44.9 })
  expect((await rows(listing.id)).map((r) => [r.id, r.syncStatus])).toEqual([[waiting.id, 'CANCELLED'], [result.queueId, 'PENDING']])
  expect((await rows(listing.id))[1].payload).toMatchObject({ source: 'CHANNEL_PRICE_WRITE', price: 44.9 })
}))

it('queues the one re-send even when Nexus already holds exactly the accepted values', () => scoped(async () => {
  const listing = await seed('accepted-same', { price: 44.9, priceOverride: 44.9, followMasterPrice: false, platformAttributes: { amazonOffer: { map_price: 40 } } })
  const waiting = await followerRow(listing)
  const result = (await accepted({ listingId: listing.id, price: 44.9, offer: { map_price: 40 } })).results[0]
  expect(result).toMatchObject({ outcome: 'applied', sentPrice: 44.9 })
  expect((await rows(listing.id)).map((r) => [r.id, r.syncStatus])).toEqual([[waiting.id, 'CANCELLED'], [result.queueId, 'PENDING']])
  // Nothing changed, so nothing new is on record.
  expect(await prisma.channelListingOverride.count({ where: { channelListingId: listing.id } })).toBe(0)
}))

it('a sale and a Follow hand-back Amazon accepted are recorded and re-sent the same way', () => scoped(async () => {
  const listing = await seed('accepted-follow', { price: 44.9, priceOverride: 44.9, followMasterPrice: false })
  const result = (await accepted({ listingId: listing.id, price: null, sale: { value: 39.9, start: '2026-11-01', end: '2026-11-10' } })).results[0]
  expect(result).toMatchObject({ outcome: 'applied' })
  const after = await fresh(listing.id)
  expect(after.followMasterPrice).toBe(true)
  expect(Number(after.salePrice)).toBe(39.9)
  expect((await rows(listing.id)).filter((r) => r.syncStatus === 'PENDING')).toHaveLength(1)
}))
