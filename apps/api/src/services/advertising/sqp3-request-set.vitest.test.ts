/**
 * SQP.3 — the rule that stops the request pass re-reading a week it already holds.
 *
 * §4.1 measured a settled week returning byte-identical data at 25 and again at 46 days, so
 * re-requesting it buys nothing and costs ~65s of `createReport` throttle per ASIN. These pin the
 * partition, because getting it wrong is silent in both directions: skip too much and the feed stops
 * filling, double-count and the summary reports work that never happened.
 */
import { describe, it, expect } from 'vitest'
import { partitionRequestSet } from './sqp-async.service.js'

const A = ['a1', 'a2', 'a3', 'a4']

describe('partitionRequestSet', () => {
  it('requests everything when nothing is outstanding or settled', () => {
    const p = partitionRequestSet({ asins: A, outstanding: [], settled: [] })
    expect(p.toRequest).toEqual(A)
    expect(p.alreadyOutstanding).toEqual([])
    expect(p.alreadySettled).toEqual([])
  })

  it('skips a settled ASIN — the week has stopped moving', () => {
    const p = partitionRequestSet({ asins: A, outstanding: [], settled: ['a2', 'a4'] })
    expect(p.toRequest).toEqual(['a1', 'a3'])
    expect(p.alreadySettled).toEqual(['a2', 'a4'])
  })

  it('counts an ASIN that is BOTH outstanding and settled exactly once, as outstanding', () => {
    // Reachable in production: a week settles, the calendar keeps pointing at it, and an operator
    // re-requests by hand. Counting it in both buckets would report 5 handled out of 4 asked for.
    const p = partitionRequestSet({ asins: A, outstanding: ['a2'], settled: ['a2', 'a3'] })
    expect(p.alreadyOutstanding).toEqual(['a2'])
    expect(p.alreadySettled).toEqual(['a3'])
    expect(p.toRequest).toEqual(['a1', 'a4'])
  })

  it('always partitions — the three buckets sum to the input, with no ASIN in two of them', () => {
    const p = partitionRequestSet({ asins: A, outstanding: ['a1', 'zz'], settled: ['a1', 'a2'] })
    const all = [...p.toRequest, ...p.alreadyOutstanding, ...p.alreadySettled]
    expect(all.length).toBe(A.length)
    expect(new Set(all).size).toBe(A.length)
    // and an id we were never asked about cannot leak in from the outstanding set
    expect(all).not.toContain('zz')
  })

  it('is empty-safe: a fully settled week requests nothing, which is a success and not a failure', () => {
    const p = partitionRequestSet({ asins: A, outstanding: [], settled: A })
    expect(p.toRequest).toEqual([])
    expect(p.alreadySettled).toHaveLength(4)
    // sqp-ingest.job.ts must NOT throw on this shape — see the `settled === 0` term in its guard.
  })
})
