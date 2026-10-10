/**
 * Amazon's free visibility numbers, honest (2026-10-10) — the readers on a real PostgreSQL (PGlite, production schema):
 *
 *   B2  Keyword Tracker and its term drawer compute every SQP share from the COUNTS (our ASIN ÷ the query's total);
 *       a row whose query total is 0 is measured with a NULL share, never 0 — whatever the stored share column holds;
 *       MONTH rows stay out of a weekly view. C6: the per-ASIN score is `searchQueryScore`, not a market rank.
 *   B3  the tracker's top-of-search scope fact: readings at most 7 days old, impression-weighted, with the oldest and
 *       newest date and the campaigns used.
 *   D2  the SQP report: each (query, week, market) total once, weekly ASIN rows only, shares from those totals.
 *   D3  Top-of-search IS in the placement and campaign reports: the impression-weighted average, not the best day.
 *   T5  the coverage board: a keyword's ToS IS says it is campaign-level; the market floor reads the query total once.
 *   C2  the hours research's lanes: the campaigns, days and newest date behind the top-of-search share.
 *
 * Made-up numbers and ids only (public repository).
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

import { getKeywordTracker } from './keyword-tracker.service.js'
import { getKeywordTerm } from './keyword-term.service.js'
import { runReport } from './ads-report-runner.service.js'
import { getCoverageScoreboard } from './ads-coverage.service.js'
import { loadLanes } from './brain/hours-research.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const DAY = 86_400_000
const today = new Date(); today.setUTCHours(0, 0, 0, 0)
const ago = (n: number) => new Date(+today - n * DAY)
const iso = (d: Date) => d.toISOString().slice(0, 10)
const sunday = (d: Date) => new Date(+d - d.getUTCDay() * DAY)
/** two weekly SQP periods inside the Keyword Tracker's lookback */
const W1 = sunday(ago(14))
const W0 = new Date(+W1 - 7 * DAY)
const day = (s: string) => new Date(`${s}T00:00:00Z`)

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await inside(async () => {
    // ── the IT account: two campaigns, one ASIN each, both bidding "race jacket" ──
    for (const [n, asin] of [[1, 'ASIN-VIS-A'], [2, 'ASIN-VIS-B']] as const) {
      const product = await db.product.create({ data: { sku: `VIS-SKU-${n}`, name: `Test jacket ${n}`, basePrice: '80.00' } })
      await db.campaign.create({ data: {
        id: `vis-c${n}`, name: `Visibility test ${n}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT',
        externalCampaignId: `EXT-VIS-${n}`, dailyBudget: '10.00', startDate: day('2026-01-01'),
      } as never })
      await db.adGroup.create({ data: { id: `vis-g${n}`, campaignId: `vis-c${n}`, name: `group ${n}` } })
      await db.adProductAd.create({ data: { adGroupId: `vis-g${n}`, productId: product.id, asin } })
      await db.adTarget.create({ data: {
        id: `vis-t${n}`, adGroupId: `vis-g${n}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'race jacket', bidCents: 40,
      } as never })
    }
    const list = await db.keywordWatchlist.create({ data: { marketplace: 'IT', name: 'Watched', isDefault: true } })
    for (const term of ['race jacket', 'winter gloves', 'rain suit', 'storm jacket']) await db.keywordWatchlistTerm.create({ data: { watchlistId: list.id, term } })

    const sqp = (data: Record<string, unknown>) => db.searchQueryPerformance.create({ data: { marketplace: 'IT', reportPeriod: 'WEEK', ...data } as never })
    // W1 "race jacket": the stored share columns are deliberately WRONG — the readers must not read them.
    await sqp({ startDate: W1, searchQuery: 'race jacket', asin: 'ASIN-VIS-A', searchQueryVolume: 1000, searchQueryRank: 3,
      impressionsTotal: 10_000, impressionsBrand: 300, impressionShare: '0.9000', clicksTotal: 500, clicksBrand: 20, clickShare: '0.9000' })
    await sqp({ startDate: W1, searchQuery: 'race jacket', asin: 'ASIN-VIS-B', searchQueryVolume: 1000, searchQueryRank: 5,
      impressionsTotal: 10_000, impressionsBrand: 200, impressionShare: '0', clicksTotal: 500, clicksBrand: 10 })
    // W1 "winter gloves": Amazon sent the row but no query total — measured, and NO share (not 0 %)
    await sqp({ startDate: W1, searchQuery: 'winter gloves', asin: 'ASIN-VIS-A', searchQueryVolume: 400, searchQueryRank: 7,
      impressionsTotal: 0, impressionsBrand: 0, impressionShare: '0' })
    // W1 "neck warmer": 600 market impressions on each of two ASIN rows — under the board's 1,000 floor once counted once
    await sqp({ startDate: W1, searchQuery: 'neck warmer', asin: 'ASIN-VIS-A', searchQueryVolume: 50, impressionsTotal: 600, impressionsBrand: 10 })
    await sqp({ startDate: W1, searchQuery: 'neck warmer', asin: 'ASIN-VIS-B', searchQueryVolume: 50, impressionsTotal: 600, impressionsBrand: 10 })
    // a MONTH row that starts on the same day as the week: a weekly view never reads it
    await sqp({ reportPeriod: 'MONTH', startDate: W1, searchQuery: 'race jacket', asin: 'ASIN-VIS-A', searchQueryVolume: 99_999,
      impressionsTotal: 99_999, impressionsBrand: 99_999, clicksTotal: 99_999, clicksBrand: 99_999 })
    // W1 "storm jacket": a stored volume of 0 — SQP only returns searched queries, so it is "not reported" (review fix)
    await sqp({ startDate: W1, searchQuery: 'storm jacket', asin: 'ASIN-VIS-A', searchQueryVolume: 0, impressionsTotal: 400, impressionsBrand: 4 })
    await sqp({ startDate: W0, searchQuery: 'storm jacket', asin: 'ASIN-VIS-A', searchQueryVolume: 300, impressionsTotal: 300, impressionsBrand: 3 })
    // W0 — the prior week
    await sqp({ startDate: W0, searchQuery: 'race jacket', asin: 'ASIN-VIS-A', searchQueryVolume: 900, impressionsTotal: 8000, impressionsBrand: 160 })
    await sqp({ startDate: W0, searchQuery: 'race jacket', asin: 'ASIN-VIS-B', searchQueryVolume: 900, impressionsTotal: 8000, impressionsBrand: 80 })

    // top-of-search shares, per campaign and day, on the TOP placement row
    const top = (campaignId: string, date: Date, share: string | null, impressions: number, placement = 'Top of Search on-Amazon', marketplace = 'IT') =>
      db.amazonAdsPlacementReport.create({ data: {
        profileId: 'P-VIS', marketplace, adProduct: 'SPONSORED_PRODUCTS', date, campaignId, placement, impressions, currencyCode: 'EUR', topOfSearchIS: share,
      } as never })
    await top('EXT-VIS-1', ago(2), '0.4000', 300)
    await top('EXT-VIS-1', ago(3), '0.1000', 100)
    await top('EXT-VIS-1', ago(20), '0.9000', 1000) // older than 7 days: out of the tracker's fact, inside the board's 30
    await top('EXT-VIS-2', ago(1), '0.2000', 100)
    // Review fix — the campaign report's own rows: a day the placement table lacks is read from them; a day it has is not.
    const itCampaignDay = (entityId: string, date: Date, share: string, impressions: number) => db.amazonAdsDailyPerformance.create({ data: {
      profileId: 'P-VIS', currencyCode: 'EUR', entityType: 'CAMPAIGN', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', reportedAt: ago(0),
      date, entityId, impressions, topOfSearchIS: share,
    } as never })
    await itCampaignDay('EXT-VIS-2', ago(2), '0.6000', 100) // no placement reading that day: used
    await itCampaignDay('EXT-VIS-1', ago(2), '0.9000', 5000) // the placement row has that day: not used

    // ── DE, for the report specs ──
    const de = (data: Record<string, unknown>) => db.searchQueryPerformance.create({ data: { marketplace: 'DE', reportPeriod: 'WEEK', searchQuery: 'helmet', ...data } as never })
    await de({ startDate: day('2026-09-06'), asin: 'ASIN-DE-X', searchQueryVolume: 500, impressionsTotal: 2000, impressionsBrand: 100, clicksTotal: 100, clicksBrand: 10 })
    await de({ startDate: day('2026-09-06'), asin: 'ASIN-DE-Y', searchQueryVolume: 500, impressionsTotal: 2000, impressionsBrand: 60, clicksTotal: 100, clicksBrand: 5 })
    await de({ startDate: day('2026-09-13'), asin: 'ASIN-DE-X', searchQueryVolume: 300, impressionsTotal: 1000, impressionsBrand: 50, clicksTotal: 50, clicksBrand: 5 })
    await de({ startDate: day('2026-09-06'), asin: 'ASIN-DE-X', reportPeriod: 'MONTH', searchQueryVolume: 99_999, impressionsTotal: 99_999, impressionsBrand: 99_999 })
    await de({ startDate: day('2026-09-06'), asin: null, searchQueryVolume: 500, impressionsTotal: 2000, impressionsBrand: 400 })

    await top('EXT-VIS-3', day('2026-09-10'), '0.5000', 100, 'Top of Search on-Amazon', 'DE')
    await top('EXT-VIS-3', day('2026-09-11'), '0.1000', 900, 'Top of Search on-Amazon', 'DE')
    await top('EXT-VIS-3', day('2026-09-10'), null, 500, 'Other on-Amazon', 'DE')
    const perf = (date: string, share: string | null, impressions: number) => db.amazonAdsDailyPerformance.create({ data: {
      profileId: 'P-VIS', currencyCode: 'EUR', entityType: 'CAMPAIGN', marketplace: 'DE', adProduct: 'SPONSORED_PRODUCTS', reportedAt: day('2026-09-20'),
      date: day(date), entityId: 'EXT-VIS-3', impressions, topOfSearchIS: share,
    } as never })
    await perf('2026-09-10', '0.5000', 200)
    await perf('2026-09-11', '0.1000', 800)
    await perf('2026-09-12', null, 5000) // no share that day: out of both sides of the average
  })
}, 180_000)
afterAll(async () => { await database?.close() })

