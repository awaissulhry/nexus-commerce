/**
 * MCP full control P7 — the alert rule writes (create, change), the alert event writes (acknowledge, resolve) and
 * marking a notification read moved from sync-logs.routes.ts and notifications.routes.ts into
 * alerts/alert-rules.service.ts and notification-inbox.service.ts, for Claude's set-alert-rule and acknowledge-alerts.
 * The routes answer byte for byte what they answered before (goldens recorded on the routes as they were), with
 * business profiles off and on; the reads after each write show what it stored.
 *
 * Not recorded: a write to an id that does not exist. Those answer a 500 whose body is Prisma's message, and that
 * message quotes the calling source line, which a move changes by definition.
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
import notificationsRoutes from '../../routes/notifications.routes.js'

const GOLDEN = './__golden__'
const at = (minutesAgo: number) => new Date(GOLDEN_NOW.getTime() - minutesAgo * 60_000)
/** A created row's id is random: the golden holds its place. */
const createdId = (body: string) => body.replace(/"id":"c[a-z0-9]{20,}"/g, '"id":"<created id>"')

let app: FastifyInstance
beforeAll(async () => {
  freezeGoldenClock()
  const db = state.db.client
  await inGoldenBusiness(async () => {
    const rule = (id: string, name: string, extra: Record<string, unknown> = {}) =>
      db.alertRule.create({
        data: { id, name, metric: 'queueDepth', operator: 'gt', threshold: 100, notificationChannels: ['log'], createdAt: at(500), updatedAt: at(400), ...extra },
      })
    await rule('golden-rule-a', 'Alpha error rate', { metric: 'errorRate', threshold: 0.2, channel: 'EBAY', lastFired: true, description: 'Too many failures' })
    await rule('golden-rule-b', 'Beta queue deep', { lastFired: true })
    const event = (id: string, ruleId: string, status: string, minutes: number) =>
      db.alertEvent.create({ data: { id, ruleId, value: minutes, status, triggeredAt: at(minutes), createdAt: at(minutes), updatedAt: at(minutes) } })
    await event('golden-event-1', 'golden-rule-a', 'TRIGGERED', 10)
    await event('golden-event-2', 'golden-rule-b', 'TRIGGERED', 20)
    await event('golden-event-3', 'golden-rule-b', 'ACKNOWLEDGED', 30)
    const note = (id: string, userId: string, minutes: number, readAt: Date | null = null) =>
      db.notification.create({ data: { id, userId, type: 'alert', title: `Note ${id}`, createdAt: at(minutes), readAt } })
    await note('golden-note-1', 'golden-person', 10)
    await note('golden-note-2', 'golden-person', 20, at(5))
    await note('golden-note-other', 'someone-else', 30)
  })
  app = await goldenApp([{ plugin: syncLogsRoutes, prefix: '/api' }, { plugin: notificationsRoutes, prefix: '/api' }])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

const RULES = '/api/sync-logs/alerts/rules'
const EVENTS = '/api/sync-logs/alerts/events?status=ALL'

describe('P7 — alert rule writes: the routes answer exactly as before', () => {
  it('POST /api/sync-logs/alerts/rules: refusals, then a new rule', async () => {
    const base = { name: 'Gamma latency', metric: 'latencyP95', operator: 'gte', threshold: 900, notificationChannels: ['log'] }
    await expectGolden(app, 'rule-create-bad-metric', RULES, GOLDEN, { method: 'POST', payload: { ...base, metric: 'nope' } })
    await expectGolden(app, 'rule-create-bad-operator', RULES, GOLDEN, { method: 'POST', payload: { ...base, operator: 'eq' } })
    await expectGolden(app, 'rule-create-no-channels', RULES, GOLDEN, { method: 'POST', payload: { ...base, notificationChannels: [] } })
    await expectGolden(app, 'rule-create', RULES, GOLDEN, { method: 'POST', payload: { ...base, description: 'Slow calls', windowMinutes: 30, channel: 'AMAZON', enabled: false }, normalize: createdId })
    await expectGolden(app, 'rule-create-defaults', RULES, GOLDEN, { method: 'POST', payload: { ...base, name: 'Delta defaults' }, normalize: createdId })
  })

  it('PATCH /api/sync-logs/alerts/rules/:id: the fields it takes, and nothing else', async () => {
    await expectGolden(app, 'rule-patch', `${RULES}/golden-rule-b`, GOLDEN, {
      method: 'PATCH',
      payload: { name: 'Beta queue very deep', description: 'Backlog', threshold: 250, windowMinutes: 60, channel: null, notificationChannels: ['log', 'slack:#alerts'], enabled: false, metric: 'errorRate', operator: 'lt' },
    })
    await expectGolden(app, 'rule-patch-empty', `${RULES}/golden-rule-a`, GOLDEN, { method: 'PATCH', payload: {} })
    await expectGolden(app, 'rules-after-writes', RULES, GOLDEN, { normalize: createdId })
  })
})

describe('P7 — alert event writes: the routes answer exactly as before', () => {
  it('acknowledge, with and without a note; resolve, which also stops the rule counting as fired', async () => {
    await expectGolden(app, 'event-acknowledge', '/api/sync-logs/alerts/events/golden-event-1/acknowledge', GOLDEN, { method: 'POST', payload: { notes: 'on it', acknowledgedBy: 'Golden Person' } })
    await expectGolden(app, 'event-acknowledge-bare', '/api/sync-logs/alerts/events/golden-event-3/acknowledge', GOLDEN, { method: 'POST', payload: {} })
    await expectGolden(app, 'event-resolve', '/api/sync-logs/alerts/events/golden-event-2/resolve', GOLDEN, { method: 'POST', payload: { notes: 'drained', resolvedBy: 'Golden Person' } })
    await expectGolden(app, 'events-after-writes', EVENTS, GOLDEN, {})
    await expectGolden(app, 'rules-after-resolve', RULES, GOLDEN, { normalize: createdId })
  })
})

describe('P7 — marking a notification read: the route answers exactly as before', () => {
  it('your own unread one, again, a read one, and someone else’s', async () => {
    await expectGolden(app, 'note-read', '/api/notifications/golden-note-1/read', GOLDEN, { method: 'POST' })
    await expectGolden(app, 'note-read-again', '/api/notifications/golden-note-1/read', GOLDEN, { method: 'POST' })
    await expectGolden(app, 'note-read-already', '/api/notifications/golden-note-2/read', GOLDEN, { method: 'POST' })
    await expectGolden(app, 'note-read-other', '/api/notifications/golden-note-other/read', GOLDEN, { method: 'POST' })
    await expectGolden(app, 'notes-after-read', '/api/notifications', GOLDEN)
  })
})
