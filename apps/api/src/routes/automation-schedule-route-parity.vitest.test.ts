/**
 * R10 (MCP full control, part 06) — PATCH /advertising/schedules/:id answers byte for byte as before its logic moved into
 * patchAdSchedule (ads-schedule.service.ts), which turn-down-automation uses to switch a dayparting schedule off: the
 * same resume of a campaign the schedule left paused (RC2.T3), never a second path.
 *
 * On a real PostgreSQL (PGlite). The snapshot beside this file was WRITTEN BY THE ROUTE BEFORE THE MOVE and is read
 * unchanged after it.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const ids = new Map<string, string>()
const normalise = (text: string) => text
  .replace(/\bc[a-z0-9]{24}\b/g, (id) => (ids.has(id) ? ids.get(id)! : (ids.set(id, `<id${ids.size + 1}>`), ids.get(id)!)))
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')

let app: FastifyInstance
const rows: Record<string, string> = {}
beforeAll(async () => {
  database = await formulaDatabase()
  const { default: advertisingRoutes } = await import('./advertising.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
  await withWorkspace(business, async () => {
    const campaign = await database.client.campaign.create({ data: { name: 'PARITY CAMPAIGN', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-CMP-1', status: 'PAUSED' } })
    rows.paused = (await database.client.adSchedule.create({ data: { campaignId: campaign.id, name: 'PARITY night', windows: [{ days: [1], startHour: 0, endHour: 6 }], enabled: true, lastApplied: 'PAUSED' } })).id
  })
}, 180_000)
afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

describe('R10 — the schedule route answers as before the move', () => {
  it('every outcome', async () => {
    const answers: string[] = []
    const send = async (id: string, payload: object) => {
      const res = await app.inject({ method: 'PATCH', url: `/api/advertising/schedules/${id}`, payload })
      answers.push(`${res.statusCode} ${normalise(res.body)}`)
    }
    await send('nope', { enabled: false })
    await send(rows.paused, { name: 'PARITY night (renamed)', timezone: 'Europe/Rome', ignored: true })
    // Disabled while it holds the campaign paused: the campaign is resumed first.
    await send(rows.paused, { enabled: false })
    await send(rows.paused, { enabled: true })
    expect(answers.join('\n')).toMatchSnapshot()
  })
})
