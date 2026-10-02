/**
 * MCP full control P3 — the triage inbox reads moved from inbox.routes.ts into triage-inbox.service.ts. GET /api/inbox
 * and GET /api/inbox/count answer byte for byte what they answered before (goldens recorded on the route as it was),
 * with business profiles off and on.
 */
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})

import { expectGolden, freezeGoldenClock, goldenApp, GOLDEN_NOW, inGoldenBusiness } from '../../test-support/route-golden.js'
import inboxRoutes from '../../routes/inbox.routes.js'

const GOLDEN = './__golden__'
const at = (minutesAgo: number) => new Date(GOLDEN_NOW.getTime() - minutesAgo * 60_000)

let app: FastifyInstance
beforeAll(async () => {
  freezeGoldenClock()
  const db = state.db.client
  await inGoldenBusiness(async () => {
    await db.product.create({ data: { id: 'golden-product-1', sku: 'TEST-SKU-1', name: 'Golden product', basePrice: '10.00', totalStock: 3 } })
    await db.outboundSyncQueue.create({ data: { id: 'golden-queue-dead', productId: 'golden-product-1', targetChannel: 'EBAY', syncStatus: 'FAILED', payload: {}, syncType: 'PRICE_UPDATE', retryCount: 3, maxRetries: 3, isDead: true, errorMessage: 'gone', errorCode: 'E1', createdAt: at(300), updatedAt: at(200) } })
    await db.outboundSyncQueue.create({ data: { id: 'golden-queue-failed', targetChannel: 'AMAZON', syncStatus: 'FAILED', payload: {}, syncType: 'QUANTITY_UPDATE', retryCount: 1, maxRetries: 3, createdAt: at(120), updatedAt: at(100) } })
    await db.outboundSyncQueue.create({ data: { id: 'golden-queue-ok', targetChannel: 'AMAZON', syncStatus: 'SUCCESS', payload: {}, syncType: 'QUANTITY_UPDATE', createdAt: at(50), updatedAt: at(50) } })
    await db.alertRule.create({ data: { id: 'golden-rule-rate', name: 'Error rate high', metric: 'errorRate', operator: 'gt', threshold: 0.2, channel: 'EBAY', notificationChannels: [] } })
    await db.alertRule.create({ data: { id: 'golden-rule-queue', name: 'Queue deep', metric: 'queueDepth', operator: 'gt', threshold: 100, notificationChannels: [] } })
    await db.alertEvent.create({ data: { id: 'golden-alert-1', ruleId: 'golden-rule-rate', value: 0.4, triggeredAt: at(30) } })
    await db.alertEvent.create({ data: { id: 'golden-alert-2', ruleId: 'golden-rule-queue', value: 250, triggeredAt: at(20) } })
    await db.alertEvent.create({ data: { id: 'golden-alert-3', ruleId: 'golden-rule-queue', value: 90, status: 'RESOLVED', triggeredAt: at(10) } })
    await db.notification.create({ data: { id: 'golden-note-1', userId: 'golden-person', type: 'order', severity: 'danger', title: 'Order stuck', body: 'Look at it', href: '/orders', entityType: 'Order', entityId: 'o1', createdAt: at(15) } })
    await db.notification.create({ data: { id: 'golden-note-2', userId: 'golden-person', type: 'info', title: 'Hello', createdAt: at(5) } })
    await db.notification.create({ data: { id: 'golden-note-read', userId: 'golden-person', type: 'info', title: 'Read', readAt: at(1), createdAt: at(4) } })
    await db.webhookEvent.create({ data: { id: 'golden-hook-1', channel: 'SHOPIFY', eventType: 'products/update', externalId: 'golden-ext-1', payload: {}, error: 'x'.repeat(120), createdAt: at(40) } })
    await db.webhookEvent.create({ data: { id: 'golden-hook-ok', channel: 'SHOPIFY', eventType: 'products/update', externalId: 'golden-ext-2', payload: {}, isProcessed: true, createdAt: at(41) } })
  })
  app = await goldenApp([{ plugin: inboxRoutes, prefix: '/api' }])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

describe('P3 — triage inbox: the routes answer exactly as before', () => {
  it('GET /api/inbox, unfiltered and filtered', async () => {
    await expectGolden(app, 'inbox', '/api/inbox', GOLDEN)
    await expectGolden(app, 'inbox-critical-page', '/api/inbox?severity=critical&limit=1&offset=1', GOLDEN)
    await expectGolden(app, 'inbox-alerts', '/api/inbox?source=alert', GOLDEN)
    await expectGolden(app, 'inbox-webhooks', '/api/inbox?source=webhook', GOLDEN)
  })

  it('GET /api/inbox/count', async () => {
    await expectGolden(app, 'inbox-count', '/api/inbox/count', GOLDEN)
  })
})
