/**
 * AM-6 / AM-35 — the Portfolios overview's numbers match the campaigns'.
 *
 *  · AM-6: spend/sales are summed from the daily reports for the picked window, with the Ad Manager
 *    list's own buckets — never the stored `Campaign.spend/sales` (an unlabelled ~30-day figure that
 *    is never reset for an idle campaign). Proven against `listAmazonCampaigns` for the same window:
 *    a portfolio's spend IS the sum of its campaigns' spend in the Ad Manager.
 *  · AM-35: one counting rule — enabled + paused, the Ad Manager's default status filter; archived
 *    members are reported apart and their spend is not summed.
 * PGlite with the production schema; the ads read cache is a pass-through.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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

import { getPortfolioOverview } from './ads-portfolio.service.js'
import { listAmazonCampaigns } from './ads-campaign-list.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const day = (d: string) => new Date(`${d}T00:00:00Z`)
const WINDOW = { startDate: '2026-09-01', endDate: '2026-09-30' }

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await inside(async () => {
    await db.amazonAdsPortfolio.create({ data: { profileId: 'P1', externalPortfolioId: 'PF-ONE', name: 'One', state: 'ENABLED' } as never })
    await db.amazonAdsPortfolio.create({ data: { profileId: 'P1', externalPortfolioId: 'PF-IDLE', name: 'Idle', state: 'ENABLED' } as never })
    const camp = (id: string, status: string, portfolioId: string, extra: Record<string, unknown> = {}) => db.campaign.create({ data: {
      id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '10.00',
      startDate: day('2026-01-01'), status, portfolioId, ...extra,
    } as never })
    // The stored columns carry made-up figures the overview must NOT read any more.
    await camp('pf-enabled', 'ENABLED', 'PF-ONE', { spend: '999.00', sales: '1.00' })
    await camp('pf-paused', 'PAUSED', 'PF-ONE', { spend: '555.00', sales: '0' })
    await camp('pf-archived', 'ARCHIVED', 'PF-ONE', { spend: '777.00', sales: '0' })
    await camp('pf-idle', 'ENABLED', 'PF-IDLE', { spend: '42.00', sales: '84.00' }) // idle for months: stored figure never reset
    const perf = (data: Record<string, unknown>) => db.amazonAdsDailyPerformance.create({ data: {
      profileId: 'P1', currencyCode: 'EUR', entityType: 'CAMPAIGN', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', reportedAt: day('2026-09-20'), ...data,
    } as never })
    // Enabled, linked: two September days, one August day outside the window.
    await perf({ date: day('2026-09-10'), entityId: 'EXT-pf-enabled', localEntityId: 'pf-enabled', costMicros: 1_230_000n, sales7dCents: 1000 })
    await perf({ date: day('2026-09-11'), entityId: 'EXT-pf-enabled', localEntityId: 'pf-enabled', costMicros: 770_000n, sales7dCents: 500, sales14dCents: 9000 })
    await perf({ date: day('2026-08-01'), entityId: 'EXT-pf-enabled', localEntityId: 'pf-enabled', costMicros: 50_000_000n, sales7dCents: 5000 })
    // Paused, never linked locally: the report row counts by its Amazon id; the stream's daily row does not.
    await perf({ date: day('2026-09-12'), entityId: 'EXT-pf-paused', localEntityId: null, reportRunId: 'RUN-1', costMicros: 450_000n, sales7dCents: 0 })
    await perf({ profileId: 'ams', date: day('2026-09-12'), entityId: 'EXT-pf-paused', localEntityId: null, reportRunId: 'ams-stream', costMicros: 9_990_000n, sales7dCents: 9999 })
    // Archived, spent inside the window: hidden from the Ad Manager's default view, so not summed.
    await perf({ date: day('2026-09-13'), entityId: 'EXT-pf-archived', localEntityId: 'pf-archived', costMicros: 3_000_000n, sales7dCents: 100 })
  })
}, 180_000)
afterAll(async () => { await database?.close() })

const overview = (q: Record<string, string> = WINDOW) => inside(() => getPortfolioOverview(q))
const byId = async (q?: Record<string, string>) => new Map((await overview(q)).portfolios.map((p) => [p.portfolioId, p]))

describe('AM-6 — portfolio money comes from the daily reports for the picked window', () => {
  it('sums the window’s report rows, not the stored Campaign.spend/sales', async () => {
    const one = (await byId()).get('PF-ONE')!
    // 1.23 + 0.77 (enabled) + 0.45 (paused, external bucket); the August row and the stream row are out.
    expect(one.spendCents).toBe(245)
    expect(one.salesCents).toBe(1500) // sales7dCents only — sales14dCents is never the headline
    expect(one.acos).toBeCloseTo(245 / 1500)
  })

  it('equals the sum of the same campaigns in the Ad Manager list for the same window', async () => {
    const list = await inside(() => listAmazonCampaigns(WINDOW)) as { items: Array<{ id: string; spend: number; sales: number }> }
    const shown = list.items.filter((c) => c.id === 'pf-enabled' || c.id === 'pf-paused')
    const spendCents = Math.round(shown.reduce((s, c) => s + c.spend, 0) * 100)
    const salesCents = Math.round(shown.reduce((s, c) => s + c.sales, 0) * 100)
    const one = (await byId()).get('PF-ONE')!
    expect(one.spendCents).toBe(spendCents)
    expect(one.salesCents).toBe(salesCents)
  })

  it('an idle campaign spends 0 in the window — its old stored figure is gone', async () => {
    const idle = (await byId()).get('PF-IDLE')!
    expect(idle.spendCents).toBe(0)
    expect(idle.salesCents).toBe(0)
    expect(idle.acos).toBeNull()
  })

  it('answers with the window it covered, so the page can print it', async () => {
    const out = await overview()
    expect(out.range).toMatchObject({ startDate: '2026-09-01', endDate: '2026-09-30', preset: 'custom', includesToday: false })
    expect(out.countedStatuses).toEqual(['ENABLED', 'PAUSED'])
  })

  it('a different window gives that window’s money', async () => {
    const one = (await byId({ startDate: '2026-08-01', endDate: '2026-08-31' })).get('PF-ONE')!
    expect(one.spendCents).toBe(5000)
  })
})

describe('AM-35 — one counting rule: enabled + paused; archived said apart', () => {
  it('counts enabled + paused, reports archived separately, and never sums archived spend', async () => {
    const one = (await byId()).get('PF-ONE')!
    expect(one.campaignCount).toBe(2)
    expect(one.activeCampaignCount).toBe(1)
    expect(one.archivedCampaignCount).toBe(1)
    expect(one.spendCents).toBe(245) // the archived campaign's 3.00 is not in it
  })
})
