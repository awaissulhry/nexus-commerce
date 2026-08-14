/**
 * SQP.4 — the ordering that turns 0.6 rows/report into 33.
 *
 * The property that matters most is the one `_acr2-sqp-backfill.mts` got wrong: a ranking seeded from
 * past success can only ever re-select past success. These pin the explore quota and the barren tier.
 */
import { describe, it, expect } from 'vitest'
import { rankByYield, planRequestSet, tierOf, yieldRate, type AsinYieldEvidence } from './sqp-yield.js'

const ev = (rows: number, weeksMeasured: number, reportsRequested: number): AsinYieldEvidence =>
  ({ rows, weeksMeasured, reportsRequested })

describe('tiers — "never asked" and "asked and empty" are different facts', () => {
  it('separates unproven from barren, which SearchQueryPerformance alone cannot', () => {
    expect(tierOf(undefined)).toBe('unproven')            // no ledger row at all
    expect(tierOf(ev(0, 0, 0))).toBe('unproven')          // never requested
    expect(tierOf(ev(0, 0, 5))).toBe('barren')            // requested 5×, never a row
    expect(tierOf(ev(120, 3, 3))).toBe('proven')
  })

  it('rates by measured week, so being sampled more often is not itself a qualification', () => {
    expect(yieldRate(ev(500, 5, 5))).toBe(100)
    expect(yieldRate(ev(100, 1, 1))).toBe(100)            // same rate, less evidence
    expect(yieldRate(ev(0, 0, 4))).toBe(0)                // no divide-by-zero
    expect(yieldRate(undefined)).toBe(0)
  })
})

describe('rankByYield', () => {
  const pool = ['a', 'b', 'c', 'd', 'e']
  const evidence = new Map<string, AsinYieldEvidence>([
    ['a', ev(0, 0, 6)],        // barren
    ['b', ev(300, 5, 5)],      // proven, 60/wk
    ['c', ev(0, 0, 0)],        // unproven
    ['d', ev(500, 5, 5)],      // proven, 100/wk
    ['e', ev(100, 1, 1)],      // proven, 100/wk but one week only
  ])

  it('puts proven first, barren last, and unproven in between', () => {
    const r = rankByYield(pool, evidence)
    expect(r.map((x) => x.asin)).toEqual(['d', 'e', 'b', 'c', 'a'])
    expect(r.map((x) => x.tier)).toEqual(['proven', 'proven', 'proven', 'unproven', 'barren'])
  })

  it('🔴 ranks BARREN below UNPROVEN — the one tier we have evidence against', () => {
    const r = rankByYield(pool, evidence)
    expect(r.findIndex((x) => x.asin === 'c')).toBeLessThan(r.findIndex((x) => x.asin === 'a'))
  })

  it('breaks an equal rate on weight of evidence, not on luck', () => {
    const r = rankByYield(pool, evidence)
    expect(r.findIndex((x) => x.asin === 'd')).toBeLessThan(r.findIndex((x) => x.asin === 'e'))
  })

  it('is deterministic — the same pool in a different order gives the same ranking of proven ASINs', () => {
    const a = rankByYield(pool, evidence).filter((x) => x.tier === 'proven').map((x) => x.asin)
    const b = rankByYield([...pool].reverse(), evidence).filter((x) => x.tier === 'proven').map((x) => x.asin)
    expect(a).toEqual(b)
  })
})

describe('🔴 planRequestSet — exploit without ever closing the door on explore', () => {
  const pool = Array.from({ length: 40 }, (_, i) => `A${String(i).padStart(2, '0')}`)
  // the first five are proven; everything else has never been asked
  const evidence = new Map<string, AsinYieldEvidence>(
    pool.slice(0, 5).map((a, i) => [a, ev(500 - i * 10, 5, 5)] as const),
  )

  it('reserves slots for never-asked ASINs even when proven ones could fill the budget', () => {
    const p = planRequestSet({ pool, evidence, budget: 10, exploreSlots: 2 })
    expect(p.chosen).toHaveLength(10)
    expect(p.exploit).toEqual(['A00', 'A01', 'A02', 'A03', 'A04'])
    expect(p.explore).toHaveLength(2)
    expect(p.explore.every((a) => !p.exploit.includes(a))).toBe(true)
  })

  it('is NOT _acr2 — an ASIN with no history can still be chosen', () => {
    // _acr2-sqp-backfill.mts seeds from SearchQueryPerformance, so a zero-row ASIN can never enter the
    // top N. Here, with 20 proven ASINs available and a budget of 10, exploration still happens.
    const manyProven = new Map<string, AsinYieldEvidence>(pool.slice(0, 20).map((a, i) => [a, ev(500 - i, 5, 5)] as const))
    const p = planRequestSet({ pool, evidence: manyProven, budget: 10, exploreSlots: 2 })
    expect(p.explore).toHaveLength(2)
    expect(p.exploit).toHaveLength(8)
  })

  it('defaults the explore quota to a fifth of the budget rather than zero', () => {
    const p = planRequestSet({ pool, evidence, budget: 10 })
    expect(p.explore.length).toBe(2)
  })

  it('honours the SQP.3 exclusions — settled weeks and in-flight reports', () => {
    const p = planRequestSet({ pool, evidence, budget: 5, exploreSlots: 1, exclude: new Set(['A00', 'A01']) })
    expect(p.chosen).not.toContain('A00')
    expect(p.chosen).not.toContain('A01')
    expect(p.exploit[0]).toBe('A02')
  })

  it('never leaves a slot unused — a report not sent is capacity thrown away', () => {
    // only 2 proven and 2 unproven survive; the rest are barren, so filler must top the set back up
    const tiny = ['p0', 'p1', 'u0', 'u1', 'b0', 'b1', 'b2']
    const e = new Map<string, AsinYieldEvidence>([
      ['p0', ev(200, 2, 2)], ['p1', ev(100, 2, 2)],
      ['b0', ev(0, 0, 3)], ['b1', ev(0, 0, 3)], ['b2', ev(0, 0, 3)],
    ])
    const p = planRequestSet({ pool: tiny, evidence: e, budget: 6, exploreSlots: 2 })
    expect(p.chosen).toHaveLength(6)
    expect(p.chosen.slice(0, 2)).toEqual(['p0', 'p1'])
  })

  it('returns an empty set for a zero budget rather than throwing', () => {
    expect(planRequestSet({ pool, evidence, budget: 0 }).chosen).toEqual([])
  })
})
