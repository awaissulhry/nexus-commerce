/**
 * Scheduler OOM, 2026-10-07 — the nightly Amazon shadow copy reads and writes its daily-performance rows in pages.
 *
 * It used to read all 74,870 rows (every column) in one findMany and send them in one createMany; under Prisma 7's
 * driver adapter that held the whole table in the V8 heap and the scheduler died "JavaScript heap out of memory" at
 * 03:20 every night. These tests hold the memory ceiling (no read or write bigger than a page, only the copied
 * columns read) and that the copy writes what it wrote before: the same rows, the same mapping, the same parity.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown> & { id: string; costMicros: bigint; currencyCode: string; entityType: string; entityId: string }

const state = vi.hoisted(() => ({
  perf: [] as Array<Record<string, unknown>>,
  metrics: [] as Array<Record<string, unknown>>,
  findManyCalls: [] as Array<{ take?: number; select?: Record<string, boolean>; where?: unknown }>,
  createManyCalls: [] as number[],
}))

vi.mock('../../db.js', () => {
  const byIdAfter = (where: { id?: { gt?: string } } | undefined) =>
    state.perf
      .filter((r) => r.reportRunId !== 'ams')
      .filter((r) => !where?.id?.gt || String(r.id) > where.id.gt)
      .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
  let created = 0
  const client = {
    campaign: {
      findMany: async () => [
        { id: 'legacy-1', type: 'SP', marketplace: 'IT', linkedMarketplaces: [], externalCampaignId: 'C1', name: 'One', status: 'ENABLED', budgetScope: 'SINGLE', dailyBudget: '10.00', dailyBudgetCurrency: 'EUR', spend: null, sales: null, acos: null, roas: null, deliveryStatus: null, deliveryReasons: [], lastSyncedAt: null, lastSyncStatus: null, lastSyncError: null, startDate: null, endDate: null, adProduct: 'SPONSORED_PRODUCTS', portfolioId: null, bidStrategyJson: null, dynamicBidding: null, tactic: null, costType: null, deliveryProfile: null, creativeAssetJson: null, brandEntityId: null },
      ],
    },
    amazonAdsDailyPerformance: {
      count: async () => byIdAfter(undefined).length,
      findMany: async (args: { where?: { id?: { gt?: string } }; take?: number; select?: Record<string, boolean> }) => {
        state.findManyCalls.push({ take: args.take, select: args.select, where: args.where })
        const rows = byIdAfter(args.where).slice(0, args.take ?? Infinity)
        return rows.map((r) => (args.select ? Object.fromEntries(Object.keys(args.select).map((k) => [k, r[k]])) : r))
      },
    },
    fxRate: { findMany: async () => [{ toCurrency: 'GBP', rate: { toString: () => '0.85' }, asOf: new Date('2026-10-01') }] },
    marketplace: { findMany: async () => [] },
    amazonAdsConnection: { findFirst: async () => ({ id: 'conn-it' }) },
    campaignMetric: {
      deleteMany: async () => { state.metrics = []; return { count: 0 } },
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        state.createManyCalls.push(args.data.length)
        state.metrics.push(...args.data)
        return { count: args.data.length }
      },
      count: async () => state.metrics.length,
      aggregate: async () => ({ _sum: { costMicros: state.metrics.reduce((s, m) => s + (m.costMicros as bigint), 0n) } }),
    },
    marketingCampaign: {
      deleteMany: async () => { created = 0; return { count: 0 } },
      create: async () => ({ id: `mc-${++created}` }),
      count: async () => created,
    },
    $executeRawUnsafe: async () => 0,
  }
  return { default: client }
})

vi.mock('../marketing-events.service.js', () => ({ publishMarketingEvent: vi.fn() }))

import { backfillAmazonShadow, PERF_PAGE_ROWS } from './amazon-backfill.service.js'

/** ~70-column source row, as the table holds it; the copy must read only the columns it writes. */
function sourceRow(i: number, over: Partial<Row> = {}): Row {
  return {
    id: `p${String(i).padStart(6, '0')}`,
    profileId: 'it-profile', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date('2026-10-01'),
    entityType: i % 2 ? 'CAMPAIGN' : 'KEYWORD', entityId: i % 2 ? 'C1' : `K${i}`, localEntityId: null,
    impressions: 100, clicks: 5, costMicros: 1_230_000n, currencyCode: 'EUR',
    sales1dCents: 0, sales7dCents: 900, sales14dCents: 950, sales30dCents: 990, orders7d: 1, units7d: 1,
    salesSameSku30dCents: 1, campaignBudgetCents: 1000, entityName: 'x'.repeat(40), topOfSearchIS: null,
    ntbOrders14d: 0, viewableImpressions: 0, detailPageViews7d: 3, acos7d: null, roas7d: null,
    reportRunId: 'run-1', reportedAt: new Date('2026-10-02'), createdAt: new Date('2026-10-02'),
    ...over,
  }
}

