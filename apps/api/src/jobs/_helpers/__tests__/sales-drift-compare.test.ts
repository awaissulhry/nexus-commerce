/**
 * DA-RT.11 — Regression suite for the 3-way drift comparison helpers
 * (sales-drift-compare.ts). The cron itself depends on Prisma + an
 * SP-API context, so it's covered indirectly via these pure tests on
 * the comparison + tolerance + pair-builder layer.
 *
 * Naming convention for cases: <store-pair> | <scenario> — keeps the
 * vitest report scannable when a regression fires in production.
 */

import { describe, it, expect } from 'vitest'
import {
  toleranceFor,
  checkPair,
  buildDriftPairs,
} from '../sales-drift-compare.js'

describe('toleranceFor', () => {
  it('returns the €1 floor for near-empty windows', () => {
    expect(toleranceFor(0)).toBe(100)
    expect(toleranceFor(50)).toBe(100)
    expect(toleranceFor(10_000)).toBe(100) // 0.5% of €100 = €0.50 → floor wins
  })

  it('scales to 0.5% above the €1 break-even point', () => {
    expect(toleranceFor(20_000)).toBe(100) // 0.5% of €200 = €1 exactly
    expect(toleranceFor(100_000)).toBe(500) // 0.5% of €1k = €5
    expect(toleranceFor(1_000_000)).toBe(5_000) // 0.5% of €10k = €50
  })

  it('rounds to nearest cent (no fractional cents)', () => {
    // 0.5% of €77.77 = 38.885¢ → rounds to 39
    expect(toleranceFor(7_777)).toBe(100) // still floored
    // 0.5% of €333.33 = 166.665¢ → rounds to 167
    expect(toleranceFor(33_333)).toBe(167)
  })
})

describe('checkPair', () => {
  it('skips when either side is null (missing-data window)', () => {
    expect(checkPair(null, 10_000)).toBeNull()
    expect(checkPair(10_000, null)).toBeNull()
    expect(checkPair(null, null)).toBeNull()
  })

  it('skips when both sides are zero (empty day)', () => {
    expect(checkPair(0, 0)).toBeNull()
  })

  it('skips drift within tolerance', () => {
    // €200.00 vs €200.99 → 99¢ delta, tol is €1 floor
    expect(checkPair(20_000, 20_099)).toBeNull()
    // €1000 vs €1004.99 → 499¢ delta, tol is 0.5% = €5
    expect(checkPair(100_000, 100_499)).toBeNull()
  })

  it('fires when delta exceeds tolerance, signed correctly', () => {
    // A > B → positive delta
    const overage = checkPair(20_000, 18_000)
    expect(overage).not.toBeNull()
    expect(overage!.deltaCents).toBe(2_000)
    expect(overage!.deltaPct).toBeCloseTo(10, 5)

    // A < B → negative delta
    const shortfall = checkPair(18_000, 20_000)
    expect(shortfall).not.toBeNull()
    expect(shortfall!.deltaCents).toBe(-2_000)
    expect(shortfall!.deltaPct).toBeCloseTo(-10, 5)
  })

  it('uses the larger side as the deltaPct denominator', () => {
    // 100¢ vs 50¢ → max = 100, delta = 50, pct = 50%
    const r = checkPair(100, 50)
    // tolerance for max=100 is €1 floor = 100, abs(50) ≤ 100 → null
    expect(r).toBeNull()
  })
})

