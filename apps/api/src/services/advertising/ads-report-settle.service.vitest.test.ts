/**
 * BB-13 — the nightly settling spans, the catch-up that re-reads the last 60 days once, and the gap read.
 * The report cycles are stubbed: what is under test is WHICH ranges are asked, for which account, and when it stops.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const connFindMany = vi.fn()
const jobFindMany = vi.fn()
const vintageFindMany = vi.fn()
vi.mock('../../db.js', () => ({
  default: {
    amazonAdsConnection: { findMany: (...a: unknown[]) => connFindMany(...a) },
    amazonAdsProfile: { findMany: async () => [] },
    amazonAdsReportJob: { findMany: (...a: unknown[]) => jobFindMany(...a) },
    adsDailyVintage: { findMany: (...a: unknown[]) => vintageFindMany(...a) },
  },
}))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

type Asked = { kind: string; startDate: string; endDate: string; adProducts?: string[]; profileIds?: readonly string[] }
const asked: Asked[] = []
let failFor: string | null = null
const cycle = (kind: string) => vi.fn(async (a: Omit<Asked, 'kind'>) => {
  asked.push({ kind, ...a })
  if (failFor === kind) return { jobsCreated: 0, jobsSkipped: 0, errors: [`${kind}: 429`] }
  return { jobsCreated: (a.profileIds?.length ?? 1) * (a.adProducts?.length ?? 1), jobsSkipped: 0, errors: [] }
})
const delivering = vi.fn()
vi.mock('./ads-reports.service.js', () => ({
  CAMPAIGN_REPORT_TYPE_ID: { SPONSORED_PRODUCTS: 'spCampaigns', SPONSORED_BRANDS: 'sbCampaigns', SPONSORED_DISPLAY: 'sdCampaigns' },
  SEARCH_TERM_REPORT_TYPE_ID: { SPONSORED_PRODUCTS: 'spSearchTerm', SPONSORED_BRANDS: 'sbSearchTerm' },
  PLACEMENT_REPORT_TYPE_ID: 'spPlacement',
  TARGETING_REPORT_TYPE_ID: 'spTargeting',
  ADVERTISED_PRODUCT_REPORT_TYPE_ID: 'spAdvertisedProduct',
  deliveringAdProducts: (...a: unknown[]) => delivering(...a),
  runReportCreationCycle: cycle('campaign'),
  runSearchTermReportCycle: cycle('search-term'),
  runPlacementReportCycle: cycle('placement'),
  runTargetingReportCycle: cycle('targeting'),
  runAdvertisedProductReportCycle: cycle('advertised'),
}))

const { settlingCycle, perDaySettlingCycle, runSettleCatchUp, measureGap, dataVintageByMarket, catchUpBounds } = await import('./ads-report-settle.service.js')

const NOW = new Date('2026-10-08T03:20:00.000Z')
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

beforeEach(() => {
  asked.length = 0
  failFor = null
  connFindMany.mockReset().mockResolvedValue([{ profileId: 'p-it', marketplace: 'IT' }])
  jobFindMany.mockReset().mockResolvedValue([])
  vintageFindMany.mockReset().mockResolvedValue([])
  delivering.mockReset().mockResolvedValue(new Map([['IT', new Set(['SPONSORED_PRODUCTS'])]]))
})

describe('nightly settling spans', () => {
  it('Sponsored Products asks 8 days, Brands and Display share one 15-day call', async () => {
    const run = vi.fn(async () => ({ jobsCreated: 1, jobsSkipped: 0, errors: [] as string[] }))
    const r = await settlingCycle(run, ['SPONSORED_PRODUCTS', 'SPONSORED_DISPLAY', 'SPONSORED_BRANDS'], NOW)
    expect(run.mock.calls).toEqual([
      [{ startDate: '2026-09-30', endDate: '2026-10-07', adProducts: ['SPONSORED_PRODUCTS'] }],
      [{ startDate: '2026-09-23', endDate: '2026-10-07', adProducts: ['SPONSORED_DISPLAY', 'SPONSORED_BRANDS'] }],
    ])
    expect(r.jobsCreated).toBe(2)
  })

  it('a per-day report asks yesterday and the day that completes tonight, one job each', async () => {
    const run = vi.fn(async () => ({ jobsCreated: 1, jobsSkipped: 0, errors: [] as string[] }))
    await perDaySettlingCycle(run, NOW)
    expect(run.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { startDate: '2026-10-07', endDate: '2026-10-07' },
      { startDate: '2026-09-30', endDate: '2026-09-30' },
    ])
  })
})

describe('catch-up', () => {
  it('reaches 60 days back (one day inside Amazon\'s retention for Brands) and stops where the nightly span starts', () => {
    expect(catchUpBounds('SPONSORED_PRODUCTS', NOW)).toEqual({ from: d('2026-08-09'), to: d('2026-09-30') })
    expect(catchUpBounds('SPONSORED_BRANDS', NOW).from).toEqual(d('2026-08-10'))
    expect(catchUpBounds('SPONSORED_BRANDS', NOW).to).toEqual(d('2026-09-23'))
  })

  it('the first run after deploy asks the ranged reports in 30-day chunks for the account, ranged reports first', async () => {
    const r = await runSettleCatchUp({ now: NOW, maxJobs: 1000 })
    const ranged = asked.filter((a) => a.kind !== 'targeting' && a.kind !== 'advertised')
    expect(ranged.map((a) => `${a.kind} ${a.startDate}..${a.endDate}`)).toEqual([
      'campaign 2026-09-01..2026-09-30',
      'campaign 2026-08-09..2026-08-31',
      'search-term 2026-09-01..2026-09-30',
      'search-term 2026-08-09..2026-08-31',
      'placement 2026-09-01..2026-09-30',
      'placement 2026-08-09..2026-08-31',
    ])
    expect(ranged.every((a) => a.profileIds?.join() === 'p-it')).toBe(true)
    // Dormant Brands / Display are not asked.
    expect(asked.some((a) => a.adProducts?.some((p) => p !== 'SPONSORED_PRODUCTS'))).toBe(false)
    // The per-day reports come after, newest day first, one day per job: 53 days each.
    const targeting = asked.filter((a) => a.kind === 'targeting')
    expect(targeting).toHaveLength(53)
    expect(targeting[0]).toMatchObject({ startDate: '2026-09-30', endDate: '2026-09-30' })
    expect(r.capped).toBe(false)
  })

  it('stops at maxJobs and says what is still waiting', async () => {
    const r = await runSettleCatchUp({ now: NOW, maxJobs: 10 })
    expect(r.jobsCreated).toBe(10)
    expect(r.capped).toBe(true)
    expect(r.waiting.some((w) => w.startsWith('IT/targeting'))).toBe(true)
  })

  it('asks nothing once every day holds an ingested or in-flight settling pull', async () => {
    const settled = (reportTypeId: string, status = 'COMPLETED') => ({
      profileId: 'p-it', adProduct: 'SPONSORED_PRODUCTS', reportTypeId, status,
      startDate: d('2026-08-01'), endDate: d('2026-09-30'), createdAt: NOW, ingestedAt: status === 'COMPLETED' ? NOW : null,
    })
    jobFindMany.mockResolvedValue([
      settled('spCampaigns'), settled('spSearchTerm'), settled('spPlacement', 'IN_PROGRESS'), settled('spTargeting'), settled('spAdvertisedProduct'),
    ])
    const r = await runSettleCatchUp({ now: NOW })
    expect(asked).toEqual([])
    expect(r.jobsCreated).toBe(0)
  })

  it('an account whose report errors stops for that report this run (no hammering)', async () => {
    failFor = 'campaign'
    await runSettleCatchUp({ now: NOW, maxJobs: 1000 })
    expect(asked.filter((a) => a.kind === 'campaign')).toHaveLength(1)
    expect(asked.filter((a) => a.kind === 'search-term')).toHaveLength(2)
  })
})

describe('the gap read', () => {
  const v = (over: Record<string, unknown>) => ({
    profileId: 'p-it', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', entityId: 'c1', date: d('2026-09-20'),
    pulledAt: new Date('2026-09-21T01:15:00Z'), ageDays: 0, sales7dCents: 0, sales14dCents: null, orders7d: 0, orders14d: null, ...over,
  })
  const through = new Map([['p-it|SPONSORED_PRODUCTS', d('2026-09-29')]])

  it('compares the first copy with the newest copy over settled days only', () => {
    const rows = [
      v({ sales7dCents: 8000, orders7d: 1 }),
      v({ pulledAt: new Date('2026-09-25T01:15:00Z'), ageDays: 4, sales7dCents: 12000, orders7d: 2 }),
      v({ pulledAt: new Date('2026-09-28T01:15:00Z'), ageDays: 7, sales7dCents: 16100, orders7d: 2 }),
      // A day that has not settled yet is not measured.
      v({ date: d('2026-10-01'), pulledAt: new Date('2026-10-02T01:15:00Z'), sales7dCents: 5000, orders7d: 1 }),
      // A day whose first stored copy was already old (a backfill) is not a first copy.
      v({ entityId: 'c2', pulledAt: new Date('2026-09-29T01:15:00Z'), ageDays: 8, sales7dCents: 9000, orders7d: 1 }),
    ]
    expect(measureGap(rows, through)).toEqual({
      campaignDays: 1,
      days: 1,
      firstCopy: { salesCents: 8000, orders: 1 },
      settled: { salesCents: 16100, orders: 2 },
      salesGapPct: 101.3,
      ordersGapPct: 100,
    })
  })

  it('a re-read that changed nothing keeps one copy: gap 0, not unknown', () => {
    expect(measureGap([v({ source: 'stored', sales7dCents: 4000, orders7d: 1 })], through)).toMatchObject({ salesGapPct: 0, ordersGapPct: 0 })
  })

  it('no settled day yet: nothing measured', () => {
    expect(measureGap([v({})], new Map())).toBeNull()
  })

  it('per market: the newest settled Sponsored Products day and the day still filling from', async () => {
    jobFindMany.mockResolvedValue([{
      profileId: 'p-it', adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spCampaigns', status: 'COMPLETED',
      startDate: d('2026-09-30'), endDate: d('2026-10-07'), createdAt: new Date('2026-10-08T01:15:00Z'), ingestedAt: new Date('2026-10-08T02:07:00Z'),
    }])
    const out = await dataVintageByMarket(['IT'], '2026-09-01', '2026-10-07')
    expect(out.get('IT')).toMatchObject({ market: 'IT', settledThrough: '2026-09-30', stillFillingFrom: '2026-10-01', measured: null })
  })
})
