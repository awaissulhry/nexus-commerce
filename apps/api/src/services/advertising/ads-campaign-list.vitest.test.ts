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
vi.mock('./ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
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
