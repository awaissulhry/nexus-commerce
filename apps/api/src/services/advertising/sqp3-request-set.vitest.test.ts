/**
 * SQP.3 — the rule that stops the request pass re-reading a week it already holds.
 *
 * §4.1 measured a settled week returning byte-identical data at 25 and again at 46 days, so
 * re-requesting it buys nothing and costs ~65s of `createReport` throttle per ASIN. These pin the
 * partition, because getting it wrong is silent in both directions: skip too much and the feed stops
 * filling, double-count and the summary reports work that never happened.
 */
import { describe, it, expect } from 'vitest'
import { partitionRequestSet, settledAsins, SQP_SETTLE_MIN_SPAN_HOURS } from './sqp-async.service.js'

const A = ['a1', 'a2', 'a3', 'a4']

const T0 = Date.UTC(2026, 7, 1, 2, 0, 0)
const h = (n: number) => new Date(T0 + n * 3600_000)
/** a settled ASIN: first ingest changed rows, a later one a full day on changed nothing. */
const ing = (asin: string) => [
  { asin, collectedAt: h(0), rowsChanged: 40 },
  { asin, collectedAt: h(24), rowsChanged: 0 },
]


describe('partitionRequestSet', () => {
  it('requests everything when nothing is outstanding or settled', () => {
    const p = partitionRequestSet({ asins: A, outstanding: [], ingests: [] })
    expect(p.toRequest).toEqual(A)
    expect(p.alreadyOutstanding).toEqual([])
    expect(p.alreadySettled).toEqual([])
  })

  it('skips a settled ASIN — the week has stopped moving', () => {
    const p = partitionRequestSet({ asins: A, outstanding: [], ingests: [ing('a2'), ing('a4')].flat() })
    expect(p.toRequest).toEqual(['a1', 'a3'])
    expect(p.alreadySettled).toEqual(['a2', 'a4'])
  })

  it('counts an ASIN that is BOTH outstanding and settled exactly once, as outstanding', () => {
    // Reachable in production: a week settles, the calendar keeps pointing at it, and an operator
    // re-requests by hand. Counting it in both buckets would report 5 handled out of 4 asked for.
    const p = partitionRequestSet({ asins: A, outstanding: ['a2'], ingests: [ing('a2'), ing('a3')].flat() })
    expect(p.alreadyOutstanding).toEqual(['a2'])
    expect(p.alreadySettled).toEqual(['a3'])
    expect(p.toRequest).toEqual(['a1', 'a4'])
  })

  it('always partitions — the three buckets sum to the input, with no ASIN in two of them', () => {
    const p = partitionRequestSet({ asins: A, outstanding: ['a1', 'zz'], ingests: [ing('a1'), ing('a2')].flat() })
    const all = [...p.toRequest, ...p.alreadyOutstanding, ...p.alreadySettled]
    expect(all.length).toBe(A.length)
    expect(new Set(all).size).toBe(A.length)
    // and an id we were never asked about cannot leak in from the outstanding set
    expect(all).not.toContain('zz')
  })

  it('is empty-safe: a fully settled week requests nothing, which is a success and not a failure', () => {
    const p = partitionRequestSet({ asins: A, outstanding: [], ingests: A.flatMap(ing) })
    expect(p.toRequest).toEqual([])
    expect(p.alreadySettled).toHaveLength(4)
    // sqp-ingest.job.ts must NOT throw on this shape — see the `settled === 0` term in its guard.
  })
})


/**
 * 🔴 The span guard. The first production cycle satisfied "fetched twice, nothing changed" in THREE
 * MINUTES and froze a five-day-old week on it. §4.1 measured weeks frozen at 25 and 46 days and never
 * measured day five, so a burst of two fetches is not evidence that a week has stopped filling.
 */
describe('settledAsins — the confirmation has to span a day', () => {
  it('does NOT settle on two fetches minutes apart, however much they agree', () => {
    const s = settledAsins([
      { asin: 'a1', collectedAt: h(0), rowsChanged: 49 },
      { asin: 'a1', collectedAt: new Date(T0 + 3 * 60_000), rowsChanged: 0 },
    ])
    expect(s.has('a1')).toBe(false)
  })

  it('settles once the agreeing fetch is a night later', () => {
    const s = settledAsins([
      { asin: 'a1', collectedAt: h(0), rowsChanged: 49 },
      { asin: 'a1', collectedAt: h(24), rowsChanged: 0 },
    ])
    expect(s.has('a1')).toBe(true)
  })

  it('holds the boundary exactly where the constant says', () => {
    const just = settledAsins([{ asin: 'a1', collectedAt: h(0), rowsChanged: 9 }, { asin: 'a1', collectedAt: h(SQP_SETTLE_MIN_SPAN_HOURS), rowsChanged: 0 }])
    const shy = settledAsins([{ asin: 'a1', collectedAt: h(0), rowsChanged: 9 }, { asin: 'a1', collectedAt: h(SQP_SETTLE_MIN_SPAN_HOURS - 0.5), rowsChanged: 0 }])
    expect(just.has('a1')).toBe(true)
    expect(shy.has('a1')).toBe(false)
  })

  it('never reads a NULL rowsChanged as "nothing changed"', () => {
    // The 41 requests that existed before the column did carry NULL. Treating unknown as settled
    // would have frozen every week they touch on no evidence at all.
    const s = settledAsins([
      { asin: 'a1', collectedAt: h(0), rowsChanged: null },
      { asin: 'a1', collectedAt: h(48), rowsChanged: null },
    ])
    expect(s.has('a1')).toBe(false)
  })

  it('ignores an ingest with no collectedAt rather than treating it as time zero', () => {
    const s = settledAsins([
      { asin: 'a1', collectedAt: null, rowsChanged: 12 },
      { asin: 'a1', collectedAt: h(0), rowsChanged: 0 },
    ])
    expect(s.has('a1')).toBe(false) // one usable sample cannot confirm anything
  })

  it('settles on a later agreeing pair even if an early re-fetch was quick', () => {
    const s = settledAsins([
      { asin: 'a1', collectedAt: h(0), rowsChanged: 49 },
      { asin: 'a1', collectedAt: h(0.1), rowsChanged: 0 },   // too soon on its own
      { asin: 'a1', collectedAt: h(26), rowsChanged: 0 },    // this one is real evidence
    ])
    expect(s.has('a1')).toBe(true)
  })
})
