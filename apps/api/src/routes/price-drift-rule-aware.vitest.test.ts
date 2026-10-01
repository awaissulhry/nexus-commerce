/**
 * "Expected price" is rule-aware on the drift surfaces (2026-10-01, "pricing rules reach the channels").
 *
 * 🔴 WHAT THIS GUARDS.
 *   - The drift cron (`sync-drift-detection.job.ts`) compared a following listing's price with the master price, so
 *     every listing following at "master +10%" was logged as PRICE_MISMATCH on every run.
 *   - The dashboard's price drift listed FIXED listings only (a PERCENT listing could drift unseen), and its Resync
 *     set `price = masterPrice` — a PERCENT listing would have been sent the raw master.
 * Both now take the rule's price from `@nexus/shared/listing-price` (the cascade's and the door's maths), and the
 * Resync goes through the channel price door's follower mode.
 *
 * Real SQL (PGlite with the production schema) and the real dashboard route plugin. Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async (importOriginal) => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { get connection() { return null } },
  }
})
vi.mock('../services/outbound-enqueue.js', async (importOriginal) => ({ ...await importOriginal<any>(), fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn(async () => undefined), emitMany: vi.fn(), emitManyTx: vi.fn() } }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { expectedFollowingPrice, runSyncDriftDetection } from '../jobs/sync-drift-detection.job.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let app: FastifyInstance
let account = ''

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'Germany', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } })
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'UK', name: 'United Kingdom', currency: 'GBP', region: 'EU', language: 'en', languages: ['en'] } })
    account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'drift-rule', isActive: true } })).id
  })
  const { default: dashboardRoutes } = await import('./dashboard.routes.js')
  app = Fastify()
  // The request runs in the business, as the workspace hook puts it there (business profiles ON or OFF).
  app.addHook('onRequest', (_request, _reply, done) => { withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done) })
  await app.register(dashboardRoutes, { prefix: '/api' })
}, 180_000)
afterAll(async () => { await app?.close(); await state.db?.close() }, 60_000)

async function seed(id: string, price: number, rule: 'FIXED' | 'PERCENT_OF_MASTER' | 'MATCH_AMAZON', adj: number | null = null, marketplace = 'DE') {
  await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10 } })
  return prisma.channelListing.create({ data: { productId: id, channel: 'EBAY', channelConnectionId: account, channelMarket: `EBAY_${marketplace}`, marketplace, region: 'EU',
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}`,
    price, masterPrice: 10, followMasterPrice: true, pricingRule: rule, priceAdjustmentPercent: adj } })
}

describe('the drift surfaces judge a following listing by its RULE\'s price', () => {
  it('expectedFollowingPrice is the rule\'s price (FIXED = master, PERCENT = master × (1 + %), MATCH_AMAZON = none)', () => {
    expect(expectedFollowingPrice({ master_price: '10.00', pricing_rule: 'PERCENT_OF_MASTER', adjustment_percent: '10.00' })).toBe(11)
    expect(expectedFollowingPrice({ master_price: '10.00', pricing_rule: 'FIXED', adjustment_percent: null })).toBe(10)
    expect(expectedFollowingPrice({ master_price: '10.00', pricing_rule: 'MATCH_AMAZON', adjustment_percent: null })).toBeNull()
  })

  it('🔴 the cron: a listing following at master +10% (11) is NOT drift; one at 12 is, and the message names the expected price', () => scoped(async () => {
    const onRule = await seed('cron-on-rule', 11, 'PERCENT_OF_MASTER', 10)
    const off = await seed('cron-off-rule', 12, 'PERCENT_OF_MASTER', 10)
    await seed('cron-match', 15, 'MATCH_AMAZON')
    await runSyncDriftDetection()
    const logged = await prisma.syncHealthLog.findMany({ where: { conflictType: 'PRICE_MISMATCH' } })
    expect(logged.map((l) => l.productId).sort()).toEqual([off.productId])
    expect(logged[0].errorMessage).toContain('listing=12.00 expected=11.00 (the master price +10%')
    expect(logged.some((l) => l.productId === onRule.productId)).toBe(false)
  }))

  it('🔴 the dashboard lists PERCENT drift against the rule\'s price, not a correct PERCENT price; its Resync sends the rule\'s price', () => scoped(async () => {
    const correct = await seed('dash-correct', 11, 'PERCENT_OF_MASTER', 10)
    const drifted = await seed('dash-drifted', 12.5, 'PERCENT_OF_MASTER', 10)
    const fixed = await seed('dash-fixed', 12, 'FIXED')
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/stock-drift' })
    expect(res.statusCode).toBe(200)
    const rows = res.json().priceDrift.rows as Array<{ id: string; expectedPrice: number; priceDelta: number }>
    const mine = rows.filter((r) => [correct.id, drifted.id, fixed.id].includes(r.id))
    expect(mine.map((r) => [r.id, r.expectedPrice, r.priceDelta])).toEqual([[fixed.id, 10, 2], [drifted.id, 11, 1.5]])

    const resync = await app.inject({ method: 'POST', url: `/api/dashboard/stock-drift/${drifted.id}/resync`, payload: { kind: 'price' } })
    expect(resync.statusCode).toBe(200)
    expect(resync.json()).toMatchObject({ success: true, newValue: 11, queued: true })
    const queue = await prisma.outboundSyncQueue.findMany({ where: { channelListingId: drifted.id } })
    expect(queue.map((r) => [r.syncType, (r.payload as any).price])).toEqual([['PRICE_UPDATE', 11]])
  }))

  it('🔴 Resync on a follower in another currency says WHY nothing is sent (the currency refusal), not "already matches its rule"', () => scoped(async () => {
    const gbp = await seed('dash-gbp', 17, 'FIXED', null, 'UK')
    const resync = await app.inject({ method: 'POST', url: `/api/dashboard/stock-drift/${gbp.id}/resync`, payload: { kind: 'price' } })
    expect(resync.statusCode).toBe(200)
    const body = resync.json()
    expect(body).toMatchObject({ success: true, newValue: 17, queued: false })
    expect(body.notSent).toMatch(/GBP/)
    expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: gbp.id } })).toBe(0)
  }))
})
