/**
 * 7b (review 3.11, I.7, 8.6) — one function for each count two screens show.
 *
 * "45 of 219 campaigns are under rank control" counted switched-off schedules as control and left out an archived
 * campaign every other screen counts (220); the Today board said every allowlisted campaign had a maximum bid whether
 * or not any did, and called a campaign "without a minimum" when a bid policy gave it one. The census answers each of
 * these once, and the Guardrails tab, the Control Room, the catalog's scope lines and Today read it.
 *
 * On a real PostgreSQL (PGlite, production schema), in one business.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
// The coverage route is read through the real advertising routes, which load the queue and the read cache.
vi.mock('../../lib/queue.js', () => {
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
vi.mock('./ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))

import { allowlistedBidBounds, campaignCensus, rankCensus } from './ads-census.service.js'
import { getAccountGuardrails } from './ads-control-room.service.js'
import { automationAdapter } from '../automation/automation-catalog.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const id: Record<string, string> = {}
let app: FastifyInstance

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await inside(async () => {
    const campaign = async (key: string, data: Record<string, unknown>) => {
      id[key] = (await db.campaign.create({
        data: { name: `TEST ${key}`, type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), externalCampaignId: `TEST-${key}`, marketplace: 'IT', ...data } as never,
      })).id
    }
    await campaign('itBare', { liveBidWritesEnabled: true })                          // allowlisted, no bound anywhere
    await campaign('itFloor', { liveBidWritesEnabled: true, minBidCents: 10 })         // its own floor
    await campaign('deCeiling', { liveBidWritesEnabled: true, marketplace: 'DE', maxBidCents: 200 }) // a DE policy floor
    await campaign('itOff', {})                                                        // not allowlisted
    await campaign('itArchived', { status: 'ARCHIVED' })
    await campaign('itPlanned', {})
    // A floor for DE from a market policy; a disabled one for IT that must not count.
    await db.adBidPolicy.create({ data: { grain: 'MARKET', scopeId: 'DE', label: 'Germany', minBidCents: 15 } })
    await db.adBidPolicy.create({ data: { grain: 'MARKET', scopeId: 'IT', label: 'Italy', minBidCents: 15, enabled: false } })

    const goal = [{ day: 1, hour: 9, targetKey: 'own-top' }]
    await db.adSchedule.create({ data: { name: 'A on', campaignId: id.itBare, windows: goal, enabled: true } as never })
    await db.adSchedule.create({ data: { name: 'B off', campaignId: id.itFloor, windows: goal, enabled: false } as never })
    await db.adSchedule.create({ data: { name: 'C classic on', campaignId: id.itOff, windows: [{ day: 1, hour: 9 }], enabled: true } as never })
    await db.adSchedule.create({ data: { name: 'D off but planned', campaignId: id.deCeiling, windows: goal, enabled: false } as never })
    const decisions = (ids: string[]) => ({ decisions: ids.map((campaignId) => ({ campaignId })) })
    await db.productRankPlan.create({ data: { productId: 'p1', marketplace: 'DE', enabled: true, lastSummary: decisions([id.deCeiling, id.itBare]) } as never })
    await db.productRankPlan.create({ data: { productId: 'p2', marketplace: 'IT', enabled: false, lastSummary: decisions([id.itPlanned]) } as never })
    await db.productRankPlan.create({ data: { productId: 'p3', marketplace: 'IT', enabled: true, manualOnly: true, lastSummary: decisions([]) } as never })
  })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

describe('campaignCensus', () => {
  it('counts every campaign, archived ones included, and says how many are archived', async () => {
    const c = await inside(() => campaignCensus())
    expect(c).toMatchObject({ total: 6, archived: 1, allowlisted: 3, withMinBid: 1, withMaxBid: 1 })
  })

  it('a bid policy floor counts as a floor, a disabled policy does not, and the maximum is counted apart', async () => {
    // itBare has none; itFloor has its own; deCeiling takes the DE policy's floor (the gate's own answer).
    expect(await inside(() => allowlistedBidBounds())).toEqual({ noMinBid: 1, noMinBidNoMax: 1 })
  })

  it('narrows every count to one market', async () => {
    expect(await inside(() => campaignCensus({ marketplace: 'DE' }))).toMatchObject({ total: 1, archived: 0, allowlisted: 1 })
    expect(await inside(() => campaignCensus({ marketplace: 'IT' }))).toMatchObject({ total: 5, archived: 1, allowlisted: 2 })
  })

  it('the Guardrails summary and the catalog scope line read it', async () => {
    const g = await inside(() => getAccountGuardrails())
    expect(g.campaigns).toEqual({ total: 6, managed: 3, unmanaged: 3 })
    expect(g.bounds).toEqual({ withMinBid: 1, withMaxBid: 1 })
    const autoBid = await inside(() => automationAdapter('A4')!.state())
    expect(autoBid.scope).toBe('May write to 3 of 6 campaigns (the live-write allowlist).')
  })
})

describe('rankCensus', () => {
  it('a switched-off schedule is not control; a plan wins a campaign whose schedule is off', async () => {
    const r = await inside(() => rankCensus())
    expect([...r.campaigns.bySchedule].sort()).toEqual([id.itBare, id.itOff].sort())
    expect([...r.campaigns.byPlan]).toEqual([id.deCeiling])
    expect([...r.campaigns.switchedOff]).toEqual([id.itFloor])
  })

  it('lists the hourly-plan rows (goal-mode schedules and plans) and how many run by themselves', async () => {
    const r = await inside(() => rankCensus())
    expect(r.schedules.map((s) => s.name)).toEqual(['A on', 'B off', 'D off but planned'])
    expect(r.plans.map((p) => [p.productId, p.on])).toEqual([['p1', true], ['p2', false], ['p3', false]])
    expect(r.rows).toEqual({ total: 6, on: 2 })
  })

  it("the catalog's hourly bid plans entry (A10) lists the same rows", async () => {
    const rows = await inside(() => automationAdapter('A10')!.rows!())
    const r = await inside(() => rankCensus())
    expect(rows).toHaveLength(r.rows.total)
    expect(rows.filter((x) => x.level === 'AUTO')).toHaveLength(r.rows.on)
  })
})

describe('the Rank & Dayparting coverage strip reads both', () => {
  beforeAll(async () => {
    const { default: advertisingRoutes } = await import('../../routes/advertising.routes.js')
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
    await app.register(advertisingRoutes, { prefix: '/api' })
    await app.ready()
  }, 120_000)
  const coverage = async (qs = '') => (await app.inject({ method: 'GET', url: `/api/advertising/rank-schedule-groups/coverage${qs}` })).json()

  it('states the same total as every screen, and a switched-off schedule is not "under rank control"', async () => {
    const c = await coverage()
    expect(c).toMatchObject({ total: 6, archived: 1, covered: 2, governed: 1, switchedOff: 1, uncovered: 1 })
    // Every campaign is in exactly one bucket.
    expect(c.covered + c.governed + c.switchedOff + c.uncovered + c.archived).toBe(c.total)
    // The list to add from is unchanged: only campaigns that hold no schedule and no plan.
    expect(c.items.map((i: { id: string }) => i.id)).toEqual([id.itPlanned])
  })

  it('one market narrows the total the same way the census does', async () => {
    const c = await coverage('?marketplace=IT')
    expect(c).toMatchObject({ total: 5, archived: 1, covered: 2, governed: 0, switchedOff: 1, uncovered: 1 })
  })
})