describe('B2 / C6 / B3 — the Keyword Tracker', () => {
  it('computes the share from the counts, never the stored column; a zero query total is a measured row with no share', async () => {
    const out = await inside(() => getKeywordTracker({ market: 'IT' }))
    expect(out.window.period).toBe(iso(W1))
    const race = out.rows.find((r) => r.keyword === 'race jacket')!
    expect(race.state).toBe('measured')
    expect(race.impressionShare).toBeCloseTo(300 / 10_000, 10) // not the stored 0.9, and not the MONTH row
    expect(race.bestAsin).toBe('ASIN-VIS-A')
    expect(race.shareBound).toBeCloseTo(500 / 10_000, 10)
    expect(race.searchQueryScore).toBe(3)
    expect(race).not.toHaveProperty('marketRank')
    expect(race.marketVolume).toBe(1000)
    // Δ against the prior week's best ASIN, also from the counts: 160 / 8,000
    expect(race.priorShare).toBeCloseTo(0.02, 10)
    expect(race.deltaPP).toBeCloseTo(1, 8)

    const gloves = out.rows.find((r) => r.keyword === 'winter gloves')!
    expect(gloves.state).toBe('measured')
    expect(gloves.impressionShare).toBeNull()
    expect(gloves.bestAsin).toBeNull()
    expect(gloves.deltaPP).toBeNull()
    expect(gloves.searchQueryScore).toBe(7)
    expect(out.rows.find((r) => r.keyword === 'rain suit')!.state).toBe('never-measured')
    // Review fix — a stored volume of 0 is not reported: no volume, and no −100 % market change from it.
    const storm = out.rows.find((r) => r.keyword === 'storm jacket')!
    expect(storm).toMatchObject({ state: 'measured', marketVolume: null, marketDeltaPct: null })
    expect(race.marketVolume).toBe(1000)
  })

  it('the top-of-search scope fact: readings of the last 7 days only, impression-weighted, campaign-level, dated both ends', async () => {
    const { topOfSearch } = await inside(() => getKeywordTracker({ market: 'IT' }))
    // (0.40×300 + 0.10×100 + 0.20×100 + 0.60×100 from the campaign report) ÷ 600 — the 20-day-old 0.90 reading is left
    // out, and so is the campaign row of a day the placement table already has
    expect(topOfSearch).toMatchObject({
      grain: 'campaign', campaignsWithReading: 2, campaignsInScope: 2, readings: 4,
      oldest: iso(ago(3)), newest: iso(ago(1)), asOf: iso(ago(1)), windowDays: 7,
      sources: { placementReport: 3, campaignReport: 1 },
    })
    expect(topOfSearch!.avgShare).toBeCloseTo(0.35, 10)
    expect(topOfSearch!.basis).toMatch(/^campaign-level: .*; source: Amazon's placement report \(3 readings\) and campaign report \(1 reading\)$/)
  })

  it('the term drawer agrees with the row: shares from the counts, a null share stays null, no MONTH week in the series', async () => {
    const race = await inside(() => getKeywordTerm({ market: 'IT', keyword: 'race jacket' }))
    expect(race.header).toMatchObject({ searchQueryScore: 3, bestAsin: 'ASIN-VIS-A' })
    expect(race.header!.share).toBeCloseTo(0.03, 10)
    expect(race.header!.shareBound).toBeCloseTo(0.05, 10)
    expect(race.asins.map((a) => a.share)).toEqual([0.03, 0.02])
    expect(race.asins[0].clickShare).toBeCloseTo(20 / 500, 10)
    const byWeek = new Map(race.series.points.map((p) => [p.week, p]))
    expect(byWeek.get(iso(W1))!.share).toBeCloseTo(0.03, 10)
    expect(byWeek.get(iso(W0))!.share).toBeCloseTo(0.02, 10)

    expect((await inside(() => getKeywordTerm({ market: 'IT', keyword: 'storm jacket' }))).header).toMatchObject({ marketVolume: null })
    const gloves = await inside(() => getKeywordTerm({ market: 'IT', keyword: 'winter gloves' }))
    expect(gloves.header).toMatchObject({ share: null, searchQueryScore: 7, bestAsin: null })
    expect(gloves.asins.map((a) => a.share)).toEqual([null])
    expect(gloves.series.points).toEqual([]) // no reading is a gap, never a 0 % point
  })
})

describe('D2 / D3 — the report specs', () => {
  const base = { from: '2026-09-01', to: '2026-09-30', marketplaces: ['DE'], page: 1, pageSize: 50 }

  it('SQP: each (query, week, market) total once, weekly ASIN rows only, shares from those totals', async () => {
    const out = await inside(() => runReport({
      ...base, reportId: 'sqp', groupBy: ['searchQuery'],
      columns: ['searchQuery', 'volume', 'impressionsTotal', 'impressionsBrand', 'impressionShare', 'clickShare'],
    }))
    const helmet = out.rows.find((r) => r.searchQuery === 'helmet')!
    expect(Number(helmet.volume)).toBe(800)              // 500 + 300 — not ×2 ASINs, not the MONTH or brand row
    expect(Number(helmet.impressionsTotal)).toBe(3000)   // 2,000 + 1,000
    expect(Number(helmet.impressionsBrand)).toBe(210)    // 100 + 60 + 50 — the ASIN-less row is not one of ours
    expect(Number(helmet.impressionShare)).toBeCloseTo(210 / 3000, 10)
    expect(Number(helmet.clickShare)).toBeCloseTo(20 / 150, 10)
    expect(Number(out.totals!.volume)).toBe(800)
    expect(Number(out.totals!.impressionShare)).toBeCloseTo(210 / 3000, 10)
  })

  it('SQP grouped by ASIN: each ASIN against the totals of the query-weeks it holds', async () => {
    const out = await inside(() => runReport({ ...base, reportId: 'sqp', groupBy: ['asin'], columns: ['asin', 'impressionsTotal', 'impressionShare'] }))
    const by = new Map(out.rows.map((r) => [r.asin, r]))
    expect([...by.keys()].sort()).toEqual(['ASIN-DE-X', 'ASIN-DE-Y'])
    expect(Number(by.get('ASIN-DE-X')!.impressionsTotal)).toBe(3000)
    expect(Number(by.get('ASIN-DE-X')!.impressionShare)).toBeCloseTo(150 / 3000, 10)
    expect(Number(by.get('ASIN-DE-Y')!.impressionShare)).toBeCloseTo(60 / 2000, 10)
  })

  it('placement: Top-of-search IS is the impression-weighted average of the campaign-days, labelled as Nexus\'s', async () => {
    const out = await inside(() => runReport({ ...base, reportId: 'placement', groupBy: ['placement'], columns: ['placement', 'impressions', 'topOfSearchIS'] }))
    const topRow = out.rows.find((r) => r.placement === 'Top of Search on-Amazon')!
    expect(Number(topRow.topOfSearchIS)).toBeCloseTo((0.5 * 100 + 0.1 * 900) / 1000, 10) // 0.14, where MAX said 0.50
    expect(out.rows.find((r) => r.placement === 'Other on-Amazon')!.topOfSearchIS).toBeNull()
    const col = out.columns.find((c) => c.id === 'topOfSearchIS')!
    expect(col.label).toBe('Top-of-search IS (weighted avg, Nexus)')
    expect(col.help).toMatch(/^Weighted avg \(Nexus\) of Amazon’s daily campaign shares/)
  })

  it('campaign: the same weighting; a day with no share is left out of both sides', async () => {
    const out = await inside(() => runReport({ ...base, reportId: 'campaign', groupBy: ['campaign'], columns: ['campaign', 'topOfSearchIS'] }))
    expect(out.rows).toHaveLength(1)
    expect(Number(out.rows[0].topOfSearchIS)).toBeCloseTo((0.5 * 200 + 0.1 * 800) / 1000, 10)
  })
})

describe('T5 / S5 — the coverage board', () => {
  it('a keyword row\'s ToS IS is campaign-level and says so; the 1,000 floor reads the query total once', async () => {
    const board = await inside(() => getCoverageScoreboard({ marketplace: 'IT', week: iso(W1) }))
    expect(board.rows.map((r) => r.term)).toEqual(['race jacket']) // "neck warmer" is 600, not 2 × 600
    const race = board.rows[0]
    expect(race.share).toBeCloseTo(500 / 10_000, 10)
    // both holding campaigns, every reading of the last 30 days, impression-weighted
    expect(race.tosIS).toBeCloseTo((0.4 * 300 + 0.1 * 100 + 0.9 * 1000 + 0.2 * 100) / 1500, 10)
    expect(race.tosIsGrain).toBe('campaign')
    expect(race.tosIsCampaigns).toBe(2)
    expect(board.tosIsBasis).toMatch(/^campaign-level \(campaigns holding this keyword\)/)
    expect(board.notes.join('\n')).toMatch(/ToS-IS on a keyword row is campaign-level \(campaigns holding this keyword\)/)
    expect(board.notes.join('\n')).not.toMatch(/page one/i)
  })
})

describe('C2 — the hours research\'s lanes', () => {
  it('the top-of-search share comes with its campaigns, its days with a reading and its newest date', async () => {
    const lanes = await inside(() => loadLanes(['EXT-VIS-1', 'EXT-VIS-2'], [iso(ago(10)), iso(ago(0))]))
    const top = lanes.find((l) => l.lane === 'TOP_OF_SEARCH')!
    expect(top.topOfSearchSharePct).toBeCloseTo(30, 6)
    expect(top.topOfSearchShareBasis).toEqual({ campaigns: 2, days: 3, newest: iso(ago(1)) })
  })
})
