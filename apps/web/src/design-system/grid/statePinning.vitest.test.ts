import { describe, expect, it } from 'vitest'
import type { GridState } from 'ag-grid-community'

import { colIdsWhere, declaredPinning, withoutColumnSizing, withPinning } from './statePinning'

describe('declaredPinning — the pins the column definitions declare', () => {
  it('reads pinned (true is left), else initialPinned, groups flattened, field when there is no colId', () => {
    expect(declaredPinning([
      { colId: 'rule', pinned: 'left' },
      { field: 'mode' },
      { headerName: 'Group', children: [{ field: 'a', pinned: true }, { colId: 'b', initialPinned: 'right' }] },
      { colId: 'actions', pinned: 'right' },
      { colId: 'unpinned', pinned: null, initialPinned: 'left' },
    ])).toEqual({ leftColIds: ['rule', 'a'], rightColIds: ['b', 'actions'] })
  })
  it('nothing declared, nothing given', () => {
    expect(declaredPinning(undefined)).toEqual({ leftColIds: [], rightColIds: [] })
    expect(declaredPinning([{ colId: 'x' }, null, 'junk'])).toEqual({ leftColIds: [], rightColIds: [] })
  })
})

describe('withPinning — a restored state keeps the pins (design audit M14)', () => {
  const sizing: GridState = { columnSizing: { columnSizingModel: [{ colId: 'rule', width: 356 }] }, sort: { sortModel: [] } }
  const pins = { leftColIds: ['rule'], rightColIds: ['actions'] }
  it('a state without pins gets them', () => {
    expect(withPinning(sizing, pins)).toEqual({ ...sizing, columnPinning: pins })
  })
  it('a state that names its pins is left as it is — even none', () => {
    const named: GridState = { ...sizing, columnPinning: { leftColIds: [], rightColIds: [] } }
    expect(withPinning(named, pins)).toBe(named)
  })
  it('no state, or no pins to add: the same value back', () => {
    expect(withPinning(undefined, pins)).toBeUndefined()
    expect(withPinning(sizing, { leftColIds: [], rightColIds: [] })).toBe(sizing)
    expect(withPinning(sizing, undefined)).toBe(sizing)
  })
  it('never shares the arrays it was given', () => {
    const out = withPinning(sizing, pins)
    expect(out.columnPinning?.leftColIds).not.toBe(pins.leftColIds)
  })
})

describe('withoutColumnSizing — a fitted column never takes a stored width (2026-10-23)', () => {
  const state: GridState = { columnSizing: { columnSizingModel: [{ colId: 'what', width: 180 }, { colId: 'actions', width: 104 }] }, sort: { sortModel: [] } }
  it('drops the stored width of the named columns and keeps the rest', () => {
    expect(withoutColumnSizing(state, ['actions'])).toEqual({ ...state, columnSizing: { columnSizingModel: [{ colId: 'what', width: 180 }] } })
  })
  it('the same object when it stores none of them, or when there is nothing to drop', () => {
    expect(withoutColumnSizing(state, ['other'])).toBe(state)
    expect(withoutColumnSizing(state, [])).toBe(state)
    expect(withoutColumnSizing(undefined, ['actions'])).toBeUndefined()
    const bare: GridState = { sort: { sortModel: [] } }
    expect(withoutColumnSizing(bare, ['actions'])).toBe(bare)
  })
})

describe('colIdsWhere — the ids of the definitions a test picks', () => {
  it('flattens groups and reads colId, else field', () => {
    const mark = () => null
    expect(colIdsWhere([
      { colId: 'actions', cellRenderer: mark },
      { field: 'name' },
      { headerName: 'Group', children: [{ field: 'more', cellRenderer: mark }] },
    ], col => col.cellRenderer === mark)).toEqual(['actions', 'more'])
    expect(colIdsWhere(undefined, () => true)).toEqual([])
  })
})
