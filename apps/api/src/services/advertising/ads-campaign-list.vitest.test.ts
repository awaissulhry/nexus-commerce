/**
 * MCP full control A1 — the Amazon campaign list moved out of `GET /advertising/campaigns` into
 * `ads-campaign-list.service.ts` with no behaviour change. The move was proven byte-equal on 14 route calls against
 * the code before it; these arms keep it so:
 *   · the service answers what the list always answered (stored columns, filters, placements, window metrics);
 *   · the route answers exactly the service's result, with its Cache-Control header.
 * PGlite with the production schema; the ads read cache is a pass-through.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => Reflect.get(database.client, p) }) }))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: null,
  }
})
const cacheRefresh: boolean[] = []
vi.mock('./ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>, opts?: { refresh?: boolean }) => { cacheRefresh.push(opts?.refresh === true); return work() },
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))

import { listAmazonCampaigns } from './ads-campaign-list.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const day = (d: string) => new Date(`${d}T00:00:00Z`)
const SEPTEMBER = { startDate: '2026-09-01', endDate: '2026-09-30' }
let app: FastifyInstance

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await inside(async () => {
    await db.campaign.create({ data: { id: 'a1-c1', name: 'Alpha IT', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-A1-C1', dailyBudget: '10.00', startDate: day('2026-01-01'), spend: '12.30', sales: '45.60', impressions: 1000, clicks: 20,
      dynamicBidding: { placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 50 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 10 }], targetAcos: 0.3, bidAutomation: true } } as never })
    await db.campaign.create({ data: { id: 'a1-c2', name: 'Beta DE', type: 'SB', adProduct: 'SPONSORED_BRANDS', marketplace: 'DE', externalCampaignId: 'EXT-A1-C2', dailyBudget: '20.00', startDate: day('2026-01-01') } as never })
    await db.campaign.create({ data: { id: 'a1-c3', name: 'Test search IT', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-A1-C3', dailyBudget: '5.00', startDate: day('2026-01-01'), status: 'PAUSED' } as never })
    const perf = (data: Record<string, unknown>) => db.amazonAdsDailyPerformance.create({ data: { profileId: 'P1', currencyCode: 'EUR', entityType: 'CAMPAIGN', reportedAt: day('2026-09-20'), ...data } as never })
    // Alpha, linked: two September days (budget 10 then 20 EUR) and one August day outside the window.
    await perf({ marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: day('2026-09-10'), entityId: 'EXT-A1-C1', localEntityId: 'a1-c1', impressions: 100, clicks: 7, costMicros: 1_230_000n, sales7dCents: 1000, orders7d: 2, units7d: 3, salesSameSku7dCents: 600, ordersSameSku7d: 1, unitsSameSku7d: 2, campaignBudgetCents: 1000 })
    await perf({ marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: day('2026-09-11'), entityId: 'EXT-A1-C1', localEntityId: 'a1-c1', impressions: 50, clicks: 3, costMicros: 770_000n, sales7dCents: 0, orders7d: 0, campaignBudgetCents: 2000 })
    await perf({ marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: day('2026-08-01'), entityId: 'EXT-A1-C1', localEntityId: 'a1-c1', impressions: 5000, clicks: 500, costMicros: 50_000_000n, sales7dCents: 5000 })
    // Beta, not linked locally: a report row counts by its Amazon id; the Marketing Stream's daily row does not.
    await perf({ marketplace: 'DE', adProduct: 'SPONSORED_BRANDS', date: day('2026-09-10'), entityId: 'EXT-A1-C2', localEntityId: null, reportRunId: 'RUN-1', impressions: 40, clicks: 2, costMicros: 300_000n, sales7dCents: 900, sales14dCents: 1800, orders7d: 1, ntbOrders14d: 1, ntbSalesCents14d: 400 })
    await perf({ marketplace: 'DE', adProduct: 'SPONSORED_BRANDS', date: day('2026-09-11'), entityId: 'EXT-A1-C2', localEntityId: null, reportRunId: 'ams-stream', impressions: 999, clicks: 99, costMicros: 9_990_000n, sales7dCents: 9999 })
    for (const [date, impressions, share] of [['2026-09-10', 80, '0.25'], ['2026-09-11', 20, '0.75']] as const) {
      await db.amazonAdsPlacementReport.create({ data: { profileId: 'P1', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: day(date), campaignId: 'EXT-A1-C1', placement: 'Top of Search', impressions, currencyCode: 'EUR', topOfSearchIS: share } as never })
    }
  })
  app = Fastify()
  app.addHook('preHandler', (_r, _p, done) => { withWorkspace(business, done) })
  const { default: advertisingRoutes } = await import('../../routes/advertising.routes.js')
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() })

type Item = Record<string, any>
const list = async (q: Record<string, string>) => (await inside(() => listAmazonCampaigns(q))) as { items: Item[]; count: number; range: unknown }

describe('listAmazonCampaigns — the stored columns (no date params)', () => {
  it('lists by market then name, with the placements taken out of dynamicBidding', async () => {
    const out = await list({})
    expect(out.range).toBeNull()
    expect(out.items.map((c) => c.id)).toEqual(['a1-c2', 'a1-c1', 'a1-c3'])
    const alpha = out.items[1]
    expect(alpha).toMatchObject({ name: 'Alpha IT', impressions: 1000, clicks: 20, placements: { tos: 50, pdp: 10, ros: null }, targetAcos: 0.3, bidAutomation: true, bidAlgorithm: null })
    expect(Number(alpha.spend)).toBe(12.3)
    expect(alpha).not.toHaveProperty('dynamicBidding')
    expect(out.items[0]).toMatchObject({ placements: { tos: null, pdp: null, ros: null }, targetAcos: null, bidAutomation: false })
  })

  it('filters by market, status and name, and keeps the limit', async () => {
    expect((await list({ marketplace: 'IT', status: 'ENABLED' })).items.map((c) => c.id)).toEqual(['a1-c1'])
    expect((await list({ search: 'TEST' })).items.map((c) => c.id)).toEqual(['a1-c3'])
    expect((await list({ limit: '1' })).count).toBe(1)
  })
})

describe('listAmazonCampaigns — a date window', () => {
  it('derives the metrics for the window from the daily rows', async () => {
    const out = await list(SEPTEMBER)
    expect(out.range).toEqual({ startDate: '2026-09-01', endDate: '2026-09-30', preset: 'custom' })
    const byId = Object.fromEntries(out.items.map((c) => [c.id, c]))
    // Alpha: two September days; August is outside. Spend 1.23 + 0.77, sales 10.
    expect(byId['a1-c1']).toMatchObject({ impressions: 150, clicks: 10, spend: 2, sales: 10, acos: 0.2, roas: 5, ppcOrders: 2, saleUnits: 3,
      sameSkuSales: 6, otherSales: 4, otherSalesPct: 0.4, topOfSearchIS: 0.35, topOfSearchISDays: 2, avgBudgetUtilDays: 2, ntbOrders: null })
    expect(byId['a1-c1'].avgBudgetUtil).toBeCloseTo((123 / 1000 + 77 / 2000) / 2, 10)
    // Beta: its report row by Amazon id; the Marketing Stream row (999 impressions) is not added. Headline sales are
    // sales7dCents only (the 14-day window is never added). SB publishes NTB; SP does not (Alpha: null).
    expect(byId['a1-c2']).toMatchObject({ impressions: 40, clicks: 2, spend: 0.3, sales: 9, ntbOrders: 1, ntbSales: 4, ntbOrdersPct: 1, curBudgetUtilState: 'unsupported' })
    // Nothing reported: zeros for the counters, unknown (null) for what Amazon never reported.
    expect(byId['a1-c3']).toMatchObject({ impressions: 0, spend: 0, acos: null, saleUnits: null, avgBudgetUtil: null, topOfSearchIS: null })
  })
})

// AM-5 / AM-14 — a range reaching today adds the hourly stream, exactly as the campaign page does, and the list says
// when the daily report it shows arrived.
describe('listAmazonCampaigns — today, and when the numbers arrived', () => {
  const todayUtc = new Date().toISOString().slice(0, 10)
  const yesterdayUtc = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const RECEIVED = new Date(`${todayUtc}T03:12:00Z`)
  beforeAll(async () => {
    const db = database.client
    await inside(async () => {
      const hour = (data: Record<string, unknown>) => db.amazonAdsHourlyPerformance.create({ data: {
        profileId: 'P1', adProduct: 'SPONSORED_PRODUCTS', entityType: 'CAMPAIGN', currencyCode: 'EUR', date: day(todayUtc),
        reportRunId: 'ams-stream', reportedAt: new Date(), ...data } as never })
      // Alpha, linked by the stream: two hours today. Beta, never linked: counts by its Amazon id.
      await hour({ marketplace: 'IT', hour: 6, entityId: 'EXT-A1-C1', localEntityId: 'a1-c1', impressions: 30, clicks: 3, costMicros: 450_000n, sales7dCents: 2000, orders7d: 1 })
      await hour({ marketplace: 'IT', hour: 9, entityId: 'EXT-A1-C1', localEntityId: 'a1-c1', impressions: 20, clicks: 1, costMicros: 150_000n, sales7dCents: 0, orders7d: 0 })
      await hour({ marketplace: 'DE', adProduct: 'SPONSORED_BRANDS', hour: 7, entityId: 'EXT-A1-C2', localEntityId: null, impressions: 10, clicks: 1, costMicros: 200_000n, sales7dCents: 500, orders7d: 1 })
      // Yesterday's daily report for Alpha, received early this morning; the stream's own daily row is not a report.
      await db.amazonAdsDailyPerformance.create({ data: { profileId: 'P1', currencyCode: 'EUR', entityType: 'CAMPAIGN', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS',
        date: day(yesterdayUtc), entityId: 'EXT-A1-C1', localEntityId: 'a1-c1', reportRunId: 'RUN-Y', reportedAt: RECEIVED, impressions: 70, clicks: 5, costMicros: 1_000_000n, sales7dCents: 3000, orders7d: 1 } as never })
      await db.amazonAdsDailyPerformance.create({ data: { profileId: 'ams', currencyCode: 'EUR', entityType: 'CAMPAIGN', marketplace: 'DE', adProduct: 'SPONSORED_BRANDS',
        date: day(todayUtc), entityId: 'EXT-A1-C2', localEntityId: null, reportRunId: 'ams-stream', reportedAt: new Date(), impressions: 1, clicks: 1, costMicros: 1n } as never })
    })
  })

  it('"Today" shows the hourly spend, not €0.00 — and the same figure the campaign page shows', async () => {
    const out = (await inside(() => listAmazonCampaigns({ startDate: todayUtc, endDate: todayUtc }))) as unknown as { items: Item[]; intraday: { day: string; throughHour: number | null; unavailable: boolean } | null }
    const byId = Object.fromEntries(out.items.map((c) => [c.id, c]))
    expect(byId['a1-c1']).toMatchObject({ impressions: 50, clicks: 4, spend: 0.6, sales: 20, ppcOrders: 1 })
    expect(byId['a1-c2']).toMatchObject({ impressions: 10, clicks: 1, spend: 0.2, sales: 5, ppcOrders: 1 })
    expect(out.intraday).toEqual({ day: todayUtc, throughHour: 9, unavailable: false })
    const { computeCampaignDetailMetrics } = await import('./ads-detail-metrics.service.js')
    for (const [id, ext] of [['a1-c1', 'EXT-A1-C1'], ['a1-c2', 'EXT-A1-C2']] as const) {
      const detail = await inside(() => computeCampaignDetailMetrics({ campaignId: id, externalCampaignId: ext, adGroups: [], windowDays: 1, since: day(todayUtc), until: day(todayUtc) }))
      expect(detail.campaign.spendCents).toBe(Math.round(byId[id].spend * 100))
      expect(detail.campaign.orders).toBe(byId[id].ppcOrders)
    }
  })

  it('a range that ends before today gets no hourly figures', async () => {
    const out = (await inside(() => listAmazonCampaigns({ startDate: yesterdayUtc, endDate: yesterdayUtc }))) as unknown as { items: Item[]; intraday: unknown }
    expect(out.intraday).toBeNull()
    expect(out.items.find((c) => c.id === 'a1-c1')).toMatchObject({ spend: 1, ppcOrders: 1 })
  })

  it('freshness is the daily report per market — the day it covers and when it arrived, never a stream row', async () => {
    const out = (await inside(() => listAmazonCampaigns({ startDate: yesterdayUtc, endDate: yesterdayUtc }))) as unknown as { freshness: Array<{ marketplace: string; dataThrough: string; receivedAt: string | null }> }
    expect(out.freshness.find((m) => m.marketplace === 'IT')).toEqual({ marketplace: 'IT', dataThrough: yesterdayUtc, receivedAt: RECEIVED.toISOString() })
    expect(out.freshness.find((m) => m.marketplace === 'DE')?.dataThrough).not.toBe(todayUtc)
  })
})

describe('GET /advertising/campaigns answers exactly the service', () => {
  for (const query of ['', '?marketplace=IT&status=ENABLED', '?search=test&limit=1', `?startDate=${SEPTEMBER.startDate}&endDate=${SEPTEMBER.endDate}`]) {
    it(`same body${query ? ` for ${query}` : ''}, with Cache-Control`, async () => {
      const response = await app.inject({ method: 'GET', url: `/api/advertising/campaigns${query}` })
      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('private, max-age=60')
      const q = Object.fromEntries(new URLSearchParams(query))
      expect(response.payload).toBe(JSON.stringify(await list(q)))
    })
  }
})

describe('AM-34 — the Ad Manager\u2019s "Refresh view" reads past the 300-s cache', () => {
  it('fresh=1 asks the cache to skip its stored answer; without it the cache answers as before', async () => {
    cacheRefresh.length = 0
    await list({})
    await list({ fresh: '1' })
    await list({ startDate: SEPTEMBER.startDate, endDate: SEPTEMBER.endDate, fresh: '1' })
    expect(cacheRefresh).toEqual([false, true, true])
  })
})
