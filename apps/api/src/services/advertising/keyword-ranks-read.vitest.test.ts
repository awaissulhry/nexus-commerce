/**
 * The Keyword Tracker hand routes' pure parts (2026-10-10, honest numbers — AUDIT K1, K2, B5). Fake keywords and ASINs.
 *
 *   K1  a rank below 1 is refused — it used to become #1.
 *   K2  a row with no capturedAt is refused — it used to be dated "now".
 *   B5  GET: one item per keyword × market × ASIN (no delta across two ASINs); a reading that carries a rank represents
 *       the item over the feed's search-volume-only rows; ageDays + stale against KEYWORD_RANK_MAX_AGE_DAYS.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { cleanKeywordRankImport, collapseKeywordRanks, KEYWORD_RANK_MAX_AGE_DAYS, type StoredKeywordRank } from './keyword-ranks-read.js'

const AT = '2026-10-01T10:00:00Z'

describe('cleanKeywordRankImport — K1 / K2', () => {
  it('a valid row is stored as given (market upper-cased, source manual by default)', () => {
    const r = cleanKeywordRankImport([{ keyword: ' test jacket ', marketplace: 'it', asin: 'B0FAKE0001', organicRank: 4, sponsoredRank: 2, searchVolume: 1200, capturedAt: AT }])
    expect(r.refused).toEqual([])
    expect(r.rows).toEqual([{ keyword: 'test jacket', marketplace: 'IT', asin: 'B0FAKE0001', organicRank: 4, sponsoredRank: 2, searchVolume: 1200, capturedAt: new Date(AT), source: 'manual' }])
  })

  it('K1: a rank of 0 or below is refused, never turned into #1; nothing of the import is kept', () => {
    const r = cleanKeywordRankImport([
      { keyword: 'good', marketplace: 'IT', organicRank: 3, capturedAt: AT },
      { keyword: 'zero', marketplace: 'IT', organicRank: 0, capturedAt: AT },
      { keyword: 'negative', marketplace: 'IT', sponsoredRank: -2, capturedAt: AT },
      { keyword: 'junk', marketplace: 'IT', organicRank: 'abc' as unknown as number, capturedAt: AT },
    ])
    expect(r.refused.map((x) => [x.index, x.keyword])).toEqual([[1, 'zero'], [2, 'negative'], [3, 'junk']])
    expect(r.refused[0].reason).toContain('below 1')
    expect(r.refused[2].reason).toContain('not a number')
  })

  it('a negative or non-numeric search volume is refused, never clamped to 0 or dropped; 0 and an absent one pass', () => {
    const r = cleanKeywordRankImport([
      { keyword: 'negative', marketplace: 'IT', searchVolume: -40, capturedAt: AT },
      { keyword: 'junk', marketplace: 'IT', searchVolume: 'lots' as unknown as number, capturedAt: AT },
    ])
    expect(r.rows).toEqual([])
    expect(r.refused.map((x) => x.keyword)).toEqual(['negative', 'junk'])
    expect(r.refused[0].reason).toContain('searchVolume -40 is not a count of searches (0 or more)')
    const ok = cleanKeywordRankImport([
      { keyword: 'zero', marketplace: 'IT', searchVolume: 0, capturedAt: AT },
      { keyword: 'none', marketplace: 'IT', organicRank: 3, capturedAt: AT },
    ])
    expect(ok.refused).toEqual([])
    expect(ok.rows.map((x) => x.searchVolume)).toEqual([0, null])
  })

  it('K2: capturedAt is required and must be a date — a missing one is not "now"', () => {
    const r = cleanKeywordRankImport([
      { keyword: 'no-date', marketplace: 'IT', organicRank: 5 },
      { keyword: 'bad-date', marketplace: 'IT', organicRank: 5, capturedAt: 'yesterday-ish' },
    ])
    expect(r.rows).toEqual([])
    expect(r.refused[0].reason).toContain('capturedAt is required')
    expect(r.refused[1].reason).toContain('is not a date')
  })

  it('rows with no keyword or market are skipped and counted, as before; an absent rank stays null', () => {
    const r = cleanKeywordRankImport([{ marketplace: 'IT', capturedAt: AT }, { keyword: 'vol only', marketplace: 'DE', searchVolume: 50, capturedAt: AT }])
    expect(r.skipped).toBe(1)
    expect(r.rows[0]).toMatchObject({ organicRank: null, sponsoredRank: null, searchVolume: 50 })
  })
})

describe('collapseKeywordRanks — B5', () => {
  const now = new Date('2026-10-10T12:00:00Z')
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000)
  let n = 0
  const rank = (over: Partial<StoredKeywordRank>): StoredKeywordRank => ({
    id: `kr-${++n}`, keyword: 'test jacket', marketplace: 'IT', asin: null,
    organicRank: null, sponsoredRank: null, searchVolume: null, capturedAt: daysAgo(1), source: 'manual', ...over,
  })

  it('two ASINs on one keyword are two items: no delta is ASIN A minus ASIN B', () => {
    const items = collapseKeywordRanks([
      rank({ asin: 'B0FAKE0001', organicRank: 5, capturedAt: daysAgo(1) }),
      rank({ asin: 'B0FAKE0002', organicRank: 40, capturedAt: daysAgo(2) }),
      rank({ asin: 'B0FAKE0001', organicRank: 8, capturedAt: daysAgo(3) }),
    ], now)
    expect(items.map((i) => [i.asin, i.organicRank, i.rankDelta])).toEqual([['B0FAKE0001', 5, 3], ['B0FAKE0002', 40, null]])
  })

  it('a reading with a rank represents the item over a newer search-volume-only feed row; the volume keeps its own date', () => {
    const items = collapseKeywordRanks([
      rank({ source: 'brand-analytics-sqp', searchVolume: 900, capturedAt: daysAgo(1) }),
      rank({ organicRank: 12, capturedAt: daysAgo(4) }),
      rank({ organicRank: 15, capturedAt: daysAgo(6) }),
    ], now)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ organicRank: 12, ageDays: 4, stale: false, rankDelta: 3, searchVolume: 900, searchVolumeCapturedAt: daysAgo(1) })
  })

  it(`ageDays and stale past ${KEYWORD_RANK_MAX_AGE_DAYS} days; a delta against a stale prior is null`, () => {
    const items = collapseKeywordRanks([
      rank({ keyword: 'old', organicRank: 7, capturedAt: daysAgo(KEYWORD_RANK_MAX_AGE_DAYS + 3) }),
      rank({ keyword: 'fresh', organicRank: 7, capturedAt: daysAgo(2) }),
      rank({ keyword: 'fresh', organicRank: 9, capturedAt: daysAgo(KEYWORD_RANK_MAX_AGE_DAYS + 1) }),
    ], now)
    const old = items.find((i) => i.keyword === 'old')!
    const fresh = items.find((i) => i.keyword === 'fresh')!
    expect(old).toMatchObject({ ageDays: KEYWORD_RANK_MAX_AGE_DAYS + 3, stale: true })
    expect(fresh).toMatchObject({ ageDays: 2, stale: false, rankDelta: null })
    expect(fresh.priorCapturedAt).toEqual(daysAgo(KEYWORD_RANK_MAX_AGE_DAYS + 1))
  })

  it('no rank anywhere: the newest reading represents it, rankDelta null; sorted by keyword and capped by limit', () => {
    const items = collapseKeywordRanks([
      rank({ keyword: 'b', searchVolume: 10 }),
      rank({ keyword: 'a', searchVolume: 20 }),
      rank({ keyword: 'c', searchVolume: 30 }),
    ], now, 2)
    expect(items.map((i) => [i.keyword, i.searchVolume, i.rankDelta])).toEqual([['a', 20, null], ['b', 10, null]])
  })
})
