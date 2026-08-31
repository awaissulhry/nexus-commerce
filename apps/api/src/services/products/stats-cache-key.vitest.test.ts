/**
 * PS.1 — the stats cache key.
 *
 * Two failure modes, both silent:
 *   • two identical scopes hashing differently → the hit rate quietly halves and nobody notices,
 *     because the numbers stay correct;
 *   • two different scopes hashing the same → the KPI cards report ANOTHER view's counts, which
 *     is a correctness bug that looks like a caching bug.
 */
import { describe, it, expect } from 'vitest'
import { __statsCacheKeyForTest as key } from './list-products.service.js'

describe('stats cache key', () => {
  it('is independent of object key insertion order', () => {
    // The same filter built by two code paths must share one entry. JSON.stringify follows
    // insertion order, so this is exactly the case a naive key gets wrong.
    const a = key({ where: { status: 'ACTIVE', parentId: null }, cacheWhere: { a: 1, b: 2 }, useCache: false })
    const b = key({ where: { parentId: null, status: 'ACTIVE' }, cacheWhere: { b: 2, a: 1 }, useCache: false })
    expect(a).toBe(b)
  })

  it('is stable for nested structures too', () => {
    const a = key({ where: { AND: [{ x: 1, y: 2 }] }, cacheWhere: {}, useCache: true })
    const b = key({ where: { AND: [{ y: 2, x: 1 }] }, cacheWhere: {}, useCache: true })
    expect(a).toBe(b)
  })

  it('separates different filters', () => {
    const active = key({ where: { status: 'ACTIVE' }, cacheWhere: {}, useCache: false })
    const draft = key({ where: { status: 'DRAFT' }, cacheWhere: {}, useCache: false })
    expect(active).not.toBe(draft)
  })

  it('separates the cache-backed scope from the live one', () => {
    const live = key({ where: { status: 'ACTIVE' }, cacheWhere: { status: 'ACTIVE' }, useCache: false })
    const viaCache = key({ where: { status: 'ACTIVE' }, cacheWhere: { status: 'ACTIVE' }, useCache: true })
    expect(live).not.toBe(viaCache)
  })

  it('preserves array ORDER, which carries meaning', () => {
    // Sorting keys is right; sorting array elements would not be — [a,b] and [b,a] can be
    // different filters.
    const one = key({ where: { id: { in: ['a', 'b'] } }, cacheWhere: {}, useCache: false })
    const two = key({ where: { id: { in: ['b', 'a'] } }, cacheWhere: {}, useCache: false })
    expect(one).not.toBe(two)
  })

  it('is namespaced so it cannot collide with another cache tenant', () => {
    expect(key({ where: {}, cacheWhere: {}, useCache: false })).toMatch(/^products:stats:[0-9a-f]{24}$/)
  })
})
