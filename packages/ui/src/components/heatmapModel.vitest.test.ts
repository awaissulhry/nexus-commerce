import { describe, expect, it } from 'vitest'
import { firstHeatCell, heatAlpha, heatCellWords, heatKey, heatLabelWidth, heatMax, heatMove, isHeatMarked, isHeatPressable } from './heatmapModel'

describe('marks', () => {
  it('keys a cell as row:col and finds it in the marked set', () => {
    expect(heatKey(2, 14)).toBe('2:14')
    const marked = new Set(['0:9', '2:14'])
    expect(isHeatMarked(marked, 2, 14)).toBe(true)
    expect(isHeatMarked(marked, 14, 2)).toBe(false)
    expect(isHeatMarked(undefined, 0, 9)).toBe(false)
  })
})

describe('scale', () => {
  it('ignores nulls and never goes under 1', () => {
    expect(heatMax([[null, 3], [8, null]])).toBe(8)
    expect(heatMax([[null, 0]])).toBe(1)
  })
  it('shades from 5% to 100%', () => {
    expect(heatAlpha(0, 10)).toBe(0.05)
    expect(heatAlpha(10, 10)).toBe(1)
    expect(heatAlpha(5, 10)).toBe(0.525)
    expect(heatAlpha(20, 10)).toBe(1)
  })
})

describe('heatCellWords', () => {
  it('names the row, the column and the value', () => {
    expect(heatCellWords('Mon', '14:00', 12)).toBe('Mon · 14:00: 12')
    expect(heatCellWords('Fit', '', 9)).toBe('Fit: 9')
    expect(heatCellWords('Mon', '14:00', 0.31, v => `${Math.round(v * 100)}% reviewed`)).toBe('Mon · 14:00: 31% reviewed')
  })
  it('says the empty label for a cell with no measurement', () => {
    expect(heatCellWords('Sun', '03:00', null)).toBe('Sun · 03:00: no data')
    expect(heatCellWords('Sun', '03:00', null, undefined, 'none sent')).toBe('Sun · 03:00: none sent')
  })
})

describe('label width and pressable cells (Reviews Insights)', () => {
  it('keeps the label column between 24 and 240 px, 36 when none is named', () => {
    expect(heatLabelWidth(undefined)).toBe(36)
    expect(heatLabelWidth(null)).toBe(36)
    expect(heatLabelWidth(Number.NaN)).toBe(36)
    expect(heatLabelWidth(120)).toBe(120)
    expect(heatLabelWidth(119.6)).toBe(120)
    expect(heatLabelWidth(4)).toBe(24)
    expect(heatLabelWidth(900)).toBe(240)
  })

  it('presses only a measured cell, and lands Tab on the first one', () => {
    expect(isHeatPressable(0)).toBe(true)
    expect(isHeatPressable(3)).toBe(true)
    expect(isHeatPressable(null)).toBe(false)
    expect(firstHeatCell([[null, null], [null, 2]])).toEqual({ row: 1, col: 1 })
    expect(firstHeatCell([[null]])).toBeNull()
  })

  it('moves with the arrows to the nearest measured cell, and stays at an edge', () => {
    const data = [
      [1, null, 3],
      [null, 5, null],
      [7, null, 9],
    ]
    expect(heatMove(data, 0, 0, 'ArrowRight')).toEqual({ row: 0, col: 2 })
    expect(heatMove(data, 0, 2, 'ArrowRight')).toBeNull()
    expect(heatMove(data, 0, 2, 'ArrowLeft')).toEqual({ row: 0, col: 0 })
    expect(heatMove(data, 0, 0, 'ArrowDown')).toEqual({ row: 2, col: 0 })
    expect(heatMove(data, 2, 0, 'ArrowUp')).toEqual({ row: 0, col: 0 })
    expect(heatMove(data, 1, 1, 'ArrowUp')).toBeNull()
    expect(heatMove(data, 2, 2, 'Home')).toEqual({ row: 2, col: 0 })
    expect(heatMove(data, 2, 0, 'End')).toEqual({ row: 2, col: 2 })
    expect(heatMove(data, 2, 2, 'End')).toBeNull()
    expect(heatMove(data, 0, 0, 'Enter')).toBeNull()
  })
})