beforeEach(() => {
  state.perf = []
  state.metrics = []
  state.findManyCalls = []
  state.createManyCalls = []
})

describe('Amazon shadow copy — bounded memory', () => {
  it('reads and writes in pages no bigger than the page size, and only the columns it copies', async () => {
    state.perf = Array.from({ length: 2_501 }, (_, i) => sourceRow(i))
    const r = await backfillAmazonShadow({ apply: true, pageRows: 1_000 })

    expect(state.findManyCalls.map((c) => c.take)).toEqual([1_000, 1_000, 1_000])
    expect(state.createManyCalls).toEqual([1_000, 1_000, 501])
    for (const c of state.findManyCalls) {
      expect(c.select).toBeDefined()
      expect(Object.keys(c.select!)).not.toContain('salesSameSku30dCents')
      expect(Object.keys(c.select!)).not.toContain('entityName')
    }
    expect(r.source.metrics).toBe(2_501)
    expect(r.written.metrics).toBe(2_501)
    expect(r.parity).toEqual({ campaignsOk: true, metricsOk: true, costOk: true, ok: true })
  })

  it('pages on id after the last row it saw, so no row is read twice or skipped', async () => {
    state.perf = Array.from({ length: 7 }, (_, i) => sourceRow(i))
    await backfillAmazonShadow({ apply: true, pageRows: 3 })
    expect(state.findManyCalls.map((c) => (c.where as { id?: { gt: string } }).id?.gt ?? null)).toEqual([null, 'p000002', 'p000005'])
    expect(state.metrics.map((m) => m.entityId)).toEqual(state.perf.map((p) => p.entityId))
  })

  it('an exact multiple of the page size ends on the empty page after it', async () => {
    state.perf = Array.from({ length: 6 }, (_, i) => sourceRow(i))
    const r = await backfillAmazonShadow({ apply: true, pageRows: 3 })
    expect(state.findManyCalls).toHaveLength(3)
    expect(state.createManyCalls).toEqual([3, 3])
    expect(r.parity?.ok).toBe(true)
  })

  it('the job uses a page of 1,000 rows', () => {
    expect(PERF_PAGE_ROWS).toBe(1_000)
  })
})

describe('Amazon shadow copy — writes what it wrote before', () => {
  it('maps each row as before: campaign link, EUR cost, FX miss counted, AMS rows left out', async () => {
    state.perf = [
      sourceRow(1, { costMicros: 4_790_000n }),
      sourceRow(2, { currencyCode: 'GBP', costMicros: 850_000n }),
      sourceRow(3, { currencyCode: 'SEK', costMicros: 1_000_000n }),
      sourceRow(5, { reportRunId: 'ams' }),
    ]
    const r = await backfillAmazonShadow({ apply: true, pageRows: 2 })

    expect(state.metrics).toHaveLength(3)
    const [eur, gbp, sek] = state.metrics
    expect(eur).toMatchObject({ campaignId: 'mc-1', channel: 'AMAZON', entityType: 'CAMPAIGN', costEurCents: 479n, attributionModel: 'amazon-windowed', sales7dCents: 900, reportRunId: 'run-1' })
    expect(gbp).toMatchObject({ campaignId: null, entityType: 'KEYWORD', costEurCents: 100n })
    expect(sek).toMatchObject({ campaignId: 'mc-1', costEurCents: null })
    expect(Object.keys(eur).sort()).toEqual([
      'acos7d', 'attributionModel', 'campaignId', 'channel', 'clicks', 'costEurCents', 'costMicros', 'currencyCode', 'date',
      'detailPageViews7d', 'entityId', 'entityType', 'impressions', 'localEntityId', 'marketplace', 'ntbOrders14d', 'orders7d',
      'reportRunId', 'reportedAt', 'roas7d', 'sales14dCents', 'sales30dCents', 'sales7dCents', 'units7d', 'viewableImpressions',
    ])
    expect(r.fxMissing).toBe(1)
    expect(r.source.metrics).toBe(3)
    expect(r.parity?.ok).toBe(true)
  })

  it('a dry run counts the rows and reads none of them', async () => {
    state.perf = Array.from({ length: 5 }, (_, i) => sourceRow(i))
    const r = await backfillAmazonShadow({ apply: false })
    expect(state.findManyCalls).toHaveLength(0)
    expect(state.createManyCalls).toHaveLength(0)
    expect(r.source.metrics).toBe(5)
    expect(r.written.metrics).toBe(5)
    expect(r.parity).toBeNull()
  })
})
