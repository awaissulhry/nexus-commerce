import { describe, expect, it } from 'vitest'
import type { GridState } from 'ag-grid-community'

import { declaredPinning, withPinning } from './statePinning'

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
