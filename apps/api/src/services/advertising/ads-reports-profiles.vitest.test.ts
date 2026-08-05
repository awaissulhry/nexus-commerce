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

vi.mock('../../db.js', () => ({
  default: {
    amazonAdsConnection: { get findMany() { return connFindMany } },
    campaign: { get groupBy() { return campaignGroupBy } },
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
    // 15 SD + 4 SB campaigns on this account are all disabled. Their days still belong to them.
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
