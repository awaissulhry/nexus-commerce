import { describe, expect, it } from 'vitest'
import { MARKETS_FIXED_WIDTH, marketsColumnState, marketsFill, sizingForWidth } from './marketsWidth'

describe('the Markets column’s width', () => {
  it('fills only a grid with width to spare', () => {
    expect(marketsFill(1310)).toBe(true)
    expect(marketsFill(290)).toBe(false)
  })
  it('switches between filling and a fixed width', () => {
    expect(marketsColumnState(true)).toEqual([{ colId: 'markets', flex: 1 }])
    expect(marketsColumnState(false)).toEqual([{ colId: 'markets', flex: null, width: MARKETS_FIXED_WIDTH }])
  })
  it('reads a saved layout without Markets’ flex on a narrow grid, and as saved on a wide one', () => {
    const saved = { columnSizing: { columnSizingModel: [{ colId: 'ag-Grid-AutoColumn', width: 360 }, { colId: 'markets', flex: 1, width: 900 }] } }
    expect(sizingForWidth(saved, false)?.columnSizing?.columnSizingModel).toEqual([{ colId: 'ag-Grid-AutoColumn', width: 360 }, { colId: 'markets', width: MARKETS_FIXED_WIDTH }])
    expect(sizingForWidth(saved, true)).toBe(saved)
    expect(sizingForWidth(undefined, false)).toBeUndefined()
  })
})
