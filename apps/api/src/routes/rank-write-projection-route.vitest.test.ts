/**
 * 2c (review G.11) — GET /advertising/rank-schedule-groups/write-projection: about how many changes a day each hourly
 * bid plan sends to Amazon. The arithmetic is pinned in rank-write-projection.vitest.test.ts; this proves the wiring —
 * each member's own schedule row and target overrides, its ad groups and positive targets (negatives carry no bid).
 *
 * On a real PostgreSQL (PGlite) with the real advertising routes. It reads only.
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
const db = () => database.client as any
let app: FastifyInstance

// Min bid 00–07, Top +100% 12–14, Top +50% the rest of the week.
const WINDOWS = [{ days: [], startHour: 0, endHour: 7, targetKey: 'minbid' }, { days: [], startHour: 12, endHour: 14, targetKey: 'top100' }]

async function campaign(id: string, targets: number, negatives = 0) {
  await db().campaign.create({ data: { id, name: id, type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: `EXT-${id}` } })
  await db().adGroup.create({ data: { id: `${id}-g`, campaignId: id, name: `${id}-g`, defaultBidCents: 40 } })
  for (let i = 0; i < targets + negatives; i++) {
    await db().adTarget.create({ data: { id: `${id}-t${i}`, adGroupId: `${id}-g`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `${id} kw ${i}`, bidCents: 35, isNegative: i >= targets } })
  }
}

beforeAll(async () => {
  database = await formulaDatabase()
  const { default: advertisingRoutes } = await import('./advertising.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
  await withWorkspace(business, async () => {
    await db().rankTarget.create({ data: { key: 'top50', name: 'Top +50%', biasPct: 50 } })
    await db().rankTarget.create({ data: { key: 'top100', name: 'Top +100%', biasPct: 100 } })
    await db().rankTarget.create({ data: { key: 'minbid', name: 'Min bid', pause: true, floorBidCents: 2 } })
    await db().rankScheduleGroup.create({ data: { id: 'g1', name: 'Night floor', windows: WINDOWS, defaultTargetKey: 'top50' } })
    await db().rankScheduleGroup.create({ data: { id: 'g2', name: 'Flat', windows: [], defaultTargetKey: 'top50' } })
    await campaign('wa', 2, 1) // 1 ad group + 2 keywords (the negative carries no bid) = 3 bids
    await campaign('wb', 0) // 1 ad group = 1 bid
    await campaign('wc', 5)
    await db().adSchedule.create({ data: { id: 'wa-s', groupId: 'g1', campaignId: 'wa', name: 'wa-s', windows: WINDOWS, defaultTargetKey: 'top50' } })
    // Its own override makes Top +100% hold 50% on this campaign: those two hours change nothing for it.
    await db().adSchedule.create({ data: { id: 'wb-s', groupId: 'g1', campaignId: 'wb', name: 'wb-s', windows: WINDOWS, defaultTargetKey: 'top50', targetOverrides: { top100: { biasPct: 50 } } } })
    await db().adSchedule.create({ data: { id: 'wc-s', groupId: 'g2', campaignId: 'wc', name: 'wc-s', windows: [], defaultTargetKey: 'top50' } })
  })
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() })

describe('GET /advertising/rank-schedule-groups/write-projection', () => {
  it('sums each plan over its members, with each member\'s own bids and overrides', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/advertising/rank-schedule-groups/write-projection' })
    expect(res.statusCode).toBe(200)
    const { items } = res.json() as { items: Record<string, { perDay: number; perWeek: number; byKind: Record<string, number>; campaigns: number }> }
    // wa: 3 bids floored + 3 given back, 2 placement changes, a day = 8; wb: 1 + 1, no placement change = 2.
    expect(items.g1).toMatchObject({ campaigns: 2, perWeek: 7 * 10, perDay: 10, byKind: { restore: 28, suppress: 28, placement: 14, base: 0 } })
    expect(items.g2).toMatchObject({ campaigns: 1, perWeek: 0, perDay: 0 })
  })

  it('narrows to one plan for the builder', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/advertising/rank-schedule-groups/write-projection?groupId=g2' })
    expect(Object.keys((res.json() as { items: object }).items)).toEqual(['g2'])
  })
})
