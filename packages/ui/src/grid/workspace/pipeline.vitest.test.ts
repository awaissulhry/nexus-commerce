import { describe, expect, it } from 'vitest'

import { bandByEnabled, collectGroupMeta, hasActiveFilters, initialPageOf, orderGroups, pageMath, pluralize, searchRows } from './pipeline'

describe('pluralize — the legacy rule', () => {
  it('one is the noun, many take -s, a consonant-y takes -ies', () => {
    expect(pluralize('Campaign', 1)).toBe('Campaign')
    expect(pluralize('Campaign', 2)).toBe('Campaigns')
    expect(pluralize('Query', 8)).toBe('Queries')
    expect(pluralize('Day', 3)).toBe('Days')
    expect(pluralize('A.I. bid decision', 0)).toBe('A.I. bid decisions')
  })
})

describe('search — the H10 inline 🔍', () => {
  const rows = [{ n: 'Gale Jacket' }, { n: 'Back Protector' }, { n: 'gale slider' }]
  it('narrows case-insensitively on the accessor; blank, off, or no accessor returns the rows untouched', () => {
    expect(searchRows(rows, 'gale', true, (r) => r.n)).toEqual([rows[0], rows[2]])
    expect(searchRows(rows, '  ', true, (r) => r.n)).toBe(rows)
    expect(searchRows(rows, 'gale', false, (r) => r.n)).toBe(rows)
    expect(searchRows(rows, 'gale', true, undefined)).toBe(rows)
  })
})

describe('page arithmetic — what the pager and the count line print', () => {
  it('matches the legacy: pageCount ≥ 1, page clamped, 1-based view bounds, zero for no rows', () => {
    expect(pageMath(1, 100, 219)).toEqual({ pageCount: 3, safePage: 1, viewStart: 1, viewEnd: 100 })
    expect(pageMath(3, 100, 219)).toEqual({ pageCount: 3, safePage: 3, viewStart: 201, viewEnd: 219 })
    expect(pageMath(9, 100, 219)).toEqual({ pageCount: 3, safePage: 3, viewStart: 201, viewEnd: 219 })
    expect(pageMath(1, 50, 0)).toEqual({ pageCount: 1, safePage: 1, viewStart: 0, viewEnd: 0 })
  })
  it('initialPage: a finite integer ≥ 1, else 1', () => {
    expect(initialPageOf(undefined)).toBe(1)
    expect(initialPageOf(0)).toBe(1)
    expect(initialPageOf(2.7)).toBe(2)
    expect(initialPageOf(Number.NaN)).toBe(1)
  })
})

describe('SF.1 banding — live first, paused, archived; the incoming order kept inside each band', () => {
  it('is a stable re-order by enabledRank', () => {
    const nodes = [{ d: { s: 'ARCHIVED', n: 1 } }, { d: { s: 'ENABLED', n: 2 } }, { d: { s: 'PAUSED', n: 3 } }, { d: { s: 'ENABLED', n: 4 } }, { d: { s: 'WEIRD', n: 5 } }]
    bandByEnabled(nodes, (n) => n.d, ((row: { s: string }) => row.s) as (row: never) => unknown)
    expect(nodes.map((n) => n.d.n)).toEqual([2, 4, 3, 5, 1])
  })
  it('a boolean liveness works too, and a node with no data ranks with paused', () => {
    const nodes = [{ d: { on: false, n: 1 } }, { d: undefined }, { d: { on: true, n: 3 } }]
    bandByEnabled(nodes, (n) => n.d, ((row: { on: boolean }) => row.on) as (row: never) => unknown)
    expect(nodes.map((n) => n.d?.n ?? 'none')).toEqual([3, 1, 'none'])
  })
})

describe('R1 group order — explicit `order` wins where both carry one, else alphabetical, else AG\'s order', () => {
  it('orders by `order`, then label', () => {
    const meta = new Map([['b', { label: 'Beta', order: 2 }], ['a', { label: 'Alpha', order: 1 }], ['z', { label: 'Zeta' }], ['m', { label: 'Mu' }]])
    const nodes = [{ key: 'z' }, { key: 'b' }, { key: 'm' }, { key: 'a' }]
    orderGroups(nodes, (n) => n.key, meta)
    // `z` vs `b`: only one has an order → alphabetical (Beta < Zeta); `m` vs `z`: Mu < Zeta; `a` first by order/alpha.
    expect(nodes.map((n) => n.key)).toEqual(['a', 'b', 'm', 'z'])
  })
  it('an unknown key keeps its place relative to its neighbours (stable)', () => {
    const meta = new Map([['a', { label: 'A' }]])
    const nodes = [{ key: 'x' }, { key: 'a' }, { key: 'y' }]
    orderGroups(nodes, (n) => n.key, meta)
    expect(nodes.map((n) => n.key)).toEqual(['x', 'a', 'y'])
  })
  it('collectGroupMeta keeps the FIRST label and order a key produces', () => {
    const rows = [{ g: 'p', l: 'Performance', o: 1 }, { g: 'e', l: 'Economics', o: 2 }, { g: 'p', l: 'Performance (dup)', o: 9 }]
    const m = collectGroupMeta(rows, (r) => ({ key: r.g, label: r.l, order: r.o }))
    expect(m.get('p')).toEqual({ label: 'Performance', order: 1 })
    expect(m.get('e')).toEqual({ label: 'Economics', order: 2 })
  })
})

describe('hasActiveFilters — the Save-preset gate', () => {
  it('a range with a bound, a set select, a non-empty multiselect; nothing otherwise', () => {
    expect(hasActiveFilters({})).toBe(false)
    expect(hasActiveFilters({ spend: { min: '', max: '' }, status: '', types: [] })).toBe(false)
    expect(hasActiveFilters({ spend: { min: '1', max: '' } })).toBe(true)
    expect(hasActiveFilters({ status: 'ENABLED' })).toBe(true)
    expect(hasActiveFilters({ types: ['SP'] })).toBe(true)
  })
})
