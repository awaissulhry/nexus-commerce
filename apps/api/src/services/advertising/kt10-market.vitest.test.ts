/**
 * KT.10 — the share Δ's denominator, the cap, and the health line's two branches.
 *
 * Written before the copy and watched fail. The property that matters is the one the page has removed
 * five times already: a movement number with no denominator context reads as the opposite of the truth.
 */
import { describe, it, expect } from 'vitest'
import { SQP_QUERIES_PER_ASIN_CAP } from './keyword-tracker.service.js'

/** The sentence the Δ cell has to support, extracted so it can be asserted without a browser. */
export function deltaContext(args: { deltaPP: number | null; marketDeltaPct: number | null }): string | null {
  if (args.deltaPP == null) return null
  const d = `${args.deltaPP >= 0 ? '+' : ''}${args.deltaPP.toFixed(2)}pp`
  if (args.marketDeltaPct == null) return d
  return `${d} · mkt ${args.marketDeltaPct >= 0 ? '+' : ''}${args.marketDeltaPct.toFixed(0)}%`
}

/** Which of the two stories a market-level movement tells. */
export function marketStory(m: {
  volumeDeltaPct: number | null; ourImpressionsDeltaPct: number | null
  sharePriorPct: number | null; shareNowPct: number | null
} | null): 'no-data' | 'we-gained-in-a-shrinking-market' | 'we-gained' | 'we-lost' | 'flat' {
  if (!m || m.volumeDeltaPct == null || m.shareNowPct == null || m.sharePriorPct == null) return 'no-data'
  const shareUp = m.shareNowPct > m.sharePriorPct
  const marketDown = m.volumeDeltaPct <= -10
  if (shareUp && marketDown) return 'we-gained-in-a-shrinking-market'
  if (shareUp) return 'we-gained'
  if (m.shareNowPct < m.sharePriorPct) return 'we-lost'
  return 'flat'
}

describe('the share Δ carries its denominator', () => {
  it('🔴 says the market moved, so +0.19pp cannot be read as "we improved" alone', () => {
    expect(deltaContext({ deltaPP: 0.19, marketDeltaPct: -46 })).toBe('+0.19pp · mkt -46%')
  })

  it('omits the context rather than inventing 0% when the prior period had no volume', () => {
    expect(deltaContext({ deltaPP: 0.19, marketDeltaPct: null })).toBe('+0.19pp')
  })

  it('renders nothing at all when there is no Δ', () => {
    expect(deltaContext({ deltaPP: null, marketDeltaPct: -46 })).toBeNull()
  })

  it('signs both numbers, so a growing market is distinguishable from a shrinking one', () => {
    expect(deltaContext({ deltaPP: -0.09, marketDeltaPct: 7 })).toBe('-0.09pp · mkt +7%')
  })
})

describe('🔴 the health line must not call a shrinking market a failure', () => {
  it('names the IT case: share up while the market halved', () => {
    // Measured 2026-08-15, like-for-like on 63 (query, ASIN) pairs.
    expect(marketStory({ volumeDeltaPct: -46, ourImpressionsDeltaPct: -10, sharePriorPct: 0.296, shareNowPct: 0.490 }))
      .toBe('we-gained-in-a-shrinking-market')
  })

  it('separates a genuine gain from a gain caused by the market shrinking', () => {
    expect(marketStory({ volumeDeltaPct: 5, ourImpressionsDeltaPct: 40, sharePriorPct: 0.20, shareNowPct: 0.28 }))
      .toBe('we-gained')
  })

  it('still reports a loss as a loss', () => {
    expect(marketStory({ volumeDeltaPct: -46, ourImpressionsDeltaPct: -60, sharePriorPct: 0.40, shareNowPct: 0.30 }))
      .toBe('we-lost')
  })

  it('says no-data rather than guessing when the overlap was too small', () => {
    // The service returns null below five overlapping pairs — ES had 4 and FR had 1 on this window.
    expect(marketStory(null)).toBe('no-data')
  })
})

describe('the cap', () => {
  it('is 100 — measured across 395 cells, none above, 70 at exactly', () => {
    expect(SQP_QUERIES_PER_ASIN_CAP).toBe(100)
  })

  it('🔴 bounds terms covered above what ten ASINs can reach', () => {
    // 10 measured ASINs is 1,000 query slots against a 97-term watchlist, which is why SQP.5 measured
    // ASINs 11-15 buying zero additional terms. The reach line's "of 250" implies otherwise.
    expect(10 * SQP_QUERIES_PER_ASIN_CAP).toBeGreaterThan(97)
  })
})
