/**
 * The snapshot repricer brings a FOLLOWING listing back to its rule's price through the ONE channel price door, and
 * writes nothing else (2026-10-01).
 *
 * 🔴 WHAT THIS GUARDS. `runRepricerTick` (live: NEXUS_REPRICER_LIVE=1) wrote `ChannelListing.price` from any snapshot
 * that differed from it, with its own queue row (no hold, no cancel, no audit): a pinned listing with no priceOverride
 * was overwritten by the channel rule's price, and a sale snapshot's price became the listing's regular price.
 *
 * Real PostgreSQL in-process (PGlite). Every id is invented.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async (importOriginal) => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('./outbound-enqueue.js', async (importOriginal) => ({ ...await importOriginal<any>(), fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { runRepricerTick } from './repricer-scheduler.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let account = ''

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'snapshot-repricer', isActive: true } })).id
}), 120_000)
afterEach(() => { vi.unstubAllEnvs() })
afterAll(async () => { await state.db?.close() }, 60_000)

async function seed(id: string, listing: Record<string, unknown>, snapshot: { computedPrice: number; source: string }) {
  await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10 } })
  const l = await prisma.channelListing.create({ data: { productId: id, channel: 'AMAZON', channelConnectionId: account, channelMarket: 'AMAZON_IT', marketplace: 'IT', region: 'EU',
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}`, masterPrice: 10, ...listing } as never })
  await prisma.pricingSnapshot.create({ data: { sku: id.toUpperCase(), channel: 'AMAZON', marketplace: 'IT', computedPrice: snapshot.computedPrice, currency: 'EUR', source: snapshot.source } })
  return l
}

describe('the snapshot repricer, live', () => {
  it('🔴 a stale FOLLOWING listing is brought to its rule price through the door; a pinned one and a sale are not touched', () => scoped(async () => {
    const stale = await seed('snap-stale', { price: 10, followMasterPrice: true, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 }, { computedPrice: 11, source: 'CHANNEL_RULE' })
    // Pinned at 25 with no priceOverride: a snapshot computed by the old engine priced it by the rule (11).
    const pinned = await seed('snap-pinned', { price: 25, followMasterPrice: false, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 }, { computedPrice: 11, source: 'CHANNEL_RULE' })
    // A sale snapshot: its number is the sale, never the listing's regular price.
    const sale = await seed('snap-sale', { price: 10, followMasterPrice: true, salePrice: 8 }, { computedPrice: 8, source: 'SCHEDULED_SALE' })
    vi.stubEnv('NEXUS_REPRICER_LIVE', '1')
    const result = await runRepricerTick(prisma as never)
    expect(result).toMatchObject({ liveMode: true, enqueued: 1, skippedNotFollower: 2 })

    expect(Number((await prisma.channelListing.findUniqueOrThrow({ where: { id: stale.id } })).price)).toBe(11)
    const rows = await prisma.outboundSyncQueue.findMany({ where: { channelListingId: stale.id } })
    expect(rows.map((r) => [(r.payload as any).source, (r.payload as any).price])).toEqual([['CHANNEL_PRICE_WRITE', 11]])
    expect(rows[0].holdUntil).not.toBeNull()

    expect(Number((await prisma.channelListing.findUniqueOrThrow({ where: { id: pinned.id } })).price)).toBe(25)
    expect(Number((await prisma.channelListing.findUniqueOrThrow({ where: { id: sale.id } })).price)).toBe(10)
    expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: { in: [pinned.id, sale.id] } } })).toBe(0)
  }))
})
