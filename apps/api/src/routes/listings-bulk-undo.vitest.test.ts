/**
 * The Undo of the listings bulk "Unfollow master" puts back only what the action changed (2026-10-13).
 *
 * 🔴 WHAT THIS GUARDS. The listings page's Undo ran "follow-master" on EVERY selected listing: one whose unfollow had
 * failed, and one that was already unfollowed before the action, were handed back to the master too — its own price
 * pin and quantity pin wiped, and the master's price and the stock sent to the channel. Now the action's job records,
 * per listing, the follow flags it changed and what they were (its answer lists those listings, `changed`), and
 * `action: "undo"` puts back exactly those flags on exactly those listings — whatever listings the caller sends.
 *
 * Real PostgreSQL in-process (PGlite), the routes through Fastify inject. Every id and SKU is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const state = vi.hoisted(() => ({ db: null as any, failQuantity: new Set<string>() }))
vi.mock('@nexus/database', async (importOriginal) => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('../services/outbound-enqueue.js', async (importOriginal) => ({ ...await importOriginal<any>(), fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('../services/listing-events.service.js', () => ({ publishListingEvent: vi.fn(), subscribeListingEvents: vi.fn() }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn(async () => undefined), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../services/product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn() } }))
// A listing whose quantity write fails: its whole unfollow is rolled back and the job records it as failed.
vi.mock('../services/listings/listing-matrix-cell.service.js', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    setListingQuantityFollow: vi.fn(async (input: { listingId: string }) => {
      if (state.failQuantity.has(input.listingId)) throw new Error('The quantity write failed (test).')
      return actual.setListingQuantityFollow(input)
    }),
  }
})

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { applyListingBulkPricing, restoreBulkFollowFlags } from '../services/listings/listing-pricing-edit.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let account = ''
let warehouse = ''
let app: ReturnType<typeof Fastify>

/** The stock every product holds in its one warehouse: what a FOLLOWING listing publishes. */
const STOCK = 12
const ALL_FOLLOW = { followMasterPrice: true, followMasterQuantity: true, followMasterTitle: true, followMasterDescription: true, followMasterImages: true, followMasterBulletPoints: true }

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'EBAY DE', currency: 'EUR', region: 'EU', language: 'en', languages: ['en'] } })
    account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'bulk-undo-EBAY', isActive: true, isPrimary: true } as never })).id
    warehouse = (await prisma.stockLocation.create({ data: { code: 'TEST-BULK-UNDO-WH', name: 'Bulk undo warehouse', type: 'WAREHOUSE' } })).id
  })
  const { listingsSyndicationRoutes } = await import('./listings-syndication.routes.js')
  app = Fastify()
  // The request runs in the business, by the Owner as the RBAC gate resolves him (price writes check permissions).
  app.addHook('onRequest', (request, _reply, done) => {
    Object.assign(request, { __rbacResolved: { isOwner: true, permissions: new Set<string>() } })
    withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done)
  })
  await app.register(listingsSyndicationRoutes, { prefix: '/api' })
}, 180_000)
afterAll(async () => { await app?.close(); await state.db?.close() }, 60_000)

type Seed = { price?: { own: number }; quantity?: { own: number }; texts?: boolean }
/**
 * A product at master 10 with STOCK units, and one live eBay DE listing showing 10 and 5. It follows the master in
 * everything unless told: `price.own` pins its price, `quantity.own` its quantity, `texts: false` unfollows the rest.
 */
