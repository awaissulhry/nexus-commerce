/**
 * ACR.2.3 — the report cycles only ask about profiles that could answer.
 *
 * Measured on prod over 30 days: 938 of 1,845 report jobs (51%) went to five EU profiles that
 * carry no campaigns at all. Every one completed successfully with `rowsIngested = 0`, so the
 * waste was invisible in every health surface — it looked like a working pipeline.
 *
 * The property that must not regress is narrow and specific: a marketplace with campaigns is
 * NEVER skipped, whatever their status or ad product. Skipping one would silently lose a day
 * of performance data, which is a far worse failure than the waste being fixed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const connFindMany = vi.fn()
const campaignGroupBy = vi.fn()
const reportJobFindFirst = vi.fn(async () => null)
const reportJobCreate = vi.fn(async () => ({ id: 'job-1' }))
const adsProfileFindUnique = vi.fn(async () => ({ currencyCode: 'EUR' }))

/**
 * ACR Stage 5 — `deliveringAdProducts()` asks `campaign.groupBy` a SECOND question, keyed by
 * ad product rather than marketplace. These tests are about the MARKETPLACE filter, so the
 * dispatcher answers that second question generously: every marketplace that has campaigns is
 * treated as having an enabled SP and SB campaign. Ad-product dormancy is tested on its own
 * below, where it can be asserted rather than incidentally assumed.
 */
const perfGroupBy = vi.fn(async () => [] as Array<Record<string, unknown>>)
const campaignGroupByDispatch = async (args: { by?: string[] }) => {
  const rows = await campaignGroupBy(args)
  if (!args?.by?.includes('adProduct')) return rows
  // A test that returns ad-product rows itself is asserting the gate directly — never overwrite
  // its answer with the generous default, or the assertion silently tests the default instead.
  if ((rows as Array<Record<string, unknown>>).some((r) => 'adProduct' in r)) return rows
  return (rows as Array<{ marketplace: string }>).flatMap((r) => [
    { marketplace: r.marketplace, adProduct: 'SPONSORED_PRODUCTS', _count: { _all: 1 } },
    { marketplace: r.marketplace, adProduct: 'SPONSORED_BRANDS', _count: { _all: 1 } },
  ])
}

vi.mock('../../db.js', () => ({
  default: {
    amazonAdsConnection: { get findMany() { return connFindMany } },
    campaign: { groupBy: (args: { by?: string[] }) => campaignGroupByDispatch(args) },
    amazonAdsDailyPerformance: { get groupBy() { return perfGroupBy } },
    amazonAdsReportJob: { get findFirst() { return reportJobFindFirst }, get create() { return reportJobCreate } },
    amazonAdsProfile: { get findUnique() { return adsProfileFindUnique } },
  },
}))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

/**
 * `liveCall` is the single HTTP chokepoint every cycle ends in — the same one ACR.0.6 wrapped
 * for outbound logging. Recording its profileId is how we see which profiles were asked, without
 * depending on the shape of anything above it.
 */
const createdFor: string[] = []
vi.mock('./ads-api-client.js', () => ({
  adsMode: () => 'sandbox',
  liveCall: vi.fn(async (args: { profileId?: string }) => {
    createdFor.push(args.profileId ?? '(none)')
    return { reportId: `r-${args.profileId}`, status: 'PENDING' }
  }),
}))

const mod = await import('./ads-reports.service.js')

const CONNS = [
  { profileId: 'p-it', region: 'EU', marketplace: 'IT' },
  { profileId: 'p-de', region: 'EU', marketplace: 'DE' },
  { profileId: 'p-pl', region: 'EU', marketplace: 'PL' }, // no campaigns — the 51%
  { profileId: 'p-uk', region: 'EU', marketplace: 'UK' }, // no campaigns
]

beforeEach(() => {
  vi.clearAllMocks()
  createdFor.length = 0
  connFindMany.mockResolvedValue(CONNS)
  reportJobFindFirst.mockResolvedValue(null)
  reportJobCreate.mockResolvedValue({ id: 'job-1' })
  adsProfileFindUnique.mockResolvedValue({ currencyCode: 'EUR' })
})

