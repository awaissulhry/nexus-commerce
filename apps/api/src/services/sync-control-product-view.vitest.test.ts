/**
 * SCV.1 — product rollup reducer (pure).
 */
import { describe, it, expect } from 'vitest'
import { summarizeProductSync, marketMatches, resolveCanonicalMap, type SyncRowLike } from './sync-control-product-view.js'

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

describe('SCV.1b — omitChildrenInList (big-family cap)', () => {
  it('omits above the threshold, keeps at/below', async () => {
    const { omitChildrenInList } = await import('./sync-control-product-view.js')
    expect(omitChildrenInList(5, 20)).toBe(false)
    expect(omitChildrenInList(20, 20)).toBe(false)
    expect(omitChildrenInList(21, 20)).toBe(true)
    expect(omitChildrenInList(40, 20)).toBe(true)
  })
})

describe('SCD.1 — resolveCanonicalMap (pool-derived grouping)', () => {
  it('child-owning master → self; childless duplicate → its pooled canonical', () => {
    const masters = ['GALE', 'GALE-ALT1', 'GALE-ALT2', 'AIRMESH', 'AIRMESH-MEN']
    const withChildren = new Set(['GALE', 'AIRMESH', 'AIRMESH-MEN']) // AIRMESH-MEN owns its OWN distinct kids
    const itemIdsByMaster = new Map([
      ['GALE-ALT1', ['item-a']],
      ['GALE-ALT2', ['item-b']],
    ])
    // both ALT listings pool GALE's variants
    const canonicalByItem = new Map([['item-a', 'GALE'], ['item-b', 'GALE']])
    const map = resolveCanonicalMap(masters, withChildren, itemIdsByMaster, canonicalByItem)
    expect(map.get('GALE')).toBe('GALE')
    expect(map.get('GALE-ALT1')).toBe('GALE')
    expect(map.get('GALE-ALT2')).toBe('GALE')
    // genuinely-different product that shares no pool stays separate
    expect(map.get('AIRMESH-MEN')).toBe('AIRMESH-MEN')
    expect(map.get('AIRMESH')).toBe('AIRMESH')
  })
  it('childless master with no pool link → self (harmless orphan)', () => {
    const map = resolveCanonicalMap(['ORPHAN'], new Set(), new Map(), new Map())
    expect(map.get('ORPHAN')).toBe('ORPHAN')
  })
  it('never folds into a canonical that equals itself', () => {
    // an itemId that maps back to the same master is ignored
    const map = resolveCanonicalMap(['X'], new Set(), new Map([['X', ['i']]]), new Map([['i', 'X']]))
    expect(map.get('X')).toBe('X')
  })
})

describe('SCD.1b — canonicalStem + stem fallback', () => {
  it('canonicalStem strips -ALT#/-FBM/-FBA and leading market prefix', async () => {
    const { canonicalStem } = await import('./sync-control-product-view.js')
    expect(canonicalStem('VENTRA-JACKET-ALT1')).toBe('VENTRA-JACKET')
    expect(canonicalStem('IT-GALE-JACKET')).toBe('GALE-JACKET')
    expect(canonicalStem('GALE-JACKET-FBM')).toBe('GALE-JACKET')
    expect(canonicalStem('AIR-MESH-JACKET-MEN')).toBe('AIR-MESH-JACKET-MEN') // -MEN not stripped → stays distinct
  })
  it('childless UNPOOLED duplicate folds by stem into a same-stem canonical', () => {
    const canonByStem = new Map([['VENTRA-JACKET', 'VENTRA']]) // VENTRA owns children
    const stemOf = new Map([['VENTRA', 'VENTRA-JACKET'], ['VENTRA-ALT1', 'VENTRA-JACKET']])
    const map = resolveCanonicalMap(['VENTRA', 'VENTRA-ALT1'], new Set(['VENTRA']), new Map(), new Map(), canonByStem, stemOf)
    expect(map.get('VENTRA')).toBe('VENTRA')
    expect(map.get('VENTRA-ALT1')).toBe('VENTRA') // unpooled, folds by stem
  })
  it('a child-OWNING master never stem-merges (distinct product stays separate)', () => {
    // AIRMESH-MEN owns its own children → stem fallback never applies to it
    const canonByStem = new Map([['AIRMESH-JACKET', 'AIRMESH']])
    const stemOf = new Map([['AIRMESH', 'AIRMESH-JACKET'], ['AIRMESH-MEN', 'AIRMESH-JACKET']])
    const map = resolveCanonicalMap(['AIRMESH', 'AIRMESH-MEN'], new Set(['AIRMESH', 'AIRMESH-MEN']), new Map(), new Map(), canonByStem, stemOf)
    expect(map.get('AIRMESH-MEN')).toBe('AIRMESH-MEN') // owns children → stays separate
  })
  it('pool wins over stem when both available', () => {
    const canonByStem = new Map([['X', 'STEM-CANON']])
    const stemOf = new Map([['DUP', 'X']])
    const map = resolveCanonicalMap(['DUP'], new Set(), new Map([['DUP', ['i']]]), new Map([['i', 'POOL-CANON']]), canonByStem, stemOf)
    expect(map.get('DUP')).toBe('POOL-CANON')
  })
})
