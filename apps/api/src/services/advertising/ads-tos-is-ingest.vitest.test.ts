/**
 * Lane 5 (2026-10-10, the free-visibility-numbers audit) — the top-of-search impression share ingest.
 *
 *   T1  the unit is decided once per report (any value above 1 → the whole report is percentages), never per value
 *   T3  a campaign-day with a share and no TOP placement row updates its CAMPAIGN daily row; nothing is ever created
 *   T4  the window ends yesterday in the account's time zone
 *   KW  the keyword-grain pass (spTargeting, grouped by targeting) only updates existing AD_TARGET rows, and its failure
 *       never fails the campaign pass; the summary counts both grains
 *
 * Made-up ids and numbers only (the repository is public).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  amazonAdsConnection: { findMany: vi.fn() },
  amazonAdsPlacementReport: { updateMany: vi.fn() },
  amazonAdsDailyPerformance: { updateMany: vi.fn() },
}))
vi.mock('../../db.js', () => ({ default: db }))
const fetchReport = vi.hoisted(() => vi.fn())
vi.mock('./ads-api-client.js', async (original) => ({ ...(await original<Record<string, unknown>>()), fetchReport }))
vi.mock('./ads-market-time.js', () => ({ adsAccountTimeZone: vi.fn(async () => ({ timeZone: 'Europe/Rome', source: 'profile' })) }))

const { ingestTopOfSearchIS, shareRowsOf, tosIsSummaryLine, tosWindow, TARGETING_TOS_COLUMNS } = await import('./ads-tos-is-ingest.service.js')
const { impressionShareUnit, toImpressionShareFraction } = await import('./ads-reports.service.js')

describe('T1 — the unit, once per report', () => {
  it('any value above 1 makes the whole report percentages: a 0.8 in it is 0.8 %, not 80 %', () => {
    expect(impressionShareUnit([0.8, 45, null, ''])).toBe('percent')
    expect(toImpressionShareFraction(0.8, 'percent')).toBeCloseTo(0.008, 10)
    expect(toImpressionShareFraction(45, 'percent')).toBeCloseTo(0.45, 10)
    const { unit, rows } = shareRowsOf([
      { campaignId: '111', date: '2026-10-05', topOfSearchImpressionShare: 0.8 },
      { campaignId: '222', date: '2026-10-05', topOfSearchImpressionShare: 45 },
    ], 'campaignId')
    expect(unit).toBe('percent')
    expect(rows.map((r) => r.share)).toEqual([0.008, 0.45])
  })

  it('a report with no value above 1 is fractions', () => {
    expect(impressionShareUnit([0.8, 0.5, 1])).toBe('fraction')
    expect(toImpressionShareFraction(0.8, 'fraction')).toBe(0.8)
    expect(shareRowsOf([{ keywordId: 'k1', date: '2026-10-05', topOfSearchImpressionShare: 0.25 }], 'keywordId').rows[0]).toEqual({ id: 'k1', date: '2026-10-05', share: 0.25 })
  })

  it('empty, negative or impossible values are no share (null, never 0); without a unit the old per-value rule stands', () => {
    expect(toImpressionShareFraction(null, 'percent')).toBeNull()
    expect(toImpressionShareFraction('', 'fraction')).toBeNull()
    expect(toImpressionShareFraction(-1, 'percent')).toBeNull()
    expect(toImpressionShareFraction(120, 'percent')).toBeNull()
    expect(toImpressionShareFraction(62.5)).toBe(0.625)
    expect(toImpressionShareFraction(0.09)).toBe(0.09)
    expect(shareRowsOf([{ campaignId: '111', date: '2026-10-05', topOfSearchImpressionShare: null }], 'campaignId').rows[0].share).toBeNull()
  })
})

describe('T4 — the window ends yesterday in the account\'s time zone', () => {
  it('Rome is already on the 10th at 23:30 UTC on the 9th: the window ends on the 9th', () => {
    expect(tosWindow(new Date('2026-10-09T23:30:00Z'), 'Europe/Rome', 7)).toEqual({ startDate: '2026-10-03', endDate: '2026-10-09' })
  })
  it('no zone known: UTC — today (the 9th) is left out', () => {
    expect(tosWindow(new Date('2026-10-09T23:30:00Z'), null, 7)).toEqual({ startDate: '2026-10-02', endDate: '2026-10-08' })
  })
})

describe('ingestTopOfSearchIS — both grains', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.amazonAdsConnection.findMany.mockResolvedValue([{ profileId: 'p1', region: 'EU', marketplace: 'IT' }])
  })

  const campaignReport = [
    { campaignId: 'c-top', date: '2026-10-05', impressions: 500, topOfSearchImpressionShare: 40 },
    { campaignId: 'c-notop', date: '2026-10-05', impressions: 90, topOfSearchImpressionShare: 0.8 },
    { campaignId: 'c-none', date: '2026-10-05', impressions: 50, topOfSearchImpressionShare: 12 },
    { campaignId: 'c-null', date: '2026-10-05', impressions: 10, topOfSearchImpressionShare: null },
  ]
  const targetingReport = [
    { campaignId: 'c-top', adGroupId: 'g1', keywordId: 'k1', date: '2026-10-05', impressions: 300, topOfSearchImpressionShare: 0.3 },
    { campaignId: 'c-top', adGroupId: 'g1', keywordId: 'k2', date: '2026-10-05', impressions: 200, topOfSearchImpressionShare: null },
    { campaignId: 'c-top', adGroupId: 'g1', keywordId: 'k-new', date: '2026-10-05', impressions: 5, topOfSearchImpressionShare: 0.1 },
  ]

  it('T3: no TOP row → the CAMPAIGN row; neither → skipped; the keyword pass updates AD_TARGET rows only; every count said', async () => {
    fetchReport.mockImplementation(async (_ctx: unknown, req: { reportType: string; reportTypeId?: string }) => (req.reportTypeId === 'spTargeting' ? targetingReport : campaignReport))
    db.amazonAdsPlacementReport.updateMany.mockImplementation(async ({ where }: { where: { campaignId: string } }) => ({ count: where.campaignId === 'c-top' ? 1 : 0 }))
    db.amazonAdsDailyPerformance.updateMany.mockImplementation(async ({ where }: { where: { entityType: string; entityId: string } }) => ({
      count: (where.entityType === 'CAMPAIGN' && where.entityId === 'c-notop') || (where.entityType === 'AD_TARGET' && where.entityId === 'k1') ? 1 : 0,
    }))
    const r = await ingestTopOfSearchIS({ windowDays: 7, now: new Date('2026-10-09T02:30:00Z') })

    // The keyword pass asks spTargeting grouped by targeting, its own minimal columns, the same window as the campaign pass.
    const kwReq = fetchReport.mock.calls.map((c) => c[1]).find((q) => q.reportTypeId === 'spTargeting')
    expect(kwReq).toMatchObject({ groupBy: ['targeting'], columnsOverride: TARGETING_TOS_COLUMNS, startDate: '2026-10-02', endDate: '2026-10-08' })
    const campReq = fetchReport.mock.calls.map((c) => c[1]).find((q) => q.reportType === 'campaigns')
    expect(campReq.reportTypeId).toBeUndefined()
    expect(campReq.groupBy).toBeUndefined()

    // T1 — the campaign report holds a 40: all of it is percentages, so 0.8 is 0.8 %.
    expect(db.amazonAdsPlacementReport.updateMany).toHaveBeenCalledWith({ where: { campaignId: 'c-top', date: new Date('2026-10-05T00:00:00Z'), placement: 'Top of Search on-Amazon' }, data: { topOfSearchIS: 0.4 } })
    const campaignRowWrites = db.amazonAdsDailyPerformance.updateMany.mock.calls.map((c) => c[0]).filter((a) => a.where.entityType === 'CAMPAIGN')
    expect(campaignRowWrites).toEqual([
      { where: { profileId: 'p1', adProduct: 'SPONSORED_PRODUCTS', entityType: 'CAMPAIGN', entityId: 'c-notop', date: new Date('2026-10-05T00:00:00Z') }, data: { topOfSearchIS: 0.008 } },
      { where: { profileId: 'p1', adProduct: 'SPONSORED_PRODUCTS', entityType: 'CAMPAIGN', entityId: 'c-none', date: new Date('2026-10-05T00:00:00Z') }, data: { topOfSearchIS: 0.12 } },
    ])
    const targetWrites = db.amazonAdsDailyPerformance.updateMany.mock.calls.map((c) => c[0]).filter((a) => a.where.entityType === 'AD_TARGET')
    expect(targetWrites.map((a) => [a.where.entityId, a.data.topOfSearchIS])).toEqual([['k1', 0.3], ['k-new', 0.1]])
    // Nothing is ever created.
    expect(Object.keys(db.amazonAdsDailyPerformance)).toEqual(['updateMany'])

    expect(r).toMatchObject({
      profiles: 1, rowsFetched: 4, withIS: 3, rowsUpdated: 1, campaignRowsUpdated: 1, rowsNull: 1, rowsSkipped: 1, errors: [],
      keyword: { rowsFetched: 3, withIS: 2, rowsUpdated: 1, rowsNull: 1, rowsSkipped: 1, errors: [] },
      windows: [{ profileId: 'p1', startDate: '2026-10-02', endDate: '2026-10-08', timeZone: 'Europe/Rome' }],
    })
    expect(tosIsSummaryLine(r)).toBe('profiles=1 window=2026-10-02..2026-10-08 (Europe/Rome)'
      + ' · campaign: rowsFetched=4 withIS=3 rowsUpdated=1 campaignRowsUpdated=1 rowsNull=1 rowsSkipped=1 errors=0'
      + ' · keyword: rowsFetched=3 withIS=2 rowsUpdated=1 rowsNull=1 rowsSkipped=1 errors=0')
  })

  it('a failed keyword pass never fails the campaign pass (its error kept apart)', async () => {
    fetchReport.mockImplementation(async (_ctx: unknown, req: { reportTypeId?: string }) => {
      if (req.reportTypeId === 'spTargeting') throw new Error('400 configuration columns includes invalid values')
      return campaignReport.slice(0, 1)
    })
    db.amazonAdsPlacementReport.updateMany.mockResolvedValue({ count: 1 })
    const r = await ingestTopOfSearchIS({ now: new Date('2026-10-09T02:30:00Z') })
    expect(r.errors).toEqual([])
    expect(r.rowsUpdated).toBe(1)
    expect(r.keyword.errors).toEqual(['p1: 400 configuration columns includes invalid values'])
    expect(r.keyword.rowsUpdated).toBe(0)
  })

  it('a failed campaign pass is the run\'s error; the keyword pass still writes', async () => {
    fetchReport.mockImplementation(async (_ctx: unknown, req: { reportTypeId?: string }) => {
      if (req.reportTypeId !== 'spTargeting') throw new Error('504 report still pending')
      return targetingReport.slice(0, 1)
    })
    db.amazonAdsDailyPerformance.updateMany.mockResolvedValue({ count: 1 })
    const r = await ingestTopOfSearchIS({ now: new Date('2026-10-09T02:30:00Z') })
    expect(r.errors).toEqual(['p1: 504 report still pending'])
    expect(r.keyword).toMatchObject({ rowsUpdated: 1, errors: [] })
  })
})
