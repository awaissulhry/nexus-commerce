/**
 * ADS AUTONOMY W4-1 — PATCH /advertising/rank-schedule-groups/:id WITHOUT campaignIds (the lightweight path the Hourly
 * Bids list uses to rename a plan and to switch it on or off) answers byte for byte as before its logic moved into
 * patchRankScheduleGroup (rank-schedule-group.service.ts), which Claude's set-hourly-bid-plan uses to rename and switch
 * ONE plan: one path for both. Switching off still gives back what the plan floored (2a) and writes a version (RD.P7).
 *
 * On a real PostgreSQL (PGlite). The snapshot beside this file was WRITTEN BY THE ROUTE BEFORE THE MOVE and is read
 * unchanged after it: every answer, the plan's version rows and its members' switches after each call.
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
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

const WEEK = [{ days: [1, 2, 3, 4, 5], startHour: 18, endHour: 22, targetKey: 'own-top' }]
let app: FastifyInstance
let planId = ''
beforeAll(async () => {
  database = await formulaDatabase()
  const { default: advertisingRoutes } = await import('./advertising.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
  await inside(async () => {
    const db = database.client
    const campaign = (name: string, ext: string) => db.campaign.create({ data: { name, type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: ext, status: 'ENABLED' } })
    const a = await campaign('PARITY CAMPAIGN A', 'TEST-CMP-A')
    const b = await campaign('PARITY CAMPAIGN B', 'TEST-CMP-B')
    const plan = await db.rankScheduleGroup.create({ data: { name: 'PARITY plan', marketplace: 'IT', windows: WEEK, defaultTargetKey: 'rest-of-search', enabled: true } })
    planId = plan.id
    for (const c of [a, b]) {
      await db.adSchedule.create({ data: { campaignId: c.id, name: `${c.name} — PARITY plan`, windows: WEEK, defaultTargetKey: 'rest-of-search', enabled: true, groupId: plan.id } })
    }
    await db.rankScheduleGroup.create({ data: { name: 'PARITY twin', marketplace: 'IT', windows: [], enabled: false } })
  })
}, 180_000)
afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

describe('W4-1 — the lightweight PATCH answers as before the move', () => {
  it('every outcome, the versions it writes and the members it switches', async () => {
    const answers: string[] = []
    const send = async (payload: object, actor?: string) => {
      const res = await app.inject({ method: 'PATCH', url: `/api/advertising/rank-schedule-groups/${planId}`, payload, headers: actor ? { 'x-actor-id': actor } : {} })
      answers.push(`${res.statusCode} ${normalise(res.body)}`)
    }
    await send({})
    await send({ name: '   ' })
    await send({ name: 'PARITY twin' })
    await send({ name: ' PARITY plan renamed ', ignored: true }, 'u-parity')
    // Switched off: the members follow and the plan gives back what it floored (nothing here), with a version.
    await send({ enabled: false })
    await send({ enabled: true }, 'u-parity')
    // Unchanged: no new version.
    await send({ enabled: true }, 'u-parity')
    await send({ windows: [], defaultTargetKey: 'own-top', timezone: 'Europe/Berlin' }, 'u-parity')
    const [versions, members] = await inside(() => Promise.all([
      database.client.rankScheduleVersion.findMany({ where: { groupId: planId }, orderBy: { createdAt: 'asc' }, select: { name: true, enabled: true, campaignCount: true, defaultTargetKey: true, windows: true, changedBy: true } }),
      database.client.adSchedule.findMany({ where: { groupId: planId }, orderBy: { name: 'asc' }, select: { name: true, enabled: true, windows: true, defaultTargetKey: true } }),
    ]))
    answers.push(`versions ${JSON.stringify(versions)}`, `members ${JSON.stringify(members)}`)
    expect(answers.join('\n')).toMatchSnapshot()
  })

  it('a plan that is not there: a 500 with the database\'s words', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/advertising/rank-schedule-groups/nope', payload: { enabled: true } })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).error).toMatch(/No record was found for an update|not found/i)
  })
})
