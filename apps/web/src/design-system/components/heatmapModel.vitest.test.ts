import { describe, expect, it } from 'vitest'
import { heatAlpha, heatCellWords, heatKey, heatMax, isHeatMarked } from './heatmapModel'

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
