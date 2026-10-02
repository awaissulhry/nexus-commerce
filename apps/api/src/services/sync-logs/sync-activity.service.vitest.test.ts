/**
 * MCP full control P3 — the sync activity reads moved from sync-logs.routes.ts and outbound-queue.routes.ts into
 * sync-activity.service.ts: recent API calls, error groups, the webhook event list and the outbound queue list. Each
 * route answers byte for byte what it answered before (goldens recorded on the routes as they were), with business
 * profiles off and on.
 */
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
// No Redis here: the queues are built at import time and would try to connect. These reads never enqueue.
vi.mock('../../lib/queue.js', () => ({
  redis: { connection: null }, outboundSyncQueue: null, channelSyncQueue: null, readCacheQueue: null, readinessQueue: null,
  searchIndexQueue: null, bulkJobQueue: null, adsSyncQueue: null, queueEvents: null, channelSyncQueueEvents: null,
  addJobSafely: vi.fn(), resetEnqueueCircuitForTests: vi.fn(), initializeQueue: vi.fn(), closeQueue: vi.fn(),
  getQueueStats: vi.fn(), getRedisRuntimeStatus: vi.fn(() => ({ configured: false, status: 'not-initialized' })), resolveRedisTarget: vi.fn(),
}))

import { expectGolden, freezeGoldenClock, goldenApp, GOLDEN_NOW, inGoldenBusiness } from '../../test-support/route-golden.js'
import syncLogsRoutes from '../../routes/sync-logs.routes.js'
import outboundQueueRoutes from '../../routes/outbound-queue.routes.js'

const GOLDEN = './__golden__'
const at = (minutesAgo: number) => new Date(GOLDEN_NOW.getTime() - minutesAgo * 60_000)
const DAY = 24 * 60

