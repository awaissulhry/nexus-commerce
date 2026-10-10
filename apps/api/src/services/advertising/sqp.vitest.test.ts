import { describe, it, expect } from 'vitest'
import { parseSqp, share, periodWindow, shareOrNull, sqpRowShares, parseSqpPeriod, familyImpressionShare } from './sqp.service.js'

describe('periodWindow', () => {
  it('WEEK: completed Sunday→Saturday, end is the Saturday (SQP requirement)', () => {
    // Wed 2026-05-27. Current week's Sunday = 2026-05-24; previous completed
    // week = 2026-05-17 (Sun) .. 2026-05-23 (Sat, inclusive).
    const w = periodWindow('WEEK', new Date('2026-05-27T10:00:00Z'))
    expect(w.start.toISOString().slice(0, 10)).toBe('2026-05-17')
    expect(w.end.toISOString().slice(0, 10)).toBe('2026-05-23')
    expect(w.start.getUTCDay()).toBe(0) // Sunday
    expect(w.end.getUTCDay()).toBe(6) // Saturday
  })
  it('WEEK lookback=2 steps back another full week (Sun→Sat)', () => {
    const w = periodWindow('WEEK', new Date('2026-05-27T10:00:00Z'), 2)
    expect(w.start.toISOString().slice(0, 10)).toBe('2026-05-10')
    expect(w.end.toISOString().slice(0, 10)).toBe('2026-05-16')
    expect(w.end.getUTCDay()).toBe(6)
  })
  it('MONTH: previous full calendar month, end = month-end', () => {
    const w = periodWindow('MONTH', new Date('2026-05-15T10:00:00Z'))
    expect(w.start.toISOString().slice(0, 10)).toBe('2026-04-01')
    expect(w.end.toISOString().slice(0, 10)).toBe('2026-04-30')
  })
  it('QUARTER: previous full quarter, end = quarter-end', () => {
    const w = periodWindow('QUARTER', new Date('2026-05-15T10:00:00Z'))
    // Q2 in progress → previous completed = Q1 (Jan–Mar)
    expect(w.start.toISOString().slice(0, 10)).toBe('2026-01-01')
    expect(w.end.toISOString().slice(0, 10)).toBe('2026-03-31')
  })
})

describe('share', () => {
  it('brand / total, clamped to [0,1] (the WRITE path: the columns are NOT NULL)', () => {
    expect(share(30, 120)).toBeCloseTo(0.25, 5)
    expect(share(5, 0)).toBe(0) // no market volume → 0, not NaN (stored only; readers use shareOrNull)
    expect(share(150, 100)).toBe(1) // never above 1
  })
})

describe('shareOrNull / sqpRowShares — a reader computes the share from the counts (S1, 2026-10-10)', () => {
  it('null when the market count is 0 or missing — a stored 0 there means "not reported", not "we hold none"', () => {
    expect(shareOrNull(5, 0)).toBeNull()
    expect(shareOrNull(0, 0)).toBeNull()
    expect(shareOrNull(3, null)).toBeNull()
    expect(shareOrNull(3, undefined)).toBeNull()
    expect(shareOrNull(3, -1)).toBeNull()
  })
  it('0 stays a real answer when the market count is real; clamped to [0,1]', () => {
    expect(shareOrNull(0, 200)).toBe(0)
    expect(shareOrNull(50, 200)).toBeCloseTo(0.25, 10)
    expect(shareOrNull(300, 200)).toBe(1)
  })
  it('all four funnel stages, each on its own counts', () => {
    expect(sqpRowShares({
      impressionsTotal: 1000, impressionsBrand: 10, clicksTotal: 0, clicksBrand: 0,
      cartAddsTotal: 40, cartAddsBrand: 0, purchasesTotal: 0, purchasesBrand: 0,
    })).toEqual({ impressionShare: 0.01, clickShare: null, cartAddShare: 0, purchaseShare: null })
  })
})

describe('parseSqpPeriod — one period at a time, WEEK unless asked', () => {
  it('absent or blank → WEEK; a known period in any case; anything else → null (the route refuses it)', () => {
    expect(parseSqpPeriod(undefined)).toBe('WEEK')
    expect(parseSqpPeriod('')).toBe('WEEK')
    expect(parseSqpPeriod('month')).toBe('MONTH')
    expect(parseSqpPeriod(' QUARTER ')).toBe('QUARTER')
    expect(parseSqpPeriod('YEAR')).toBeNull()
  })
})

describe('familyImpressionShare — S4: the market total once per query, our ASIN counts summed', () => {
  it('two ASINs on one query: total counted once (it is repeated on each ASIN row), ours added', () => {
    // One query, market total 1000 repeated on both ASIN rows; our ASINs took 30 + 20.
    const r = familyImpressionShare([
      { searchQuery: 'test jacket', impressionsBrand: 30, impressionsTotal: 1000 },
      { searchQuery: 'test jacket', impressionsBrand: 20, impressionsTotal: 1000 },
    ])
    expect(r).toEqual({ share: 0.05, ours: 50, market: 1000 })
    // The old loop added the total once per row: 50 / 2000 = 0.025, understated ×2.
  })
  it('several queries: Σ ours ÷ Σ (one market total per query)', () => {
    const r = familyImpressionShare([
      { searchQuery: 'q1', impressionsBrand: 10, impressionsTotal: 100 },
      { searchQuery: 'q1', impressionsBrand: 0, impressionsTotal: 100 },
      { searchQuery: 'q1', impressionsBrand: 5, impressionsTotal: 100 },
      { searchQuery: 'q2', impressionsBrand: 25, impressionsTotal: 400 },
    ])
    expect(r.market).toBe(500)
    expect(r.ours).toBe(40)
    expect(r.share).toBeCloseTo(0.08, 10)
  })
  it('a query with no market total is left out; none at all → null, never 0', () => {
    expect(familyImpressionShare([{ searchQuery: 'q', impressionsBrand: 4, impressionsTotal: 0 }]).share).toBeNull()
    expect(familyImpressionShare([]).share).toBeNull()
    const r = familyImpressionShare([
      { searchQuery: 'q-none', impressionsBrand: 9, impressionsTotal: 0 },
      { searchQuery: 'q-real', impressionsBrand: 0, impressionsTotal: 300 },
    ])
    expect(r).toEqual({ share: 0, ours: 0, market: 300 }) // a real 0: none of a real total
  })
})

