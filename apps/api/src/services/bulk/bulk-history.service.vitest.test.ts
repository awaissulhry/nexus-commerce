/**
 * MCP full control P3 — the bulk operation history reads moved from bulk-operations.routes.ts into
 * bulk-history.service.ts. GET /api/bulk-operations/history and GET /api/bulk-operations/:id/items answer byte for
 * byte what they answered before (goldens recorded on the route as it was), with business profiles off and on.
 */
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
// The route file's imports reach the queues and the event and cache writers; nothing here writes, and no Redis runs.
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))

import { expectGolden, freezeGoldenClock, goldenApp, GOLDEN_NOW, inGoldenBusiness } from '../../test-support/route-golden.js'
import bulkOperationsRoutes from '../../routes/bulk-operations.routes.js'

const GOLDEN = './__golden__'
const at = (minutesAgo: number) => new Date(GOLDEN_NOW.getTime() - minutesAgo * 60_000)

/** id, status, actionType, createdBy, minutes ago. */
const JOBS: Array<[string, string, string, string | null, number]> = [
  ['golden-job-1', 'COMPLETED', 'PRICING_UPDATE', 'golden-person-a', 10],
  ['golden-job-2', 'PENDING', 'INVENTORY_UPDATE', 'automation:golden-rule', 20],
  ['golden-job-3', 'IN_PROGRESS', 'PRICING_UPDATE', 'schedule:golden-schedule', 30],
  ['golden-job-4', 'FAILED', 'STATUS_UPDATE', null, 40],
  ['golden-job-5', 'PARTIALLY_COMPLETED', 'PRICING_UPDATE', 'golden-person-b', 50],
  ['golden-job-6', 'CANCELLED', 'ATTRIBUTE_UPDATE', 'api-key:golden-key', 60],
  ['golden-job-7', 'QUEUED', 'PRICING_UPDATE', 'golden-person-gone', 70],
  ['golden-job-old', 'COMPLETED', 'PRICING_UPDATE', 'golden-person-a', 3 * 24 * 60],
]

let app: FastifyInstance
beforeAll(async () => {
  freezeGoldenClock()
  const db = state.db.client
  await db.userProfile.create({ data: { id: 'golden-person-a', email: 'golden-a@example.test', displayName: 'Golden A', status: 'active' } })
  await db.userProfile.create({ data: { id: 'golden-person-b', email: 'golden-b@example.test', displayName: '', status: 'active' } })
  await inGoldenBusiness(async () => {
    await db.product.create({ data: { id: 'golden-product-1', sku: 'TEST-SKU-1', name: 'Golden product', basePrice: '10.00', totalStock: 3 } })
    await db.product.create({ data: { id: 'golden-product-2', sku: 'TEST-SKU-2', name: 'Golden listed', basePrice: '12.00', totalStock: 1 } })
    await db.productVariation.create({ data: { id: 'golden-variation-1', productId: 'golden-product-1', sku: 'TEST-SKU-1-RED', price: '11.00' } })
    await db.channelListing.create({ data: { id: 'golden-listing-1', productId: 'golden-product-2', channelMarket: 'EBAY_IT', channel: 'EBAY', region: 'IT', marketplace: 'IT', price: '13.00', quantity: 1 } })
    for (const [id, status, actionType, createdBy, minutes] of JOBS) {
      await db.bulkActionJob.create({
        data: {
          id, jobName: `Golden ${id}`, actionType, status, createdBy, targetProductIds: ['golden-product-1'], targetVariationIds: [],
          actionPayload: { adjustmentPercent: 5 }, totalItems: 4, processedItems: 2, failedItems: 1, progressPercent: 75,
          createdAt: at(minutes), updatedAt: at(minutes),
        },
      })
    }
    const item = (id: string, status: string, minutes: number, target: Record<string, string>, extra: Record<string, unknown> = {}) =>
      db.bulkActionItem.create({ data: { id, jobId: 'golden-job-1', status, createdAt: at(minutes), ...target, ...extra } })
    await item('golden-item-1', 'SUCCEEDED', 9, { productId: 'golden-product-1' }, { beforeState: { basePrice: 10 }, afterState: { basePrice: 10.5 }, completedAt: at(8), durationMs: 40 })
    await item('golden-item-2', 'SUCCEEDED', 8, { variationId: 'golden-variation-1' })
    await item('golden-item-3', 'FAILED', 7, { channelListingId: 'golden-listing-1' }, { errorMessage: 'channel said no' })
    await item('golden-item-4', 'SKIPPED', 6, { productId: 'golden-product-deleted' })
  })
  app = await goldenApp([{ plugin: bulkOperationsRoutes, prefix: '/api' }])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

describe('P3 — bulk history: the routes answer exactly as before', () => {
  it('GET /api/bulk-operations/history, every filter and alias', async () => {
    const since = encodeURIComponent(at(45).toISOString())
    await expectGolden(app, 'bulk-history', '/api/bulk-operations/history', GOLDEN)
    await expectGolden(app, 'bulk-history-active', '/api/bulk-operations/history?status=active', GOLDEN)
    await expectGolden(app, 'bulk-history-terminal', '/api/bulk-operations/history?status=terminal', GOLDEN)
    await expectGolden(app, 'bulk-history-status', '/api/bulk-operations/history?status=FAILED', GOLDEN)
    await expectGolden(app, 'bulk-history-type-since', `/api/bulk-operations/history?actionType=PRICING_UPDATE&since=${since}`, GOLDEN)
    await expectGolden(app, 'bulk-history-limit', '/api/bulk-operations/history?limit=2', GOLDEN)
    await expectGolden(app, 'bulk-history-limit-bounds', '/api/bulk-operations/history?limit=0', GOLDEN)
  })

  it('GET /api/bulk-operations/:id/items, all, by status and limited', async () => {
    await expectGolden(app, 'bulk-items', '/api/bulk-operations/golden-job-1/items', GOLDEN)
    await expectGolden(app, 'bulk-items-status', '/api/bulk-operations/golden-job-1/items?status=SUCCEEDED', GOLDEN)
    await expectGolden(app, 'bulk-items-limit', '/api/bulk-operations/golden-job-1/items?limit=2', GOLDEN)
    await expectGolden(app, 'bulk-items-none', '/api/bulk-operations/golden-job-none/items', GOLDEN)
  })
})