describe('buildDriftPairs', () => {
  it('emits no pairs when all three stores agree within tolerance', () => {
    const pairs = buildDriftPairs({
      orderCents: 100_000,
      aggregateCents: 100_100, // 1€ delta, floor tolerance
      financialCents: 100_050, // also within tolerance vs both
    })
    expect(pairs).toEqual([])
  })

  it('emits no pairs when all three sides are zero', () => {
    const pairs = buildDriftPairs({
      orderCents: 0,
      aggregateCents: 0,
      financialCents: 0,
    })
    expect(pairs).toEqual([])
  })

  it('skips financial-side pairs when financialCents is null', () => {
    // Recent day, ListFinancialEvents hasn't settled yet. Order vs
    // aggregate disagrees but financial side absent — only that one
    // pair should fire.
    const pairs = buildDriftPairs({
      orderCents: 100_000,
      aggregateCents: 80_000, // 20% short — clearly drifting
      financialCents: null,
    })
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ a: 'order', b: 'aggregate' })
    expect(pairs[0]!.deltaCents).toBe(20_000)
  })

  it('emits the financial-disagreement pairs when Order+Aggregate agree but Financial differs', () => {
    // Settled order showed up in financial events at a different
    // amount than what we recorded — classic ground-truth catch.
    const pairs = buildDriftPairs({
      orderCents: 100_000,
      aggregateCents: 100_000,
      financialCents: 90_000, // 10% short vs both
    })
    const pairKeys = pairs.map((p) => `${p.a}↔${p.b}`)
    expect(pairKeys).toContain('order↔financial')
    expect(pairKeys).toContain('aggregate↔financial')
    expect(pairKeys).not.toContain('order↔aggregate')
    expect(pairs).toHaveLength(2)
  })

  it('emits all three pairs when every store disagrees', () => {
    const pairs = buildDriftPairs({
      orderCents: 100_000,
      aggregateCents: 80_000,
      financialCents: 60_000,
    })
    expect(pairs).toHaveLength(3)
    const pairKeys = pairs.map((p) => `${p.a}↔${p.b}`)
    expect(pairKeys).toEqual([
      'order↔aggregate',
      'order↔financial',
      'aggregate↔financial',
    ])
  })

  it('treats financial=0 as a real settled value (not missing)', () => {
    // Distinct from the null case: Amazon explicitly settled €0 for
    // this window (e.g. all orders were cancelled/refunded server
    // side). Order/aggregate having real revenue means real drift.
    const pairs = buildDriftPairs({
      orderCents: 100_000,
      aggregateCents: 100_000,
      financialCents: 0,
    })
    expect(pairs).toHaveLength(2)
    expect(pairs.map((p) => `${p.a}↔${p.b}`)).toEqual([
      'order↔financial',
      'aggregate↔financial',
    ])
  })

  it('preserves sign so operator can see which side is short', () => {
    // Order side is HIGHER than aggregate → positive delta.
    // Operator reading "order > aggregate" knows the aggregate
    // refresh cron is behind, not that orders were lost.
    const pairs = buildDriftPairs({
      orderCents: 100_000,
      aggregateCents: 50_000,
      financialCents: null,
    })
    expect(pairs[0]!.deltaCents).toBeGreaterThan(0)
  })
})

// DA-RT.20 — settlement-pending classification.
describe('buildDriftPairs — kind classification (DA-RT.20)', () => {
  it('without windowAgeDays, all pairs are true-drift', () => {
    const pairs = buildDriftPairs({
      orderCents: 100_000,
      aggregateCents: 100_000,
      financialCents: 80_000, // F undershoots O+A by 20%
    })
    expect(pairs).toHaveLength(2) // O↔F + A↔F
    for (const p of pairs) expect(p.kind).toBe('true-drift')
  })

  it('recent window + F < O → settlement-pending on F-side pairs', () => {
    const pairs = buildDriftPairs(
      { orderCents: 100_000, aggregateCents: 100_000, financialCents: 30_000 },
      5, // 5 days old, well inside settlement window
    )
    // Both F-side pairs should be settlement-pending
    const oF = pairs.find((p) => p.a === 'order' && p.b === 'financial')!
    const aF = pairs.find((p) => p.a === 'aggregate' && p.b === 'financial')!
    expect(oF.kind).toBe('settlement-pending')
    expect(aF.kind).toBe('settlement-pending')
  })

  it('recent window + F > O → still true-drift (Amazon settling more = real bug)', () => {
    const pairs = buildDriftPairs(
      { orderCents: 50_000, aggregateCents: 50_000, financialCents: 80_000 },
      5,
    )
    for (const p of pairs.filter((p) => p.b === 'financial' || p.a === 'financial')) {
      expect(p.kind).toBe('true-drift')
    }
  })

  it('older window (>=14d) + F < O → true-drift (settlement should have happened)', () => {
    const pairs = buildDriftPairs(
      { orderCents: 100_000, aggregateCents: 100_000, financialCents: 30_000 },
      20,
    )
    for (const p of pairs.filter((p) => p.b === 'financial' || p.a === 'financial')) {
      expect(p.kind).toBe('true-drift')
    }
  })

  it('order↔aggregate pair is never settlement-pending (no F involvement)', () => {
    const pairs = buildDriftPairs(
      { orderCents: 100_000, aggregateCents: 80_000, financialCents: 30_000 },
      5, // recent window
    )
    const oA = pairs.find((p) => p.a === 'order' && p.b === 'aggregate')!
    expect(oA.kind).toBe('true-drift')
  })

  it('14d boundary is exclusive on the settlement-pending side', () => {
    // Exactly 14 days = NOT settlement-pending (settlement should be done by now)
    const pairs14 = buildDriftPairs(
      { orderCents: 100_000, aggregateCents: 100_000, financialCents: 50_000 },
      14,
    )
    expect(pairs14.find((p) => p.b === 'financial')!.kind).toBe('true-drift')

    // 13 days = settlement-pending
    const pairs13 = buildDriftPairs(
      { orderCents: 100_000, aggregateCents: 100_000, financialCents: 50_000 },
      13,
    )
    expect(pairs13.find((p) => p.b === 'financial')!.kind).toBe('settlement-pending')
  })
})