describe('parseSqp', () => {
  /**
   * ACR.0.2 — every fixture below this line was WRITTEN FROM THE PARSER'S OWN ASSUMPTION,
   * never from a captured Amazon payload. They all passed while prod produced 9,232 rows
   * whose "our side" counts were 0 and whose totals were 53.1M, because the totals list
   * happened to contain a real key and the brand list did not contain any.
   *
   * A green suite proved the parser self-consistent, not correct. Keep them (they pin the
   * fallbacks), but treat a CAPTURED payload as the only source of truth about shape.
   */
  /**
   * VERBATIM from a payload Amazon returned on 2026-08-05 (IT, ASIN B0FXFA789A, week of
   * 2026-07-19), captured by `scripts/_acr02-sqp-shape.mts`. Not hand-written — this is the
   * only fixture in this file whose shape is evidence rather than assumption.
   */
  it('reads the metric-prefixed ASIN keys Amazon actually returns', () => {
    const rows = parseSqp({
      dataByAsin: [{
        startDate: '2026-07-19', endDate: '2026-07-25', asin: 'B0FXFA789A',
        searchQueryData: { searchQuery: 'giubbotto moto uomo estivo', searchQueryScore: 6, searchQueryVolume: 816 },
        impressionData: { totalQueryImpressionCount: 20110, asinImpressionCount: 230, asinImpressionShare: 1.14 },
        clickData: { totalClickCount: 542, asinClickCount: 5, asinClickShare: 0.92 },
        cartAddData: { totalCartAddCount: 11, asinCartAddCount: 0, asinCartAddShare: 0 },
        purchaseData: { totalPurchaseCount: 1, asinPurchaseCount: 0, asinPurchaseShare: 0 },
      }],
    })
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.searchQuery).toBe('giubbotto moto uomo estivo')
    expect(r.searchQueryVolume).toBe(816)
    expect(r.searchQueryRank).toBe(6)
    // The regression that mattered: our own counts must never silently read 0.
    expect(r.impressionsBrand).toBe(230)
    expect(r.impressionsTotal).toBe(20110)
    expect(r.clicksBrand).toBe(5)
    // Amazon ships asinImpressionShare as a PERCENT (1.14). We store 0..1 computed from
    // counts, so the two agree only after scaling — never store Amazon's value raw.
    expect(share(r.impressionsBrand, r.impressionsTotal) * 100).toBeCloseTo(1.14, 2)
  })

  it('still reads the brand-level spelling', () => {
    const rows = parseSqp({
      dataByAsin: [{
        searchQuery: 'casco',
        impressionData: { totalQueryImpressionCount: 400, brandImpressionCount: 100 },
      }],
    })
    expect(rows[0].impressionsBrand).toBe(100)
  })

  it('maps the nested brandCount/totalCount funnel shape', () => {
    const payload = {
      dataByDepartmentAndSearchQuery: [
        {
          searchQuery: 'giacca moto',
          asin: 'B00ABC123',
          searchQueryVolume: 5000,
          searchQueryScore: 12,
          impressionData: { totalCount: 1000, brandCount: 250 },
          clickData: { totalCount: 200, brandCount: 40 },
          cartAddData: { totalCount: 80, brandCount: 10 },
          purchaseData: { totalCount: 50, brandCount: 5 },
        },
      ],
    }
    const rows = parseSqp(payload)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.searchQuery).toBe('giacca moto')
    expect(r.asin).toBe('B00ABC123')
    expect(r.searchQueryVolume).toBe(5000)
    expect(r.searchQueryRank).toBe(12)
    expect(r.impressionsTotal).toBe(1000)
    expect(r.impressionsBrand).toBe(250)
    expect(share(r.impressionsBrand, r.impressionsTotal)).toBeCloseTo(0.25, 5)
    expect(r.purchasesTotal).toBe(50)
  })

  it('handles the searchQueryData-nested + bare-array variants', () => {
    const rows = parseSqp([{ searchQueryData: { searchQuery: 'casco', searchQueryVolume: 9 }, impressions: { total: 10, brand: 3 } }])
    expect(rows).toHaveLength(1)
    expect(rows[0].searchQuery).toBe('casco')
    expect(rows[0].searchQueryVolume).toBe(9)
    expect(rows[0].impressionsTotal).toBe(10)
    expect(rows[0].impressionsBrand).toBe(3)
  })

  it('skips rows with no query; missing funnel fields default to 0', () => {
    const rows = parseSqp({ records: [{ asin: 'X' }, { searchQuery: 'q1' }] })
    expect(rows).toHaveLength(1)
    expect(rows[0].clicksTotal).toBe(0)
    expect(rows[0].purchasesBrand).toBe(0)
  })

  it('returns [] on unrecognised payloads', () => {
    expect(parseSqp(null)).toEqual([])
    expect(parseSqp({ somethingElse: true })).toEqual([])
    expect(parseSqp(42)).toEqual([])
  })
})
