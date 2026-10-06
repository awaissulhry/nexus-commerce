/**
 * 2026-10-01 — two honesty fixes found by the live knee-slider price test.
 *
 * 1. A listing's own sync status follows its outbound queue. The price door marks a listing PENDING when it queues a row;
 *    the dispatchers never marked it again, so after the price reached Amazon (row SUCCESS, Amazon showing it) the listing
 *    still read "Pending" with no `lastSyncedAt`. Now a real send marks it IN_SYNC / SUCCESS — unless another row of the
 *    listing still waits — and a dead-lettered failure marks it FAILED with the error.
 * 2. "Recompute all" (`refreshAllSnapshots`) removes the snapshots of cells it no longer writes (a deleted product, a
 *    removed listing): production kept 177 such rows of 49 deleted products, from May, and the page's snapshot age read
 *    the oldest of them.
 *
 * Real PostgreSQL in-process (PGlite), the pattern of `price-door-held.vitest.test.ts`. Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, addJob: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../lib/queue.js', () => {
  state.addJob = vi.fn(async () => ({ enqueued: true }))
  return { outboundSyncQueue: null, redis: { connection: null }, searchIndexQueue: null, readCacheQueue: { name: 'read-cache' }, readinessQueue: null, addJobSafely: state.addJob }
})
vi.mock('./outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('./product-event.service.js', () => ({ productEventService: { emit: vi.fn(async () => undefined), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('./product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
// The engine is not under test: a fixed answer, stamped now (as resolvePrice stamps `computedAt` with its clock).
vi.mock('./pricing-engine.service.js', () => ({
  isPriceRefusal: () => false,
  resolvePrice: vi.fn(async () => ({
    price: 12.5, currency: 'EUR', source: 'MASTER_INHERIT', breakdown: {}, constraints: { isClamped: false, clampedFrom: 0 }, warnings: [], computedAt: new Date(),
  })),
}))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { recordListingSyncOutcome } from './listing-sync-outcome.js'
import { refreshAllSnapshots } from './pricing-snapshot.service.js'
import { OutboundSyncService } from './outbound-sync.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let account = ''

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'AMAZON IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
    account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'sync-outcome', isActive: true } as never })).id
  })
}, 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

/** A product and one live Amazon IT listing that a writer has just marked waiting (as the price door does). */
async function seed(id: string) {
  await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10 } as never })
  return prisma.channelListing.create({ data: {
    productId: id, channel: 'AMAZON', channelConnectionId: account, channelMarket: 'AMAZON_IT', marketplace: 'IT', region: 'EU',
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}`, price: 10, followMasterPrice: true, masterPrice: 10,
    syncStatus: 'PENDING', lastSyncStatus: 'PENDING', lastSyncError: 'an older failure',
  } as never })
}
const row = (l: { id: string; productId: string }, syncStatus: string, extra: Record<string, unknown> = {}) => prisma.outboundSyncQueue.create({ data: {
  productId: l.productId, channelListingId: l.id, targetChannel: 'AMAZON', targetRegion: 'IT', syncType: 'PRICE_UPDATE', syncStatus,
  payload: { price: 11 }, externalListingId: `ITEM-${l.productId}`, ...extra,
} as never })
const listing = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })

describe('recordListingSyncOutcome — the listing follows its queue', () => {
  it('a send with nothing else waiting: IN_SYNC, SUCCESS, lastSyncedAt now, the old error cleared, the version untouched', () => scoped(async () => {
    const l = await seed('outcome-sent')
    await row(l, 'SUCCESS')
    state.addJob.mockClear()
    await recordListingSyncOutcome(prisma, { channelListingId: l.id, productId: l.productId, outcome: 'sent' })
    const after = await listing(l.id)
    expect(after).toMatchObject({ syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS', lastSyncError: null, version: l.version })
    expect(after.lastSyncedAt).toBeInstanceOf(Date)
    // The grids read lastSyncStatus from the product read cache: its refresh job is queued.
    expect(state.addJob).toHaveBeenCalledWith(expect.anything(), 'refresh', { productId: l.productId }, expect.objectContaining({ jobId: `cache:refresh:${l.productId}` }))
  }))

  it('a send while another row of the listing still waits: the send is recorded, the listing stays PENDING', () => scoped(async () => {
    const l = await seed('outcome-other-waits')
    await row(l, 'SUCCESS')
    await row(l, 'PENDING')
    await recordListingSyncOutcome(prisma, { channelListingId: l.id, productId: l.productId, outcome: 'sent' })
    const after = await listing(l.id)
    expect(after).toMatchObject({ syncStatus: 'PENDING', lastSyncStatus: 'PENDING' })
    expect(after.lastSyncedAt).toBeInstanceOf(Date)
  }))

  it('a row still IN_PROGRESS also keeps it PENDING; a held (SKIPPED) row does not', () => scoped(async () => {
    const busy = await seed('outcome-in-progress')
    await row(busy, 'IN_PROGRESS')
    await recordListingSyncOutcome(prisma, { channelListingId: busy.id, productId: busy.productId, outcome: 'sent' })
    expect(await listing(busy.id)).toMatchObject({ syncStatus: 'PENDING' })
    const kept = await seed('outcome-held-row')
    await row(kept, 'SKIPPED', { errorCode: 'PUSH_SYNC_PAUSED' })
    await recordListingSyncOutcome(prisma, { channelListingId: kept.id, productId: kept.productId, outcome: 'sent' })
    expect(await listing(kept.id)).toMatchObject({ syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS' })
  }))

  it('a dead-lettered failure: FAILED with the error, the version untouched', () => scoped(async () => {
    const l = await seed('outcome-failed')
    await recordListingSyncOutcome(prisma, { channelListingId: l.id, productId: l.productId, outcome: 'failed', error: 'The channel refused the price.' })
    expect(await listing(l.id)).toMatchObject({ syncStatus: 'FAILED', lastSyncStatus: 'FAILED', lastSyncError: 'The channel refused the price.', version: l.version })
  }))

  it('2026-10-06 — a skip that ends the wait: PENDING → SKIPPED with the reason when nothing else waits; nothing was sent', () => scoped(async () => {
    const l = await seed('outcome-skip-settles')
    await row(l, 'SKIPPED', { errorCode: 'EBAY_SHARED_LISTING_OWNS_SKU' })
    await recordListingSyncOutcome(prisma, { channelListingId: l.id, productId: l.productId, outcome: 'skipped', error: 'EBAY_SHARED_LISTING_OWNS_SKU: its shared stock sends the quantity.' })
    expect(await listing(l.id)).toMatchObject({ syncStatus: 'PENDING', lastSyncStatus: 'SKIPPED', lastSyncError: 'EBAY_SHARED_LISTING_OWNS_SKU: its shared stock sends the quantity.', lastSyncedAt: null, version: l.version })
  }))

  it('2026-10-06 — a settling skip never overwrites what the listing already reads, and another waiting row keeps it PENDING', () => scoped(async () => {
    const waits = await seed('outcome-skip-other-waits')
    await row(waits, 'PENDING')
    await recordListingSyncOutcome(prisma, { channelListingId: waits.id, productId: waits.productId, outcome: 'skipped', error: 'X: y' })
    expect(await listing(waits.id)).toMatchObject({ lastSyncStatus: 'PENDING' })
    const done = await seed('outcome-skip-after-success')
    await prisma.channelListing.update({ where: { id: done.id }, data: { lastSyncStatus: 'SUCCESS', lastSyncError: null } })
    await recordListingSyncOutcome(prisma, { channelListingId: done.id, productId: done.productId, outcome: 'skipped', error: 'X: y' })
    expect(await listing(done.id)).toMatchObject({ lastSyncStatus: 'SUCCESS', lastSyncError: null })
  }))

  it('a row with no listing records nothing and never throws', () => scoped(async () => {
    await expect(recordListingSyncOutcome(prisma, { channelListingId: null, productId: null, outcome: 'sent' })).resolves.toBeUndefined()
    await expect(recordListingSyncOutcome(prisma, { channelListingId: 'no-such-listing', outcome: 'failed' })).resolves.toBeUndefined()
  }))
})

describe('the backup dispatch loop records the outcome on the listing', () => {
  const service = new OutboundSyncService() as any

  it('a sent row: the listing reads IN_SYNC / SUCCESS (it read Pending before)', () => scoped(async () => {
    const l = await seed('loop-sent')
    const q = await row(l, 'PENDING')
    const dispatch = vi.spyOn(service, 'dispatchSync').mockResolvedValue({ success: true, queueId: q.id, channel: 'AMAZON', status: 'SUCCESS', message: 'sent' })
    await service.processPendingSyncs()
    dispatch.mockRestore()
    expect((await prisma.outboundSyncQueue.findUniqueOrThrow({ where: { id: q.id } })).syncStatus).toBe('SUCCESS')
    expect(await listing(l.id)).toMatchObject({ syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS' })
  }))

  it('a row that sent nothing (SKIPPED) leaves the listing alone', () => scoped(async () => {
    const l = await seed('loop-skipped')
    const q = await row(l, 'PENDING')
    const dispatch = vi.spyOn(service, 'dispatchSync').mockResolvedValue({ success: true, queueId: q.id, channel: 'AMAZON', status: 'SKIPPED', message: 'nothing to send' })
    await service.processPendingSyncs()
    dispatch.mockRestore()
    expect((await prisma.outboundSyncQueue.findUniqueOrThrow({ where: { id: q.id } })).syncStatus).toBe('SKIPPED')
    expect(await listing(l.id)).toMatchObject({ syncStatus: 'PENDING', lastSyncStatus: 'PENDING', lastSyncedAt: null })
  }))

  it('2026-10-06 — a skip that ends the wait (an eBay Trading quantity the shared stock sends) reads SKIPPED with its reason', () => scoped(async () => {
    const l = await seed('loop-settling-skip')
    const q = await row(l, 'PENDING')
    const dispatch = vi.spyOn(service, 'dispatchSync').mockResolvedValue({ success: true, queueId: q.id, channel: 'EBAY', status: 'SKIPPED',
      message: 'eBay item 1 is a shared listing: its shared stock sends the quantity.', errorCode: 'EBAY_SHARED_LISTING_OWNS_SKU', retryable: false })
    await service.processPendingSyncs()
    dispatch.mockRestore()
    expect((await prisma.outboundSyncQueue.findUniqueOrThrow({ where: { id: q.id } })).syncStatus).toBe('SKIPPED')
    expect(await listing(l.id)).toMatchObject({ syncStatus: 'PENDING', lastSyncStatus: 'SKIPPED',
      lastSyncError: 'EBAY_SHARED_LISTING_OWNS_SKU: eBay item 1 is a shared listing: its shared stock sends the quantity.', lastSyncedAt: null })
  }))

  it('a terminal failure: the listing reads FAILED with the error; a retryable one leaves it PENDING', () => scoped(async () => {
    const dead = await seed('loop-dead')
    const q1 = await row(dead, 'PENDING')
    let dispatch = vi.spyOn(service, 'dispatchSync').mockResolvedValue({ success: false, queueId: q1.id, channel: 'AMAZON', status: 'FAILED', message: 'no', error: 'Price is not valid for this listing', retryable: false })
    await service.processPendingSyncs()
    dispatch.mockRestore()
    expect((await prisma.outboundSyncQueue.findUniqueOrThrow({ where: { id: q1.id } })).isDead).toBe(true)
    expect(await listing(dead.id)).toMatchObject({ syncStatus: 'FAILED', lastSyncStatus: 'FAILED', lastSyncError: 'Price is not valid for this listing' })

    const retry = await seed('loop-retry')
    const q2 = await row(retry, 'PENDING')
    dispatch = vi.spyOn(service, 'dispatchSync').mockResolvedValue({ success: false, queueId: q2.id, channel: 'AMAZON', status: 'FAILED', message: 'later', error: 'Temporary error', retryable: true })
    await service.processPendingSyncs()
    dispatch.mockRestore()
    expect((await prisma.outboundSyncQueue.findUniqueOrThrow({ where: { id: q2.id } })).isDead).toBe(false)
    expect(await listing(retry.id)).toMatchObject({ syncStatus: 'PENDING', lastSyncStatus: 'PENDING' })
  }))
})

describe('Recompute all removes the snapshots of cells that no longer exist', () => {
  it('a live listing is rewritten; a deleted product\'s and a removed listing\'s old rows are removed', () => scoped(async () => {
    const live = await seed('snap-live')
    const gone = await seed('snap-listing-removed')
    const old = new Date('2026-05-05T17:32:29Z')
    const snapshot = (sku: string) => prisma.pricingSnapshot.create({ data: { sku, channel: 'AMAZON', marketplace: 'IT', computedPrice: 26.83, currency: 'EUR', source: 'MASTER_INHERIT', computedAt: old } as never })
    await snapshot(live.productId.toUpperCase())
    await snapshot(gone.productId.toUpperCase())
    await snapshot('SNAP-DELETED-PRODUCT') // no product at all any more
    await prisma.channelListing.delete({ where: { id: gone.id } })

    const result = await refreshAllSnapshots(prisma as never)

    const rows = await prisma.pricingSnapshot.findMany({ where: { sku: { in: ['SNAP-LIVE', 'SNAP-LISTING-REMOVED', 'SNAP-DELETED-PRODUCT'] } } })
    expect(rows.map((r) => r.sku)).toEqual(['SNAP-LIVE'])
    expect(String(rows[0].computedPrice)).toBe('12.5')
    expect(rows[0].computedAt.getTime()).toBeGreaterThan(old.getTime())
    expect(result.removed).toBeGreaterThanOrEqual(2)
  }))
})
