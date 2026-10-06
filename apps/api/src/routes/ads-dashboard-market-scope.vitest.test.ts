/**
 * W3-C — one market scope per page, and a Rules count its dialog can list.
 *
 * AM-15: the Dashboard's market picker fed Spend/Sales (trends) and alerts, but `GET /advertising/summary` (Campaigns,
 *        True margin) took no market and `GET /advertising/momentum` (Top movers, placements) ignored the one it was
 *        sent. Choosing DE showed DE spend beside every market's campaign count and Italian movers.
 * AM-12: the Ad Manager's Rules cell counted the account-wide rules, but `guardrail-grid` sent only their number, so
 *        the dialog could not list them. It now sends them by name, with the one market a rule may name.
 *
 * On a real PostgreSQL (PGlite) with the real advertising routes. Fake ids and names only.
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

const DAY = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 2))
const YMD = DAY.toISOString().slice(0, 10)

beforeAll(async () => {
  database = await formulaDatabase()
  const { default: advertisingRoutes } = await import('./advertising.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
  await withWorkspace(business, async () => {
    const campaign = (id: string, marketplace: string, status: string) => db().campaign.create({
      data: { id, name: `Test ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', status, dailyBudget: '5.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace, externalCampaignId: `EXT-${id}` },
    })
    await campaign('it-1', 'IT', 'ENABLED')
    await campaign('it-2', 'IT', 'PAUSED')
    await campaign('it-3', 'IT', 'ENABLED')
    await campaign('de-1', 'DE', 'ENABLED')

    // True margin: IT makes 20 %, DE loses 10 %.
    const product = await db().product.create({ data: { sku: 'W3C-SKU', name: 'W3C test product', basePrice: 10 }, select: { id: true } })
    await db().productProfitDaily.create({ data: { productId: product.id, marketplace: 'IT', date: DAY, grossRevenueCents: 10_000, trueProfitCents: 2_000 } })
    await db().productProfitDaily.create({ data: { productId: product.id, marketplace: 'DE', date: DAY, grossRevenueCents: 10_000, trueProfitCents: -1_000 } })

    // Momentum: IT sold more than DE that day; each market has its own placement split.
    const perf = (id: string, marketplace: string, salesCents: number) => db().amazonAdsDailyPerformance.create({
      data: { profileId: `P-${marketplace}`, marketplace, adProduct: 'SPONSORED_PRODUCTS', date: DAY, entityType: 'CAMPAIGN', entityId: `EXT-${id}`, localEntityId: id, costMicros: 1_000_000n, sales7dCents: salesCents, orders7d: 1, currencyCode: 'EUR', reportedAt: new Date() },
    })
    await perf('it-1', 'IT', 9_000)
    await perf('de-1', 'DE', 3_000)
    const placement = (marketplace: string, campaignId: string, placementName: string, salesCents: number) => db().amazonAdsPlacementReport.create({
      data: { profileId: `P-${marketplace}`, marketplace, adProduct: 'SPONSORED_PRODUCTS', date: DAY, campaignId, placement: placementName, costMicros: 500_000n, currencyCode: 'EUR', sales7dCents: salesCents },
    })
    await placement('IT', 'EXT-it-1', 'Top of Search on-Amazon', 9_000)
    await placement('DE', 'EXT-de-1', 'Other on-Amazon', 3_000)

    // Rules: two account-wide (one names DE only), one bound to it-1, one switched off.
    const rule = (name: string, extra: Record<string, unknown>) => db().automationRule.create({
      data: { domain: 'advertising', name, trigger: 'TARGET_PERFORMANCE', enabled: true, autonomyLevel: 'PROPOSE', conditions: [], actions: [], ...extra },
    })
    await rule('W3C all markets', {})
    await rule('W3C DE only', { scopeMarketplace: 'DE' })
    await rule('W3C bound', { scopeCampaignId: 'it-1', autonomyLevel: 'AUTO' })
    await rule('W3C off', { enabled: false })
  })
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() })

const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url })
  expect(res.statusCode, url).toBe(200)
  return res.json() as Record<string, any>
}

describe('AM-15 — GET /advertising/summary follows the market', () => {
  it('no market: every market, as before', async () => {
    const s = await get('/api/advertising/summary')
    expect(s.campaignCount).toBe(4)
    expect(s.trueProfitMargin30dPct).toBeCloseTo(5)
  })

  it('a market: its own campaigns and its own true margin', async () => {
    const de = await get('/api/advertising/summary?marketplace=DE')
    expect(de.campaignCount).toBe(1)
    expect(de.trueProfitMargin30dPct).toBeCloseTo(-10)
    const it_ = await get('/api/advertising/summary?marketplace=IT')
    expect(it_.campaignCount).toBe(3)
    expect(it_.trueProfitMargin30dPct).toBeCloseTo(20)
  })
})

describe('AM-15 — GET /advertising/momentum follows the market', () => {
  it('no market: both markets\' movers and placements', async () => {
    const m = await get('/api/advertising/momentum')
    expect(m.date).toBe(YMD)
    expect(m.campaigns.map((c: { id: string }) => c.id)).toEqual(['it-1', 'de-1'])
    expect(m.counts).toEqual({ enabled: 3, paused: 1 })
    expect(m.placements.map((p: { placement: string }) => p.placement).sort()).toEqual(['Other on-Amazon', 'Top of Search on-Amazon'])
  })

  it('DE: only DE movers, DE counts and DE placements (it showed Italian movers before)', async () => {
    const m = await get('/api/advertising/momentum?marketplace=DE')
    expect(m.campaigns.map((c: { id: string }) => c.id)).toEqual(['de-1'])
    expect(m.counts).toEqual({ enabled: 1, paused: 0 })
    expect(m.placements.map((p: { placement: string }) => p.placement)).toEqual(['Other on-Amazon'])
  })

  it('a market with no rows has no latest day, rather than another market\'s', async () => {
    const m = await get('/api/advertising/momentum?marketplace=FR')
    expect(m.date).toBeNull()
    expect(m.campaigns).toEqual([])
  })
})

describe('AM-12 — guardrail-grid lists the account-wide rules it counts', () => {
  it('the switched-on rules that name no campaign or portfolio, by name, with the market a rule names', async () => {
    const g = await get('/api/advertising/control-room/guardrail-grid?limit=500')
    expect(g.accountWideRules).toBe(2)
    expect(g.accountWideRuleList.map((r: Record<string, unknown>) => [r.name, r.level, r.scopeMarketplace])).toEqual([
      ['W3C DE only', 'PROPOSE', 'DE'], // by name, as the database sorts it
      ['W3C all markets', 'PROPOSE', null],
    ])
    expect(g.accountWideRuleList).toHaveLength(g.accountWideRules)
    const bound = g.rows.find((r: { id: string }) => r.id === 'it-1').boundRules
    expect(bound.map((r: Record<string, unknown>) => [r.name, r.level, r.enabled])).toEqual([['W3C bound', 'AUTO', true]])
  })
})