describe('report cycles skip profiles that cannot answer', () => {
  it('asks only the marketplaces that have campaigns', async () => {
    campaignGroupBy.mockResolvedValue([
      { marketplace: 'IT', _count: { _all: 146 } },
      { marketplace: 'DE', _count: { _all: 38 } },
    ])
    await mod.runTargetingReportCycle({ startDate: '2026-08-01', endDate: '2026-08-01' })
    expect(new Set(createdFor)).toEqual(new Set(['p-it', 'p-de']))
    expect(createdFor).not.toContain('p-pl')
    expect(createdFor).not.toContain('p-uk')
  })

  it('a marketplace whose campaigns are ALL paused is still asked — status is not the test', async () => {
    // The MARKETPLACE filter is deliberately status-blind: a campaign enabled at noon must not
    // lose its own day. (ACR Stage 5 later added a separate per-AD-PRODUCT dormancy gate, which
    // is what skips the never-delivered SB/SD. Different question, different test — below.)
    campaignGroupBy.mockResolvedValue([{ marketplace: 'PL', _count: { _all: 3 } }])
    await mod.runTargetingReportCycle({ startDate: '2026-08-01', endDate: '2026-08-01' })
    expect(createdFor).toContain('p-pl')
  })

  it('a marketplace that gains its first campaign is picked up on the next run', async () => {
    campaignGroupBy.mockResolvedValue([{ marketplace: 'IT', _count: { _all: 1 } }])
    await mod.runTargetingReportCycle({ startDate: '2026-08-01', endDate: '2026-08-01' })
    expect(createdFor).toEqual(['p-it'])

    createdFor.length = 0
    campaignGroupBy.mockResolvedValue([
      { marketplace: 'IT', _count: { _all: 1 } },
      { marketplace: 'UK', _count: { _all: 1 } },
    ])
    await mod.runTargetingReportCycle({ startDate: '2026-08-01', endDate: '2026-08-01' })
    expect(new Set(createdFor)).toEqual(new Set(['p-it', 'p-uk']))
  })

  it('asks nobody, rather than everybody, when the account has no campaigns at all', async () => {
    campaignGroupBy.mockResolvedValue([])
    await mod.runTargetingReportCycle({ startDate: '2026-08-01', endDate: '2026-08-01' })
    expect(createdFor).toEqual([])
  })

  it('applies to every creation cycle, not just the one that prompted it', async () => {
    campaignGroupBy.mockResolvedValue([{ marketplace: 'IT', _count: { _all: 5 } }])
    for (const run of [
      () => mod.runReportCreationCycle({ startDate: '2026-08-01', endDate: '2026-08-01', adProducts: ['SPONSORED_PRODUCTS'] }),
      () => mod.runSearchTermReportCycle({ startDate: '2026-08-01', endDate: '2026-08-01', adProducts: ['SPONSORED_PRODUCTS'] }),
      () => mod.runPlacementReportCycle({ startDate: '2026-08-01', endDate: '2026-08-01' }),
      () => mod.runAdvertisedProductReportCycle({ startDate: '2026-08-01', endDate: '2026-08-01' }),
      () => mod.runTargetingReportCycle({ startDate: '2026-08-01', endDate: '2026-08-01' }),
    ]) {
      createdFor.length = 0
      await run()
      expect(new Set(createdFor)).toEqual(new Set(['p-it']))
    }
  })
})

/**
 * ACR Stage 5 — the per-ad-product dormancy gate.
 *
 * Measured on prod 2026-08-05: 653 of 1,882 report jobs in 30 days (35%) were SB/SD requests
 * that could only ever return zero rows, because all 19 SB/SD campaigns are paused and have
 * never delivered an impression. The gate removes exactly those and nothing else.
 *
 * The naive version of this fix — filter to `status = ENABLED` — was explicitly rejected in the
 * original docblock for a good reason: a campaign enabled at noon would lose its own day. Both
 * halves of the OR are therefore tested, because dropping either one loses real data.
 */
describe('ACR Stage 5 — dormant ad products are not asked about', () => {
  beforeEach(() => { perfGroupBy.mockResolvedValue([]) })

  const enabled = (marketplace: string, adProduct: string) => ({ marketplace, adProduct, _count: { _all: 1 } })

  it('skips an ad product with no enabled campaigns and no recent delivery', async () => {
    campaignGroupBy.mockImplementation(async (args: { by?: string[] }) =>
      args?.by?.includes('adProduct') ? [enabled('IT', 'SPONSORED_PRODUCTS')] : [{ marketplace: 'IT', _count: { _all: 5 } }])
    perfGroupBy.mockResolvedValue([{ marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', _sum: { impressions: 5000 } }])

    const r = await mod.runReportCreationCycle({ startDate: '2026-08-01', endDate: '2026-08-01' })
    // SP asked; SB and SD skipped rather than asked-and-wasted.
    expect(r.jobsCreated).toBe(1)
  })

  it('asks about a campaign enabled TODAY that has never delivered — no lost day', async () => {
    // The exact case the ENABLED-only filter was rejected for. SB has zero impressions ever,
    // but it is enabled right now, so its first day must still be collected.
    campaignGroupBy.mockImplementation(async (args: { by?: string[] }) =>
      args?.by?.includes('adProduct')
        ? [enabled('IT', 'SPONSORED_PRODUCTS'), enabled('IT', 'SPONSORED_BRANDS')]
        : [{ marketplace: 'IT', _count: { _all: 5 } }])
    perfGroupBy.mockResolvedValue([]) // nothing has ever delivered

    const r = await mod.runReportCreationCycle({ startDate: '2026-08-01', endDate: '2026-08-01' })
    expect(r.jobsCreated).toBe(2) // SP + SB, not SD
  })

  it('keeps asking about a campaign paused TODAY whose tail data is still arriving', async () => {
    // The mirror case. Nothing is enabled, but SD delivered inside the window, so pausing a
    // campaign must not silently truncate its final days of reporting.
    campaignGroupBy.mockImplementation(async (args: { by?: string[] }) =>
      args?.by?.includes('adProduct') ? [] : [{ marketplace: 'IT', _count: { _all: 5 } }])
    perfGroupBy.mockResolvedValue([{ marketplace: 'IT', adProduct: 'SPONSORED_DISPLAY', _sum: { impressions: 42 } }])

    const r = await mod.runReportCreationCycle({ startDate: '2026-08-01', endDate: '2026-08-01' })
    expect(r.jobsCreated).toBe(1) // SD only
  })

  it('a delivered-zero row does not count as delivery', async () => {
    // groupBy returns the row with a 0 sum rather than omitting it; 0 is dormant, not active.
    campaignGroupBy.mockImplementation(async (args: { by?: string[] }) =>
      args?.by?.includes('adProduct') ? [] : [{ marketplace: 'IT', _count: { _all: 5 } }])
    perfGroupBy.mockResolvedValue([{ marketplace: 'IT', adProduct: 'SPONSORED_DISPLAY', _sum: { impressions: 0 } }])

    const r = await mod.runReportCreationCycle({ startDate: '2026-08-01', endDate: '2026-08-01' })
    expect(r.jobsCreated).toBe(0)
  })
})