async function seed(id: string, s: Seed = {}) {
  await prisma.product.create({ data: { id, sku: `TEST-${id.toUpperCase()}`, name: id, basePrice: 10, totalStock: STOCK, fulfillmentMethod: 'FBM' } as never })
  await prisma.stockLevel.create({ data: { productId: id, locationId: warehouse, quantity: STOCK, available: STOCK } })
  const texts = s.texts ?? true
  return prisma.channelListing.create({ data: {
    productId: id, channel: 'EBAY', channelConnectionId: account, channelMarket: 'EBAY_DE', marketplace: 'DE', region: 'EU',
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}`, fulfillmentMethod: 'FBM',
    price: s.price?.own ?? 10, masterPrice: 10, pricingRule: 'FIXED', followMasterPrice: !s.price, priceOverride: s.price?.own ?? null,
    quantity: s.quantity?.own ?? 5, followMasterQuantity: !s.quantity, quantityOverride: s.quantity?.own ?? null,
    followMasterTitle: texts, followMasterDescription: texts, followMasterImages: texts, followMasterBulletPoints: texts,
  } as never })
}
const listing = (id: string) => scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id } }))
const queued = (channelListingId: string) => scoped(() => prisma.outboundSyncQueue.findMany({ where: { channelListingId, syncStatus: 'PENDING' }, orderBy: { createdAt: 'asc' } }))
const flags = async (id: string) => {
  const l = await listing(id)
  return Object.fromEntries(Object.keys(ALL_FOLLOW).map((flag) => [flag, (l as Record<string, unknown>)[flag]]))
}

const post = (payload: Record<string, unknown>) => scoped(async () => app.inject({ method: 'POST', url: '/api/listings/bulk-action', payload }))
async function finished(jobId: string) {
  for (let i = 0; i < 200; i++) {
    const job = await scoped(() => prisma.bulkActionJob.findUniqueOrThrow({ where: { id: jobId } }))
    if (['COMPLETED', 'FAILED', 'PARTIALLY_COMPLETED'].includes(job.status)) {
      const answer = await scoped(async () => app.inject({ method: 'GET', url: `/api/listings/bulk-action/${jobId}` }))
      return { job, answer: answer.json() }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('the bulk job did not finish')
}
async function run(payload: Record<string, unknown>) {
  const res = await post(payload)
  expect(res.statusCode, res.body).toBe(202)
  return { ...(await finished(res.json().jobId)), accepted: res.json() }
}

describe('POST /api/listings/bulk-action — the Undo of "unfollow-master"', () => {
  it('🔴 puts back only the listings the action changed, each flag to what it was; a failed and an already-unfollowed listing are untouched', async () => {
    const { following, unfollowed, pinnedPrice, failing } = await scoped(async () => ({
      following: await seed('undo-following'),
      unfollowed: await seed('undo-unfollowed', { price: { own: 15 }, quantity: { own: 3 }, texts: false }),
      pinnedPrice: await seed('undo-pinned-price', { price: { own: 15 } }),
      failing: await seed('undo-failing'),
    }))
    state.failQuantity.add(failing.id)
    const selection = [following.id, unfollowed.id, pinnedPrice.id, failing.id]

    const unfollow = await run({ action: 'unfollow-master', listingIds: selection })
    state.failQuantity.clear()
    expect(unfollow.job).toMatchObject({ status: 'PARTIALLY_COMPLETED', processedItems: 3, failedItems: 1 })
    // The answer names what the action changed: not the listing that failed, not the one already unfollowed.
    expect(unfollow.answer.changed).toEqual([following.id, pinnedPrice.id])
    expect(unfollow.job.rollbackData).toEqual({ followFlagsBefore: [
      { listingId: following.id, before: ALL_FOLLOW },
      { listingId: pinnedPrice.id, before: { followMasterQuantity: true, followMasterTitle: true, followMasterDescription: true, followMasterImages: true, followMasterBulletPoints: true } },
    ] })
    expect(await flags(following.id)).toEqual(Object.fromEntries(Object.keys(ALL_FOLLOW).map((flag) => [flag, false])))
    expect(await flags(failing.id)).toEqual(ALL_FOLLOW)

    // What the Undo must not touch, as it stands after the action.
    const untouched = async () => ({
      unfollowed: await listing(unfollowed.id), unfollowedQueue: await queued(unfollowed.id),
      failing: await listing(failing.id), failingQueue: await queued(failing.id),
    })
    const before = await untouched()
    const pinnedQueue = await queued(pinnedPrice.id)

    // A caller that sends the whole selection still gets only the changed listings put back.
    const undo = await run({ action: 'undo', listingIds: selection, payload: { jobId: unfollow.job.id } })
    expect(undo.accepted.total).toBe(2)
    expect(undo.job).toMatchObject({ status: 'COMPLETED', processedItems: 2, failedItems: 0, targetProductIds: [following.id, pinnedPrice.id] })

    // The following listing follows again in everything: the master's price and the stock are sent.
    expect(await flags(following.id)).toEqual(ALL_FOLLOW)
    expect(await listing(following.id)).toMatchObject({ priceOverride: null, quantity: STOCK, quantityOverride: null })
    const followingQueue = await queued(following.id)
    expect(followingQueue.filter((row) => row.syncType === 'PRICE_UPDATE').map((row) => (row.payload as { price?: number }).price)).toEqual([10])
    expect(followingQueue.filter((row) => row.syncType === 'QUANTITY_UPDATE').map((row) => (row.payload as { follow?: boolean; quantity?: number })))
      .toEqual([expect.objectContaining({ follow: true, quantity: STOCK })])

    // The listing whose price was already pinned keeps its pin: only its quantity and texts follow again.
    expect(await flags(pinnedPrice.id)).toEqual({ ...ALL_FOLLOW, followMasterPrice: false })
    expect(Number((await listing(pinnedPrice.id)).priceOverride)).toBe(15)
    expect(Number((await listing(pinnedPrice.id)).price)).toBe(15)
    const pinnedAfter = await queued(pinnedPrice.id)
    expect(pinnedAfter.filter((row) => row.syncType === 'PRICE_UPDATE')).toEqual(pinnedQueue.filter((row) => row.syncType === 'PRICE_UPDATE'))
    expect(pinnedAfter.filter((row) => row.syncType === 'QUANTITY_UPDATE').map((row) => (row.payload as { follow?: boolean }).follow)).toEqual([true])

    // The failed listing and the one already unfollowed: not a column, not a version, not a queued row.
    expect(await untouched()).toEqual(before)

    // The quantity journal names the Undo.
    const journal = await scoped(() => prisma.auditLog.findMany({ where: { entityId: { in: [following.id, pinnedPrice.id] } } }))
    expect(journal.filter((row) => (row.metadata as { reason?: string } | null)?.reason === 'bulk:undo').map((row) => row.after))
      .toEqual([{ followMasterQuantity: true }, { followMasterQuantity: true }])

    // A job is undone once: its row names the Undo, and a second Undo is refused.
    expect((await scoped(() => prisma.bulkActionJob.findUniqueOrThrow({ where: { id: unfollow.job.id } }))).rollbackJobId).toBe(undo.job.id)
    const again = await post({ action: 'undo', payload: { jobId: unfollow.job.id } })
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toBe('This bulk action was already undone.')
  })

  it('a caller that sends only some of the changed listings gets only those put back', async () => {
    const [a, b] = await scoped(async () => [await seed('undo-subset-a'), await seed('undo-subset-b')])
    const unfollow = await run({ action: 'unfollow-master', listingIds: [a.id, b.id] })
    expect(unfollow.answer.changed).toEqual([a.id, b.id])
    const undo = await run({ action: 'undo', listingIds: [b.id], payload: { jobId: unfollow.job.id } })
    expect(undo.job).toMatchObject({ status: 'COMPLETED', processedItems: 1 })
    expect((await flags(a.id)).followMasterPrice).toBe(false)
    expect(await flags(b.id)).toEqual(ALL_FOLLOW)
  })

  it('refused: nothing changed, a follow-master job, an unknown job', async () => {
    const already = await scoped(() => seed('undo-nothing', { price: { own: 15 }, quantity: { own: 3 }, texts: false }))
    const noop = await run({ action: 'unfollow-master', listingIds: [already.id] })
    expect(noop.job.status).toBe('COMPLETED')
    expect(noop.answer.changed).toEqual([])
    const undoJobs = () => scoped(() => prisma.bulkActionJob.count({ where: { jobName: { startsWith: 'Listings: undo' } } }))
    const undoJobsBefore = await undoJobs()
    const nothing = await post({ action: 'undo', payload: { jobId: noop.job.id } })
    expect(nothing.statusCode).toBe(409)
    expect(nothing.json().error).toBe('Nothing to undo: the action changed no listing.')

    const follow = await run({ action: 'follow-master', listingIds: [already.id] })
    const notUnfollow = await post({ action: 'undo', payload: { jobId: follow.job.id } })
    expect(notUnfollow.statusCode).toBe(409)
    expect(notUnfollow.json().error).toBe('Only a bulk Unfollow master can be undone.')

    const unknown = await post({ action: 'undo', payload: { jobId: 'no-such-job' } })
    expect(unknown.statusCode).toBe(404)
    // A refused Undo creates no job.
    expect(await undoJobs()).toBe(undoJobsBefore)
  })
})

describe('restoreBulkFollowFlags — one listing', () => {
  it('a flag already back where it was (changed again since) is left alone; only what is still changed is put back', async () => {
    const l = await scoped(() => seed('undo-restore-partial'))
    const applied = await scoped(() => applyListingBulkPricing({ action: 'unfollow-master', listingId: l.id, actor: 'bulk-test' }))
    expect(applied.changed).toEqual(ALL_FOLLOW)
    // Someone follows the master title again by hand in the 30 seconds.
    await scoped(() => prisma.channelListing.update({ where: { id: l.id }, data: { followMasterTitle: true } }))
    const restored = await scoped(() => restoreBulkFollowFlags({ listingId: l.id, before: applied.changed!, actor: 'bulk-test' }))
    expect(restored.restored.sort()).toEqual(Object.keys(ALL_FOLLOW).filter((flag) => flag !== 'followMasterTitle').sort())
    expect(await flags(l.id)).toEqual(ALL_FOLLOW)
  })
})
