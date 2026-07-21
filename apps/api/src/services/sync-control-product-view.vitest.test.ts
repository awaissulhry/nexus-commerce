/**
 * SCV.1 — product rollup reducer (pure).
 */
import { describe, it, expect } from 'vitest'
import { summarizeProductSync, marketMatches, type SyncRowLike } from './sync-control-product-view.js'

const row = (over: Partial<SyncRowLike>): SyncRowLike => ({
  channel: 'EBAY',
  mode: 'FOLLOW',
  intendedQty: 5,
  liveQty: 5,
  buffer: 0,
  routedLocations: [],
  ...over,
})

describe('SCV.1 — summarizeProductSync', () => {
  it('empty product → zeros, no dominant mode', () => {
    expect(summarizeProductSync([])).toMatchObject({
      listings: 0, channels: [], modeCounts: {}, dominantMode: null,
      uniform: false, hasFba: false, maxBuffer: 0, routedLocations: [], driftCount: 0,
    })
  })

  it('uniform product → one mode, uniform true', () => {
    const r = summarizeProductSync([row({}), row({ channel: 'EBAY' }), row({})])
    expect(r.uniform).toBe(true)
    expect(r.dominantMode).toBe('FOLLOW')
    expect(r.modeCounts).toEqual({ FOLLOW: 3 })
  })

  it('mixed modes → dominant is the most common NON-FBA mode', () => {
    const r = summarizeProductSync([
      row({ mode: 'FOLLOW' }), row({ mode: 'FOLLOW' }), row({ mode: 'FOLLOW' }),
      row({ mode: 'PINNED' }),
      row({ mode: 'FBA', intendedQty: null, liveQty: null }),
    ])
    expect(r.uniform).toBe(false)
    expect(r.hasFba).toBe(true)
    expect(r.dominantMode).toBe('FOLLOW')
    expect(r.modeCounts).toEqual({ FOLLOW: 3, PINNED: 1, FBA: 1 })
  })

  it('all-FBA product still yields a dominant mode (FBA)', () => {
    const r = summarizeProductSync([
      row({ mode: 'FBA', intendedQty: null, liveQty: null }),
      row({ mode: 'FBA', intendedQty: null, liveQty: null }),
    ])
    expect(r.dominantMode).toBe('FBA')
    expect(r.hasFba).toBe(true)
  })

  it('drift counts only rows where BOTH intended and live are known and differ', () => {
    const r = summarizeProductSync([
      row({ intendedQty: 5, liveQty: 5 }),          // match — no drift
      row({ intendedQty: 0, liveQty: 5 }),          // drift
      row({ intendedQty: 8, liveQty: 3 }),          // drift
      row({ mode: 'FBA', intendedQty: null, liveQty: null }),   // no intended — never drift
      row({ mode: 'UNCOUNTED', intendedQty: null, liveQty: 0 }), // no intended — never drift
    ])
    expect(r.driftCount).toBe(2)
  })

  it('aggregates channels, max buffer, and the routed-location union', () => {
    const r = summarizeProductSync([
      row({ channel: 'EBAY', buffer: 2, routedLocations: ['IT-MAIN'] }),
      row({ channel: 'AMAZON', buffer: 5, routedLocations: ['IT-MAIN', 'OUTLET'] }),
    ])
    expect(r.channels).toEqual(['AMAZON', 'EBAY'])
    expect(r.maxBuffer).toBe(5)
    expect(r.routedLocations).toEqual(['IT-MAIN', 'OUTLET'])
  })
})

describe('SCV.1 — marketMatches (EBAY_ normalization)', () => {
  it('matches raw and eBay-prefixed markets case-insensitively', () => {
    expect(marketMatches('IT', 'it')).toBe(true)
    expect(marketMatches('EBAY_IT', 'IT')).toBe(true)
    expect(marketMatches('EBAY_DE', 'IT')).toBe(false)
    expect(marketMatches('DE', 'IT')).toBe(false)
  })
})
