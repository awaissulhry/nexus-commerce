/**
 * The Keyword Tracker's feed: KeywordRank rows from Brand Analytics weeks Nexus already holds.
 *
 * Pinned: only search volume is written and every rank stays NULL (no source exists — never invented); only keywords
 * Nexus bids on in that market; a week that has not ended, or one Amazon gave no volume for, writes nothing (never a
 * zero); a (market, keyword, week) is written once however often the feed runs; the reading is dated at the week's
 * end, so the evaluator's 14-day limit measures the data's age. And the sentence a rule on a rank with no source gets.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    adTarget: { findMany: vi.fn() },
    searchQueryPerformance: { groupBy: vi.fn() },
    keywordRank: { findMany: vi.fn(), createMany: vi.fn(), count: vi.fn() },
  },
}))

import prisma from '../../db.js'
import {
  KEYWORD_RANK_FEED_SOURCE, KEYWORD_RANK_MAX_AGE_DAYS, conditionFields, keywordRankFeedSummaryLine, keywordRankFieldCensus,
  planKeywordRankFeedRows, runKeywordRankFeed, sqpWeekEnd, unsourcedRankNote,
} from './keyword-rank-feed.service.js'

const db = vi.mocked(prisma, true)

// Brand Analytics weeks run Sunday → Saturday; 2026-09-27 is a Sunday.
const WEEK = new Date('2026-09-27T00:00:00Z')
const WEEK_BEFORE = new Date('2026-09-20T00:00:00Z')
const NOW = new Date('2026-10-07T06:40:00Z')

const cell = (o: Partial<{ marketplace: string; startDate: Date; searchQuery: string; volume: number | null }> = {}) => ({
  marketplace: 'IT', startDate: WEEK, searchQuery: 'giacca moto', volume: 6150, ...o,
})
const bid = (keyword: string, marketplace: string | null = 'IT') => ({ keyword, marketplace })

describe('planKeywordRankFeedRows — the mapper', () => {
  it('writes search volume only, dated at the week end; every rank and the ASIN stay NULL', () => {
    const plan = planKeywordRankFeedRows({ cells: [cell()], targets: [bid('giacca moto')], existing: [], now: NOW })
    expect(plan.rows).toEqual([{
      keyword: 'giacca moto', marketplace: 'IT', asin: null, organicRank: null, sponsoredRank: null,
      searchVolume: 6150, capturedAt: new Date('2026-10-04T00:00:00Z'), source: KEYWORD_RANK_FEED_SOURCE,
    }])
    expect(sqpWeekEnd(WEEK).toISOString()).toBe('2026-10-04T00:00:00.000Z')
  })

  it('only keywords Nexus bids on, in the market it bids on them', () => {
    const plan = planKeywordRankFeedRows({
      cells: [cell(), cell({ searchQuery: 'casco moto' }), cell({ marketplace: 'DE' })],
      targets: [bid('giacca moto', 'IT')],
      existing: [], now: NOW,
    })
    expect(plan.rows.map((r) => `${r.marketplace}:${r.keyword}`)).toEqual(['IT:giacca moto'])
    expect(plan.notBidOn).toBe(2)
  })

  it('matches a target case- and space-insensitively, and folds two spellings into one row with the larger volume', () => {
    const plan = planKeywordRankFeedRows({
      cells: [cell({ searchQuery: 'Giacca Moto ', volume: 5000 }), cell({ searchQuery: 'giacca moto', volume: 6150 })],
      targets: [bid('  GIACCA moto')],
      existing: [], now: NOW,
    })
    expect(plan.rows).toHaveLength(1)
    expect(plan.rows[0]).toMatchObject({ keyword: 'giacca moto', searchVolume: 6150 })
  })

  it('🔴 a volume Amazon did not report is not a zero: nothing is written', () => {
    const plan = planKeywordRankFeedRows({
      cells: [cell({ volume: 0 }), cell({ searchQuery: 'giacca moto uomo', volume: null })],
      targets: [bid('giacca moto'), bid('giacca moto uomo')],
      existing: [], now: NOW,
    })
    expect(plan.rows).toEqual([])
    expect(plan.noVolume).toBe(2)
  })

  it('a week that has not ended writes nothing', () => {
    const running = new Date('2026-10-04T00:00:00Z') // ends 2026-10-11, after NOW
    const plan = planKeywordRankFeedRows({ cells: [cell({ startDate: running })], targets: [bid('giacca moto')], existing: [], now: NOW })
    expect(plan.rows).toEqual([])
  })

  it('a (market, keyword, week) already written is not written again; an older week still is', () => {
    const plan = planKeywordRankFeedRows({
      cells: [cell(), cell({ startDate: WEEK_BEFORE, volume: 5800 })],
      targets: [bid('giacca moto')],
      existing: [{ marketplace: 'IT', keyword: 'giacca moto', capturedAt: new Date('2026-10-04T00:00:00Z') }],
      now: NOW,
    })
    expect(plan.alreadyWritten).toBe(1)
    expect(plan.rows.map((r) => r.capturedAt.toISOString())).toEqual(['2026-09-27T00:00:00.000Z'])
  })

  it('reports each market the business bids in: its newest week and how many bid-on keywords it covers', () => {
    const plan = planKeywordRankFeedRows({
      cells: [cell(), cell({ searchQuery: 'giacca moto uomo' }), cell({ startDate: WEEK_BEFORE })],
      targets: [bid('giacca moto'), bid('giacca moto uomo'), bid('motorradjacke', 'DE')],
      existing: [], now: NOW,
    })
    expect(plan.markets).toEqual([
      { marketplace: 'DE', newestWeekEnd: null, keywordsInNewestWeek: 0 },
      { marketplace: 'IT', newestWeekEnd: '2026-10-04', keywordsInNewestWeek: 2 },
    ])
    const line = keywordRankFeedSummaryLine(plan, plan.rows.length, NOW)
    expect(line).toContain('created=3')
    expect(line).toContain('IT week to 2026-10-04 (3d) 2 kw')
    expect(line).toContain('DE no Brand Analytics week in 28d')
    expect(line).toContain('organic/sponsored rank: no source')
  })

  it('the summary says when a market\'s newest week is too old for a rule to use', () => {
    const plan = planKeywordRankFeedRows({ cells: [cell({ startDate: WEEK_BEFORE })], targets: [bid('giacca moto')], existing: [], now: new Date('2026-10-20T06:40:00Z') })
    expect(keywordRankFeedSummaryLine(plan, 1, new Date('2026-10-20T06:40:00Z'))).toContain(`older than ${KEYWORD_RANK_MAX_AGE_DAYS}d, rules ignore it`)
  })
})

describe('runKeywordRankFeed — the cron job body', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.keywordRank.createMany.mockImplementation((async ({ data }: { data: unknown[] }) => ({ count: data.length })) as never)
  })

  it('reads the keyword targets, the Brand Analytics weeks and its own rows, then writes only the new rows', async () => {
    db.adTarget.findMany.mockResolvedValue([
      { expressionValue: 'giacca moto', adGroup: { campaign: { marketplace: 'IT' } } },
      { expressionValue: 'giacca moto uomo', adGroup: { campaign: { marketplace: 'IT' } } },
    ] as never)
    db.searchQueryPerformance.groupBy.mockResolvedValue([
      { marketplace: 'IT', startDate: WEEK, searchQuery: 'giacca moto', _max: { searchQueryVolume: 6150 } },
      { marketplace: 'IT', startDate: WEEK, searchQuery: 'giacca moto uomo', _max: { searchQueryVolume: 2210 } },
      { marketplace: 'IT', startDate: WEEK, searchQuery: 'casco', _max: { searchQueryVolume: 9000 } },
    ] as never)
    db.keywordRank.findMany.mockResolvedValue([
      { marketplace: 'IT', keyword: 'giacca moto', capturedAt: new Date('2026-10-04T00:00:00Z') },
    ] as never)

    const out = await runKeywordRankFeed(NOW)

    expect(out.created).toBe(1)
    const written = (db.keywordRank.createMany.mock.calls[0]?.[0] as { data: Array<Record<string, unknown>> }).data
    expect(written).toEqual([expect.objectContaining({ keyword: 'giacca moto uomo', marketplace: 'IT', searchVolume: 2210, organicRank: null, sponsoredRank: null, asin: null })])

    // 🔴 Asserted on the QUERIES: the mocks return whatever they are given, so the filters must be checked where they are made.
    const targetsWhere = (db.adTarget.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where
    expect(targetsWhere).toEqual({ kind: 'KEYWORD', isNegative: false, status: { in: ['ENABLED', 'PAUSED'] } })
    const sqp = db.searchQueryPerformance.groupBy.mock.calls[0]?.[0] as { by: string[]; where: { reportPeriod: string; startDate: { gte: Date } } }
    expect(sqp.by).toEqual(['marketplace', 'startDate', 'searchQuery'])
    expect(sqp.where.reportPeriod).toBe('WEEK')
    // weeks that END within the lookback: start ≥ now − 28 d − 7 d
    expect(sqp.where.startDate.gte.toISOString()).toBe('2026-09-02T06:40:00.000Z')
    const own = db.keywordRank.findMany.mock.calls[0]?.[0] as { where: { source: string } }
    expect(own.where.source).toBe(KEYWORD_RANK_FEED_SOURCE)
    expect(out.summary).toContain('created=1 alreadyWritten=1 notBidOn=1')
  })

  it('writes nothing — and makes no write call — when there is nothing new', async () => {
    db.adTarget.findMany.mockResolvedValue([{ expressionValue: 'giacca moto', adGroup: { campaign: { marketplace: 'IT' } } }] as never)
    db.searchQueryPerformance.groupBy.mockResolvedValue([] as never)
    db.keywordRank.findMany.mockResolvedValue([] as never)
    const out = await runKeywordRankFeed(NOW)
    expect(out.created).toBe(0)
    expect(db.keywordRank.createMany).not.toHaveBeenCalled()
    expect(out.summary).toContain('IT no Brand Analytics week in 28d')
  })
})

describe('the rank no source fills — said in words', () => {
  const census = { maxAgeDays: 14, organicRank: 0, sponsoredRank: 0 }

  it('names Organic Rank, and why it has no source', () => {
    const note = unsourcedRankNote(['adTarget.organicRank', 'adTarget.acos'], census)
    expect(note).toBe('Organic Rank has no automatic source: Amazon publishes no organic search position, so Nexus\'s keyword feed (Amazon Brand Analytics) fills Search Volume only. It comes only from a hand import, and no keyword has a reading of it from the last 14 days — a condition on it matches no keyword.')
  })

  it('names every such metric the rule reads, with each reason', () => {
    const note = unsourcedRankNote(['adTarget.organicRank', 'adTarget.sponsoredRank', 'adTarget.rankDelta'], census)
    expect(note).toContain('Organic Rank, Sponsored Rank and Rank Change have no automatic source')
    expect(note).toContain('advertising console only')
    expect(note).toContain('They come only from a hand import')
  })

  it('says nothing for a rule on Search Volume, or once an import supplied the rank', () => {
    expect(unsourcedRankNote(['adTarget.searchVolume', 'adTarget.acos'], census)).toBeNull()
    expect(unsourcedRankNote(['adTarget.organicRank'], { ...census, organicRank: 3 })).toBeNull()
  })

  it('collects the fields of flat leaves, builder blocks and trees alike', () => {
    expect(conditionFields([{ field: 'adTarget.organicRank', op: 'gt', value: 20 }]).sort()).toEqual(['adTarget.organicRank'])
    expect(conditionFields({ conditions: [{ field: 'a' }], blocks: [{ conditions: [{ field: 'b' }] }] }).sort()).toEqual(['a', 'b'])
    expect(conditionFields({ and: [{ or: [{ field: 'x' }] }, { not: { field: 'y' } }] }).sort()).toEqual(['x', 'y'])
    expect(conditionFields(null)).toEqual([])
  })

  it('the census counts readings inside the freshness limit, per field', async () => {
    db.keywordRank.count.mockImplementation((async ({ where }: { where: Record<string, unknown> }) =>
      ('organicRank' in where || 'sponsoredRank' in where ? 0 : 7)) as never)
    const c = await keywordRankFieldCensus(NOW)
    expect(c).toEqual({ maxAgeDays: 14, freshRows: 7, organicRank: 0, sponsoredRank: 0, searchVolume: 7 })
    const since = (db.keywordRank.count.mock.calls[0]?.[0] as { where: { capturedAt: { gte: Date } } }).where.capturedAt.gte
    expect(since.toISOString()).toBe('2026-09-23T06:40:00.000Z')
  })
})
