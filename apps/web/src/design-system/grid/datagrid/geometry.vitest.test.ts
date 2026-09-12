import { describe, expect, it } from 'vitest'

import { gridDensity } from '../../tokens/grid'
import { CHECKBOX_COL_W, DATAGRID_SIZES, LINE_HEIGHT, ROW_RULE, SIZE_GEOMETRY, geometryFor, geometryVars } from './geometry'

describe('the legacy .nds-grid geometry per size — derived from components.css, checked against the 1728px baseline', () => {
  it('a one-line row is padY·2 + font·1.5 + the 1px rule: sm 33.75 (measured), md 42.5, xs 28.25, lg 48.5, xl 58.5', () => {
    expect(SIZE_GEOMETRY.sm.rowHeight).toBe(33.75)
    expect(SIZE_GEOMETRY.md.rowHeight).toBe(42.5)
    expect(SIZE_GEOMETRY.xs.rowHeight).toBe(28.25)
    expect(SIZE_GEOMETRY.lg.rowHeight).toBe(48.5)
    expect(SIZE_GEOMETRY.xl.rowHeight).toBe(58.5)
    for (const s of DATAGRID_SIZES) {
      const g = SIZE_GEOMETRY[s]
      expect(g.rowHeight).toBe(g.padY * 2 + g.fontPx * LINE_HEIGHT + ROW_RULE)
      expect(g.lineBox).toBe(g.fontPx * LINE_HEIGHT)
    }
  })
  it('the paddings and fonts are the tiers\' (components.css:1426, 2247-2326)', () => {
    expect([SIZE_GEOMETRY.md.padY, SIZE_GEOMETRY.md.padX, SIZE_GEOMETRY.md.fontPx]).toEqual([11, 14, 13])
    expect([SIZE_GEOMETRY.sm.padY, SIZE_GEOMETRY.sm.padX, SIZE_GEOMETRY.sm.fontPx]).toEqual([7, 10, 12.5])
    expect([SIZE_GEOMETRY.xs.padY, SIZE_GEOMETRY.xs.padX, SIZE_GEOMETRY.xs.fontPx]).toEqual([5, 9, 11.5])
    expect([SIZE_GEOMETRY.lg.padY, SIZE_GEOMETRY.lg.padX]).toEqual([14, 14])
    expect([SIZE_GEOMETRY.xl.padY, SIZE_GEOMETRY.xl.padX]).toEqual([19, 14])
  })
  it('the header is the engine\'s nearest tier: md cozy 38, sm/xs compact 28, lg/xl spacious 46', () => {
    expect([SIZE_GEOMETRY.md.density, SIZE_GEOMETRY.md.headerHeight]).toEqual(['cozy', gridDensity.cozy.header])
    expect(SIZE_GEOMETRY.sm.density).toBe('compact')
    expect(SIZE_GEOMETRY.xs.density).toBe('compact')
    expect(SIZE_GEOMETRY.lg.density).toBe('spacious')
    expect(SIZE_GEOMETRY.xl.density).toBe('spacious')
  })
  it('the totals row before measurement: the TABLE\'s 13px line + the top rule and NO padding (the app reset zeroes the UA td padding — measured), at every size', () => {
    for (const s of DATAGRID_SIZES) expect(SIZE_GEOMETRY[s].totalsHeight).toBe(19.5 + 1)
  })
  it('md is the default; the checkbox column is 40', () => {
    expect(geometryFor(undefined)).toBe(SIZE_GEOMETRY.md)
    expect(CHECKBOX_COL_W).toBe(40)
  })
  it('the wrapper variables bind the DS font TOKEN, never a pixel literal, and carry the paddings the sheet paints', () => {
    const v = geometryVars(SIZE_GEOMETRY.sm) as Record<string, string>
    expect(v['--nds-dg-font']).toBe('var(--nds-font-size-sm-plus)')
    expect(v['--nds-dg-pad-y']).toBe('7px')
    expect(v['--nds-dg-pad-x']).toBe('10px')
    expect(v['--nds-dg-line']).toBe('1.5')
    expect(v['--nds-dg-row-h']).toBe('33.75px')
    expect((geometryVars(SIZE_GEOMETRY.md) as Record<string, string>)['--nds-dg-font']).toBe('var(--nds-font-size-base)')
  })
})
