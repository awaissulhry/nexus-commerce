import { describe, expect, it } from 'vitest'
import { applyColumnOrder, moveColumnInGroup, canMoveColumn } from './column-prefs'

const cols = (...ids: string[]) => ids.map((id) => ({ id }))
const NONE: ReadonlySet<string> = new Set()

describe('applyColumnOrder', () => {
  it('returns columns as-is without a saved order', () => {
    const c = cols('a', 'b', 'c')
    expect(applyColumnOrder(c)).toEqual(c)
    expect(applyColumnOrder(c, [])).toEqual(c)
  })

  it('orders by the saved id order', () => {
    expect(applyColumnOrder(cols('a', 'b', 'c'), ['c', 'a', 'b']).map((x) => x.id)).toEqual(['c', 'a', 'b'])
  })

  it('keeps unknown (new) columns at the end in original relative order', () => {
    expect(applyColumnOrder(cols('a', 'b', 'c', 'd'), ['b', 'a']).map((x) => x.id)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('drops stale saved ids (deleted columns) harmlessly', () => {
    expect(applyColumnOrder(cols('a', 'b'), ['zombie', 'b', 'a']).map((x) => x.id)).toEqual(['b', 'a'])
  })
})

describe('moveColumnInGroup', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('moves right by one', () => {
    expect(moveColumnInGroup({ groupColumnIds: ids, hidden: NONE, colId: 'a', dir: 1 }))
      .toEqual(['b', 'a', 'c', 'd'])
  })

  it('moves left by one', () => {
    expect(moveColumnInGroup({ groupColumnIds: ids, hidden: NONE, colId: 'c', dir: -1 }))
      .toEqual(['a', 'c', 'b', 'd'])
  })

  it('respects the saved order as the starting point', () => {
    expect(moveColumnInGroup({ groupColumnIds: ids, savedOrder: ['d', 'c', 'b', 'a'], hidden: NONE, colId: 'c', dir: 1 }))
      .toEqual(['d', 'b', 'c', 'a'])
  })

  it('skips hidden neighbours (swap lands past them)', () => {
    expect(moveColumnInGroup({ groupColumnIds: ids, hidden: new Set(['b']), colId: 'a', dir: 1 }))
      .toEqual(['b', 'c', 'a', 'd'])
    expect(moveColumnInGroup({ groupColumnIds: ids, hidden: new Set(['c']), colId: 'd', dir: -1 }))
      .toEqual(['a', 'd', 'b', 'c'])
  })

  it('returns null at the group edge', () => {
    expect(moveColumnInGroup({ groupColumnIds: ids, hidden: NONE, colId: 'a', dir: -1 })).toBeNull()
    expect(moveColumnInGroup({ groupColumnIds: ids, hidden: NONE, colId: 'd', dir: 1 })).toBeNull()
  })

  it('returns null when only hidden columns lie beyond', () => {
    expect(moveColumnInGroup({ groupColumnIds: ids, hidden: new Set(['c', 'd']), colId: 'b', dir: 1 })).toBeNull()
  })

  it('returns null for a column not in the group', () => {
    expect(moveColumnInGroup({ groupColumnIds: ids, hidden: NONE, colId: 'zombie', dir: 1 })).toBeNull()
  })
})

describe('canMoveColumn', () => {
  it('mirrors moveColumnInGroup possibility', () => {
    const ids = ['a', 'b']
    expect(canMoveColumn({ groupColumnIds: ids, hidden: NONE, colId: 'a', dir: 1 })).toBe(true)
    expect(canMoveColumn({ groupColumnIds: ids, hidden: NONE, colId: 'a', dir: -1 })).toBe(false)
    expect(canMoveColumn({ groupColumnIds: ids, hidden: new Set(['b']), colId: 'a', dir: 1 })).toBe(false)
  })
})
