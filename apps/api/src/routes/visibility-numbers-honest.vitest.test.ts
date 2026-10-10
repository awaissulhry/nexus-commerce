/**
 * Amazon's free visibility numbers, honest everywhere (2026-10-10) — the routes of lane 1, on a real PostgreSQL (PGlite,
 * production schema) with the real advertising routes. Fake keywords, ASINs and round numbers only.
 *
 *   K1/K2  POST /advertising/keyword-ranks refuses a rank below 1 and a row with no capturedAt (nothing half-stored).
 *   B5     GET  /advertising/keyword-ranks: per keyword × market × ASIN, a rank reading represents the item, ageDays/stale.
 *   B2/S1  GET  /advertising/search-query-performance: shares from the counts (null with no market count), WEEK by
 *          default, minImpressionShare on the computed share.
 *   B6     GET  /advertising/share-of-voice: impressionMixPct (our own impression mix), with the note.
 *   C3     GET  /advertising/rank-targets: targetISPct is said to be unused since 2e.
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
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client as any
let app: FastifyInstance

const DAY = 86_400_000
const weeksAgo = (n: number) => { const d = new Date(Date.now() - n * 7 * DAY); d.setUTCHours(0, 0, 0, 0); return d }

beforeAll(async () => {
  database = await formulaDatabase()
  const [{ default: advertisingRoutes }, { default: advertisingIntelRoutes }] = await Promise.all([
    import('./advertising.routes.js'),
    import('./advertising-intel.routes.js'),
  ])
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.register(advertisingIntelRoutes, { prefix: '/api' })
  await app.ready()

  const sqp = (over: Record<string, unknown>) => ({
    marketplace: 'IT', reportPeriod: 'WEEK', startDate: weeksAgo(2), searchQuery: 'test jacket', asin: 'B0VISTEST1',
    searchQueryVolume: 1000, searchQueryRank: 3, impressionsTotal: 0, impressionsBrand: 0, clicksTotal: 0, clicksBrand: 0,
    cartAddsTotal: 0, cartAddsBrand: 0, purchasesTotal: 0, purchasesBrand: 0, ...over,
  })
  await inside(async () => {
    await db().searchQueryPerformance.createMany({
      data: [
        // A real 20 % impression share, a real 0 % click share (none of a real total), purchases not reported.
        sqp({ impressionsTotal: 1000, impressionsBrand: 200, clicksTotal: 50, clicksBrand: 0 }),
        // Nothing reported for the market: every stored share column holds a false 0.
        sqp({ searchQuery: 'test gloves', searchQueryVolume: 0 }),
        // A small real share.
        sqp({ searchQuery: 'test boots', impressionsTotal: 1000, impressionsBrand: 10 }),
        // A MONTH row of the same query: another period, not mixed into a WEEK read.
        sqp({ reportPeriod: 'MONTH', startDate: weeksAgo(3), impressionsTotal: 4000, impressionsBrand: 3000 }),
      ],
    })
    await db().amazonAdsSearchTerm.createMany({
      data: [
        { profileId: 'P-VIS-TEST', adProduct: 'SPONSORED_PRODUCTS', currencyCode: 'EUR', date: new Date(Date.now() - 2 * DAY), marketplace: 'IT', campaignId: 'cmp-1', adGroupId: 'ag-1', query: 'test jacket', impressions: 300, clicks: 3, costMicros: BigInt(1_500_000) },
        { profileId: 'P-VIS-TEST', adProduct: 'SPONSORED_PRODUCTS', currencyCode: 'EUR', date: new Date(Date.now() - 2 * DAY), marketplace: 'IT', campaignId: 'cmp-1', adGroupId: 'ag-1', query: 'test gloves', impressions: 700, clicks: 7, costMicros: BigInt(3_500_000) },
      ],
    })
  })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

describe('POST /advertising/keyword-ranks — K1, K2', () => {
  it('refuses a rank below 1 and a row with no capturedAt; nothing of that import is stored', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/advertising/keyword-ranks',
      payload: { ranks: [
        { keyword: 'test helmet', marketplace: 'IT', organicRank: 0, capturedAt: new Date().toISOString() },
        { keyword: 'test helmet', marketplace: 'IT', organicRank: 5 },
        { keyword: 'test helmet', marketplace: 'IT', organicRank: 6, capturedAt: new Date().toISOString() },
      ] },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.refused.map((r: { index: number }) => r.index)).toEqual([0, 1])
    expect(await inside(() => db().keywordRank.count({ where: { keyword: 'test helmet' } }))).toBe(0)
  })

  it('stores a valid import with the time it says', async () => {
    const at = new Date(Date.now() - 3 * DAY).toISOString()
    const res = await app.inject({ method: 'POST', url: '/api/advertising/keyword-ranks', payload: { ranks: [{ keyword: 'test helmet', marketplace: 'it', asin: 'B0VISTEST1', organicRank: 7, capturedAt: at }] } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ingested: 1 })
    const row = await inside(() => db().keywordRank.findFirst({ where: { keyword: 'test helmet' } }))
    expect(row).toMatchObject({ marketplace: 'IT', organicRank: 7 })
    expect(row.capturedAt.toISOString()).toBe(at)
  })
})

describe('GET /advertising/keyword-ranks — B5', () => {
  it('one item per keyword × market × ASIN, a rank reading over the newer volume-only feed row, with ageDays and stale', async () => {
    await inside(() => db().keywordRank.createMany({
      data: [
        { keyword: 'test visor', marketplace: 'IT', asin: null, searchVolume: 400, capturedAt: new Date(Date.now() - 1 * DAY), source: 'brand-analytics-sqp' },
        { keyword: 'test visor', marketplace: 'IT', asin: null, organicRank: 9, capturedAt: new Date(Date.now() - 2 * DAY), source: 'manual' },
        { keyword: 'test visor', marketplace: 'IT', asin: 'B0VISTEST2', organicRank: 30, capturedAt: new Date(Date.now() - 20 * DAY), source: 'manual' },
      ],
    }))
    const res = await app.inject({ method: 'GET', url: '/api/advertising/keyword-ranks?marketplace=IT' })
    expect(res.statusCode).toBe(200)
    const items = (res.json().items as Array<Record<string, unknown>>).filter((i) => i.keyword === 'test visor')
    expect(items).toHaveLength(2)
    expect(items.find((i) => i.asin === null)).toMatchObject({ organicRank: 9, searchVolume: 400, ageDays: 2, stale: false })
    expect(items.find((i) => i.asin === 'B0VISTEST2')).toMatchObject({ organicRank: 30, ageDays: 20, stale: true, rankDelta: null })
  })
})

describe('GET /advertising/search-query-performance — B2, S1', () => {
  it('shares come from the counts: null with no market count, a real 0 stays 0; WEEK only by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/advertising/search-query-performance?marketplace=IT' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.reportPeriod).toBe('WEEK')
    const byQuery = new Map((body.items as Array<Record<string, unknown>>).map((i) => [i.searchQuery, i]))
    expect(byQuery.size).toBe(3) // the MONTH row is another period
    expect(byQuery.get('test jacket')).toMatchObject({ reportPeriod: 'WEEK', impressionShare: 0.2, clickShare: 0, cartAddShare: null, purchaseShare: null })
    expect(byQuery.get('test gloves')).toMatchObject({ impressionShare: null, clickShare: null, searchQueryVolume: null })
    expect(body.note).toContain('Search Query Score')
  })

  it('reportPeriod=MONTH reads that period only; an unknown period is refused', async () => {
    const month = (await app.inject({ method: 'GET', url: '/api/advertising/search-query-performance?marketplace=IT&reportPeriod=month' })).json()
    expect(month.items).toHaveLength(1)
    expect(month.items[0]).toMatchObject({ reportPeriod: 'MONTH', impressionShare: 0.75 })
    expect((await app.inject({ method: 'GET', url: '/api/advertising/search-query-performance?reportPeriod=YEAR' })).statusCode).toBe(400)
  })

  it('minImpressionShare filters on the computed share: a null never passes, a small real share is compared', async () => {
    const some = (await app.inject({ method: 'GET', url: '/api/advertising/search-query-performance?marketplace=IT&minImpressionShare=0.005' })).json()
    expect(some.items.map((i: { searchQuery: string }) => i.searchQuery).sort()).toEqual(['test boots', 'test jacket'])
    const any = (await app.inject({ method: 'GET', url: '/api/advertising/search-query-performance?marketplace=IT&minImpressionShare=0' })).json()
    expect(any.items.map((i: { searchQuery: string }) => i.searchQuery)).not.toContain('test gloves')
    const high = (await app.inject({ method: 'GET', url: '/api/advertising/search-query-performance?marketplace=IT&minImpressionShare=0.5' })).json()
    expect(high.items).toEqual([])
  })
})

describe('GET /advertising/share-of-voice — B6', () => {
  it('impressionMixPct (our own impression mix) replaces sovPct, and the answer says what it is', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/advertising/share-of-voice?marketplace=IT' })).json()
    expect(body.note).toContain('our own impression mix (our search-term impressions only), not a market share')
    const jacket = body.rows.find((r: { query: string }) => r.query === 'test jacket')
    expect(jacket.impressionMixPct).toBeCloseTo(0.3, 10)
    expect(jacket).not.toHaveProperty('sovPct')
  })
})

describe('GET /advertising/rank-targets — C3', () => {
  it('says targetISPct is not used since 2e; the stored goals stay', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/advertising/rank-targets' })).json()
    expect(body.notes.targetISPct).toContain('not used: the Hourly Bids plan reads no share')
    expect(body.items.find((t: { key: string }) => t.key === 'own-top')).toMatchObject({ targetISPct: 70 })
  })
})
