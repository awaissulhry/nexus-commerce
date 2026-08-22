/**
 * SOV-P1 — the two rules the SOV share depends on, pinned.
 *
 * Both exist because they were got wrong at least once:
 *   1. **Σ brand ÷ MAX total.** A study probe SUMMED `impressionsTotal` across a query's ASIN rows,
 *      inflating every denominator by the ASIN count and overstating the reported head-query gaps
 *      by up to an order of magnitude. The market total is one number repeated per row.
 *   2. **No market total is not a zero share.** `share()` in `sqp.service.ts` coalesces those two,
 *      and breaking that tie is the reason this whole section exists.
 */
import { describe, it, expect } from 'vitest'
import { aggregateQueryShares, sovShareKey } from './ads-sov-keyword-share.service.js'

describe('aggregateQueryShares — Σ brand ÷ MAX total', () => {
  it('sums OUR impressions across ASIN rows and takes the market total ONCE', () => {
    // Three ASINs of ours on one query. Amazon repeats the market total on every row.
    const out = aggregateQueryShares([
      { searchQuery: 'giacca moto', impressionsBrand: 100, impressionsTotal: 1000 },
      { searchQuery: 'giacca moto', impressionsBrand: 50, impressionsTotal: 1000 },
      { searchQuery: 'giacca moto', impressionsBrand: 25, impressionsTotal: 1000 },
    ])
    const r = out.get('giacca moto')!
    expect(r.brand).toBe(175)
    expect(r.total).toBe(1000) // NOT 3000
    expect(r.sharePct).toBeCloseTo(0.175, 10)
    expect(r.asinRows).toBe(3)
  })

  it('summing the total instead would divide the share by the ASIN count — the bug this pins', () => {
    const out = aggregateQueryShares([
      { searchQuery: 'q', impressionsBrand: 100, impressionsTotal: 1000 },
      { searchQuery: 'q', impressionsBrand: 100, impressionsTotal: 1000 },
    ])
    expect(out.get('q')!.sharePct).toBeCloseTo(0.2, 10)
    expect(out.get('q')!.sharePct).not.toBeCloseTo(0.1, 10)
  })

  it('a single-ASIN query is unaffected either way', () => {
    const out = aggregateQueryShares([{ searchQuery: 'solo', impressionsBrand: 4, impressionsTotal: 38 }])
    expect(out.get('solo')!.sharePct).toBeCloseTo(4 / 38, 10)
  })

  it('tolerates rows that disagree about the total by taking the largest', () => {
    // Prod shows 0 of 135 multi-ASIN query-weeks disagreeing, but a truncated row must not shrink
    // the market — that would silently INFLATE our share.
    const out = aggregateQueryShares([
      { searchQuery: 'q', impressionsBrand: 10, impressionsTotal: 500 },
      { searchQuery: 'q', impressionsBrand: 10, impressionsTotal: 1000 },
    ])
    expect(out.get('q')!.total).toBe(1000)
    expect(out.get('q')!.sharePct).toBeCloseTo(0.02, 10)
  })
})

describe('aggregateQueryShares — a blank is never a zero', () => {
  it('omits a query with no market total rather than reporting 0 %', () => {
    const out = aggregateQueryShares([
      { searchQuery: 'no-market', impressionsBrand: 0, impressionsTotal: 0 },
      { searchQuery: 'real', impressionsBrand: 1, impressionsTotal: 100 },
    ])
    expect(out.has('no-market')).toBe(false)
    expect(out.has('real')).toBe(true)
  })

  it('keeps a genuine zero share when the market total is real', () => {
    // We were measured on this query and took none of it. That IS a 0, and it must survive.
    const out = aggregateQueryShares([{ searchQuery: 'lost', impressionsBrand: 0, impressionsTotal: 5000 }])
    expect(out.get('lost')!.sharePct).toBe(0)
  })

  it('treats null counts as absent, not as zero market', () => {
    const out = aggregateQueryShares([{ searchQuery: 'n', impressionsBrand: null, impressionsTotal: null }])
    expect(out.has('n')).toBe(false)
  })

  it('never returns a share above 1', () => {
    const out = aggregateQueryShares([
      { searchQuery: 'a', impressionsBrand: 10, impressionsTotal: 100 },
      { searchQuery: 'b', impressionsBrand: 999, impressionsTotal: 1000 },
    ])
    for (const r of out.values()) expect(r.sharePct).toBeLessThanOrEqual(1)
  })
})

describe('aggregateQueryShares — key normalisation', () => {
  it('folds case and surrounding whitespace, because AdTarget text is matched on it', () => {
    const out = aggregateQueryShares([
      { searchQuery: '  Giacca Moto ', impressionsBrand: 10, impressionsTotal: 100 },
      { searchQuery: 'giacca moto', impressionsBrand: 10, impressionsTotal: 100 },
    ])
    expect(out.size).toBe(1)
    expect(out.get('giacca moto')!.brand).toBe(20)
  })

  it('drops blank queries entirely', () => {
    expect(aggregateQueryShares([{ searchQuery: '   ', impressionsBrand: 5, impressionsTotal: 50 }]).size).toBe(0)
    expect(aggregateQueryShares([{ searchQuery: null, impressionsBrand: 5, impressionsTotal: 50 }]).size).toBe(0)
  })
})

describe('sovShareKey — one join key, market-scoped', () => {
  it('scopes by marketplace so a DE query cannot answer for an IT target', () => {
    expect(sovShareKey('IT', 'giacca moto')).not.toBe(sovShareKey('DE', 'giacca moto'))
  })

  it('normalises the same way the aggregate does', () => {
    expect(sovShareKey('IT', '  Giacca Moto ')).toBe(sovShareKey('IT', 'giacca moto'))
  })

  it('a missing marketplace cannot collide with a real one', () => {
    expect(sovShareKey(null, 'q')).toBe('|q')
    expect(sovShareKey('IT', 'q')).toBe('IT|q')
  })
})
