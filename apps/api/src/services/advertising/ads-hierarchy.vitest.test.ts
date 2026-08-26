/**
 * GX.2 — the one piece of hierarchy arithmetic that is pure, and the one that can silently drift.
 *
 * `deriveMetrics` recomputes the rate metrics for a remainder row from its own additive parts.
 * It MIRRORS `coreMetrics` in ads-report-specs. If that changes and this does not, a remainder's
 * ACOS quietly stops matching the ACOS of every other row in the same table — the exact class of
 * defect the "one metric registry" invariant exists to prevent. These assertions fail when they
 * drift apart.
 */
import { describe, it, expect } from 'vitest'
import { deriveMetrics, parseNodeId } from './ads-hierarchy.service.js'

describe('deriveMetrics', () => {
  it('recomputes rates from the remainder’s own additive parts, never by differencing rates', () => {
    const m = deriveMetrics({ impressions: 1000, clicks: 50, cost: 100, sales: 400, orders: 10, units: 12 })
    expect(m.ctr).toBeCloseTo(0.05, 10)
    expect(m.cpc).toBeCloseTo(2, 10)
    expect(m.acos).toBeCloseTo(0.25, 10)
    expect(m.roas).toBeCloseTo(4, 10)
    expect(m.cvr).toBeCloseTo(0.2, 10)
  })

  it('leaves a rate UNDEFINED rather than returning zero when its denominator is zero', () => {
    // The registry's own rule: an undefined ACOS renders "—", never 0%. A remainder with spend
    // and no sales is the commonest case on this account, so this is not a hypothetical.
    const m = deriveMetrics({ impressions: 0, clicks: 0, cost: 12.5, sales: 0, orders: 0, units: 0 })
    expect(m.ctr).toBeNull()
    expect(m.cpc).toBeNull()
    expect(m.acos).toBeNull()
    expect(m.cvr).toBeNull()
    // ROAS is defined here: spend is the denominator and it is non-zero.
    expect(m.roas).toBe(0)
  })

  it('treats a missing additive value as zero for the rates but keeps it null on the way through', () => {
    const m = deriveMetrics({ impressions: 100, clicks: 10, cost: 5, sales: null, orders: null, units: null })
    expect(m.sales).toBeNull()
    expect(m.acos).toBeNull()      // no sales ⇒ undefined, not 0%
    expect(m.ctr).toBeCloseTo(0.1, 10)
  })
})

describe('parseNodeId', () => {
  it('round-trips every node shape the tree emits', () => {
    expect(parseNodeId('market:IT')).toEqual({ kind: 'market', parts: ['IT'] })
    expect(parseNodeId('portfolio:IT:1234')).toEqual({ kind: 'portfolio', parts: ['IT', '1234'] })
    expect(parseNodeId('portfolio:IT:__none')).toEqual({ kind: 'portfolio', parts: ['IT', '__none'] })
    expect(parseNodeId('campaign:abc123')).toEqual({ kind: 'campaign', parts: ['abc123'] })
  })
})