let app: FastifyInstance
beforeAll(async () => {
  freezeGoldenClock()
  const db = state.db.client
  await inGoldenBusiness(async () => {
    await db.product.create({ data: { id: 'golden-product-1', sku: 'TEST-SKU-1', name: 'Golden product', basePrice: '10.00', totalStock: 3 } })

    // ── API calls: two accounts, both outcomes, one outside the default 24 h window ──
    const call = (id: string, minutesAgo: number, data: Record<string, unknown>) =>
      db.outboundApiCallLog.create({ data: { id, operation: 'getItem', latencyMs: 100 + minutesAgo, createdAt: at(minutesAgo), ...data } })
    await call('golden-call-1', 10, { channel: 'EBAY', marketplace: 'IT', connectionId: 'golden-conn-1', statusCode: 200, success: true, endpoint: '/item', method: 'GET', triggeredBy: 'cron', productId: 'golden-product-1' })
    await call('golden-call-2', 20, { channel: 'EBAY', marketplace: 'DE', connectionId: 'golden-conn-2', statusCode: 500, success: false, errorType: 'SERVER', errorMessage: 'boom', errorCode: 'E500', requestId: 'golden-req-2' })
    await call('golden-call-3', 30, { channel: 'AMAZON', marketplace: 'IT', connectionId: 'golden-conn-2', statusCode: 429, success: false, errorType: 'RATE_LIMIT', operation: 'patchListingsItem', listingId: 'golden-listing-1' })
    await call('golden-call-4', 40, { channel: 'AMAZON', statusCode: 200, success: true, orderId: 'golden-order-1' })
    await call('golden-call-old', 2 * DAY, { channel: 'EBAY', statusCode: 200, success: true })

    // ── Error groups: every resolution status, two channels, one outside the default 7 days ──
    const group = (id: string, minutesAgo: number, data: Record<string, unknown>) =>
      db.syncLogErrorGroup.create({ data: { id, fingerprint: `fp-${id}`, operation: 'getItem', sampleMessage: `sample ${id}`, count: 3, firstSeen: at(minutesAgo + 60), lastSeen: at(minutesAgo), ...data } })
    await group('golden-group-1', 5, { channel: 'EBAY', errorType: 'SERVER' })
    await group('golden-group-2', 15, { channel: 'AMAZON', errorType: 'RATE_LIMIT', errorCode: 'QuotaExceeded' })
    await group('golden-group-3', 25, { channel: 'EBAY', resolutionStatus: 'RESOLVED', resolvedAt: at(20), resolvedBy: 'golden-person', notes: 'fixed' })
    await group('golden-group-4', 35, { channel: 'SHOPIFY', resolutionStatus: 'MUTED' })
    await group('golden-group-old', 10 * DAY, { channel: 'EBAY' })

    // ── Webhook events: the four lifecycle states, both processed values, one outside the default 24 h ──
    const hook = (id: string, minutesAgo: number, data: Record<string, unknown>) =>
      db.webhookEvent.create({ data: { id, externalId: `ext-${id}`, payload: { secret: 'never listed' }, signature: 'sig', createdAt: at(minutesAgo), updatedAt: at(minutesAgo), ...data } })
    await hook('golden-hook-1', 5, { channel: 'SHOPIFY', eventType: 'orders/create', status: 'pending', providerTimestamp: at(6) })
    await hook('golden-hook-2', 15, { channel: 'SHOPIFY', eventType: 'products/update', status: 'done', isProcessed: true, processedAt: at(14), attempts: 1, deliveries: 1, signatureOk: true, verifiedBy: 'hmac' })
    await hook('golden-hook-3', 25, { channel: 'ETSY', eventType: 'orders/create', status: 'failed', error: 'bad', lastError: 'bad', attempts: 2, nextAttemptAt: at(-10) })
    await hook('golden-hook-4', 35, { channel: 'EBAY', eventType: 'ITEM_SOLD', status: 'dlq', error: 'dead', lastError: 'dead', attempts: 5, archivedAt: at(30) })
    await hook('golden-hook-old', 3 * DAY, { channel: 'SHOPIFY', eventType: 'orders/create', status: 'done', isProcessed: true })

    // ── Outbound queue: active (pending, stuck, held, in progress, failed), dead, recent success, old ──
    const row = (id: string, minutesAgo: number, data: Record<string, unknown>) =>
      db.outboundSyncQueue.create({ data: { id, payload: { price: 10 }, syncType: 'PRICE_UPDATE', createdAt: at(minutesAgo), updatedAt: at(minutesAgo), ...data } })
    await row('golden-q-01', 5, { targetChannel: 'EBAY', syncStatus: 'PENDING', productId: 'golden-product-1' })
    await row('golden-q-02', 60, { targetChannel: 'AMAZON', syncStatus: 'PENDING', syncType: 'QUANTITY_UPDATE' })
    await row('golden-q-03', 70, { targetChannel: 'AMAZON', syncStatus: 'PENDING', holdUntil: at(40) })
    await row('golden-q-04', 80, { targetChannel: 'SHOPIFY', syncStatus: 'PENDING', holdUntil: at(-30) })
    await row('golden-q-05', 90, { targetChannel: 'EBAY', syncStatus: 'IN_PROGRESS' })
    await row('golden-q-06', 100, { targetChannel: 'EBAY', syncStatus: 'FAILED', retryCount: 2, errorMessage: 'nope', errorCode: 'E1', nextRetryAt: at(-5) })
    await row('golden-q-07', 110, { targetChannel: 'AMAZON', syncStatus: 'FAILED', isDead: true, diedAt: at(100), retryCount: 3, errorMessage: 'dead' })
    await row('golden-q-08', 120, { targetChannel: 'EBAY', syncStatus: 'SUCCESS', syncedAt: at(60) })
    await row('golden-q-09', 130, { targetChannel: 'EBAY', syncStatus: 'SUCCESS', syncedAt: at(200) })
    await row('golden-q-10', 9 * DAY, { targetChannel: 'EBAY', syncStatus: 'PENDING' })
  })
  app = await goldenApp([
    { plugin: syncLogsRoutes, prefix: '/api' },
    { plugin: outboundQueueRoutes },
  ])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

describe('P3 — sync activity: the routes answer exactly as before', () => {
  it('GET /api/sync-logs/api-calls/recent with its filters and cursor', async () => {
    await expectGolden(app, 'api-calls-recent', '/api/sync-logs/api-calls/recent', GOLDEN)
    await expectGolden(app, 'api-calls-recent-ebay', '/api/sync-logs/api-calls/recent?channel=EBAY', GOLDEN)
    await expectGolden(app, 'api-calls-recent-failed', '/api/sync-logs/api-calls/recent?success=false', GOLDEN)
    await expectGolden(app, 'api-calls-recent-ok', '/api/sync-logs/api-calls/recent?success=true&operation=getItem', GOLDEN)
    await expectGolden(app, 'api-calls-recent-account', '/api/sync-logs/api-calls/recent?connectionId=golden-conn-2&errorType=RATE_LIMIT', GOLDEN)
    await expectGolden(app, 'api-calls-recent-ids', '/api/sync-logs/api-calls/recent?productId=golden-product-1&requestId=x', GOLDEN)
    await expectGolden(app, 'api-calls-recent-page', '/api/sync-logs/api-calls/recent?limit=2', GOLDEN)
    await expectGolden(app, 'api-calls-recent-cursor', '/api/sync-logs/api-calls/recent?limit=2&cursor=golden-call-2', GOLDEN)
    await expectGolden(app, 'api-calls-recent-window', `/api/sync-logs/api-calls/recent?since=${at(3 * DAY).toISOString()}&until=${at(25).toISOString()}`, GOLDEN)
  })

  it('GET /api/sync-logs/error-groups by status, channel and cursor', async () => {
    await expectGolden(app, 'error-groups', '/api/sync-logs/error-groups', GOLDEN)
    await expectGolden(app, 'error-groups-all', '/api/sync-logs/error-groups?status=ALL', GOLDEN)
    await expectGolden(app, 'error-groups-resolved', '/api/sync-logs/error-groups?status=RESOLVED', GOLDEN)
    await expectGolden(app, 'error-groups-ebay', '/api/sync-logs/error-groups?status=ALL&channel=EBAY', GOLDEN)
    await expectGolden(app, 'error-groups-page', '/api/sync-logs/error-groups?status=ALL&limit=1&cursor=golden-group-1', GOLDEN)
    await expectGolden(app, 'error-groups-since', `/api/sync-logs/error-groups?status=ALL&since=${at(30 * DAY).toISOString()}`, GOLDEN)
  })

  it('GET /api/sync-logs/webhooks by lifecycle, processed, channel and cursor', async () => {
    await expectGolden(app, 'webhooks', '/api/sync-logs/webhooks', GOLDEN)
    await expectGolden(app, 'webhooks-failed-dlq', '/api/sync-logs/webhooks?status=failed,dlq', GOLDEN)
    await expectGolden(app, 'webhooks-unprocessed', '/api/sync-logs/webhooks?processed=false', GOLDEN)
    await expectGolden(app, 'webhooks-processed', '/api/sync-logs/webhooks?processed=true', GOLDEN)
    await expectGolden(app, 'webhooks-shopify-orders', '/api/sync-logs/webhooks?channel=SHOPIFY&eventType=orders/create', GOLDEN)
    await expectGolden(app, 'webhooks-page', '/api/sync-logs/webhooks?limit=1&cursor=golden-hook-1', GOLDEN)
    await expectGolden(app, 'webhooks-since', `/api/sync-logs/webhooks?since=${at(5 * DAY).toISOString()}`, GOLDEN)
  })

  it('GET /api/outbound-queue by tab, status, channel, type, stuck and cursor', async () => {
    await expectGolden(app, 'outbound-queue', '/api/outbound-queue', GOLDEN)
    await expectGolden(app, 'outbound-queue-dead', '/api/outbound-queue?tab=dead', GOLDEN)
    await expectGolden(app, 'outbound-queue-success', '/api/outbound-queue?tab=success', GOLDEN)
    await expectGolden(app, 'outbound-queue-stuck', '/api/outbound-queue?stuckOnly=true', GOLDEN)
    await expectGolden(app, 'outbound-queue-failed-ebay', '/api/outbound-queue?status=FAILED&channel=EBAY', GOLDEN)
    await expectGolden(app, 'outbound-queue-type', '/api/outbound-queue?syncType=QUANTITY_UPDATE', GOLDEN)
    await expectGolden(app, 'outbound-queue-page', '/api/outbound-queue?limit=2', GOLDEN)
    await expectGolden(app, 'outbound-queue-cursor', '/api/outbound-queue?limit=2&cursor=golden-q-03', GOLDEN)
  })
})
