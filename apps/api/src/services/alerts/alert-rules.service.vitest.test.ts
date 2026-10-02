/**
 * MCP full control P3 — the alert rule and alert event reads moved from sync-logs.routes.ts into
 * alert-rules.service.ts. GET /api/sync-logs/alerts/rules and GET /api/sync-logs/alerts/events answer byte for byte
 * what they answered before (goldens recorded on the route as it was), with business profiles off and on.
 */
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
// The route file's imports reach the queues; nothing here enqueues, and no Redis runs in tests.
vi.mock('../../lib/queue.js', () => ({
  redis: null, outboundSyncQueue: null, channelSyncQueue: null, readCacheQueue: null, readinessQueue: null, searchIndexQueue: null,
  bulkJobQueue: null, adsSyncQueue: null, queueEvents: null, channelSyncQueueEvents: null, addJobSafely: vi.fn(),
  getRedisRuntimeStatus: () => ({ configured: false, status: 'off' }),
}))

import { expectGolden, freezeGoldenClock, goldenApp, GOLDEN_NOW, inGoldenBusiness } from '../../test-support/route-golden.js'
import syncLogsRoutes from '../../routes/sync-logs.routes.js'

const GOLDEN = './__golden__'
const at = (minutesAgo: number) => new Date(GOLDEN_NOW.getTime() - minutesAgo * 60_000)

let app: FastifyInstance
beforeAll(async () => {
  freezeGoldenClock()
  const db = state.db.client
  await inGoldenBusiness(async () => {
    const rule = (id: string, name: string, enabled: boolean, extra: Record<string, unknown> = {}) =>
      db.alertRule.create({
        data: { id, name, enabled, metric: 'queueDepth', operator: 'gt', threshold: 100, notificationChannels: ['email'], createdAt: at(500), updatedAt: at(400), ...extra },
      })
    await rule('golden-rule-b', 'Beta queue deep', true)
    await rule('golden-rule-a', 'Alpha error rate', true, { metric: 'errorRate', threshold: 0.2, channel: 'EBAY', windowMinutes: 30, lastEvaluatedAt: at(5), lastValue: 0.4, lastFired: true, description: 'Too many failures' })
    await rule('golden-rule-c', 'Charlie paused', false)
    const event = (id: string, ruleId: string, status: string, minutes: number, extra: Record<string, unknown> = {}) =>
      db.alertEvent.create({ data: { id, ruleId, value: minutes, status, triggeredAt: at(minutes), createdAt: at(minutes), updatedAt: at(minutes), ...extra } })
    await event('golden-event-1', 'golden-rule-a', 'TRIGGERED', 10)
    await event('golden-event-2', 'golden-rule-b', 'ACKNOWLEDGED', 20, { acknowledgedAt: at(15), acknowledgedBy: 'golden-user-a', notes: 'looking' })
    await event('golden-event-3', 'golden-rule-b', 'RESOLVED', 30, { resolvedAt: at(25), resolvedBy: 'golden-user-b' })
    await event('golden-event-4', 'golden-rule-a', 'TRIGGERED', 40, { notifications: [{ channel: 'email', ok: true }] })
  })
  app = await goldenApp([{ plugin: syncLogsRoutes, prefix: '/api' }])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

describe('P3 — alert rules and events: the routes answer exactly as before', () => {
  it('GET /api/sync-logs/alerts/rules', async () => {
    await expectGolden(app, 'alert-rules', '/api/sync-logs/alerts/rules', GOLDEN)
  })

  it('GET /api/sync-logs/alerts/events, every status and the limit bounds', async () => {
    await expectGolden(app, 'alert-events', '/api/sync-logs/alerts/events', GOLDEN)
    await expectGolden(app, 'alert-events-all', '/api/sync-logs/alerts/events?status=ALL', GOLDEN)
    await expectGolden(app, 'alert-events-triggered', '/api/sync-logs/alerts/events?status=TRIGGERED', GOLDEN)
    await expectGolden(app, 'alert-events-resolved', '/api/sync-logs/alerts/events?status=RESOLVED', GOLDEN)
    await expectGolden(app, 'alert-events-limit-low', '/api/sync-logs/alerts/events?limit=0', GOLDEN)
    await expectGolden(app, 'alert-events-limit-two', '/api/sync-logs/alerts/events?status=ALL&limit=2', GOLDEN)
    await expectGolden(app, 'alert-events-limit-high', '/api/sync-logs/alerts/events?limit=500', GOLDEN)
  })
})
