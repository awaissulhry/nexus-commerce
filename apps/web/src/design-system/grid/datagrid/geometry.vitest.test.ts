import { describe, expect, it } from 'vitest'

import { GRID_DENSITIES, gridDensity } from '../../tokens/grid'
import { CHECKBOX_COL_W, LINE_BOX, ROW_RULE, SIZE_DENSITY, geometryFor, geometryVars, type DataGridSize } from './geometry'

const SIZES: readonly DataGridSize[] = ['xl', 'lg', 'md', 'sm', 'xs']

describe('the DataGrid on the engine\'s one density scale (grid audit E5)', () => {
  it('the five size names land on the three tiers: xs/sm compact, md cozy, lg/xl spacious', () => {
    expect(SIZE_DENSITY).toEqual({ xs: 'compact', sm: 'compact', md: 'cozy', lg: 'spacious', xl: 'spacious' })
    expect(new Set(Object.values(SIZE_DENSITY))).toEqual(new Set(GRID_DENSITIES))
  })
  it('a one-line row is the tier\'s whole-pixel text row: 28 / 43 / 49, never a fraction', () => {
    expect(geometryFor('xs').rowHeight).toBe(28)
    expect(geometryFor('sm').rowHeight).toBe(28)
    expect(geometryFor('md').rowHeight).toBe(43)
    expect(geometryFor('lg').rowHeight).toBe(49)
    expect(geometryFor('xl').rowHeight).toBe(49)
    for (const s of SIZES) {
      const g = geometryFor(s)
      expect(Number.isInteger(g.rowHeight)).toBe(true)
      expect(g.rowHeight).toBe(gridDensity[g.density].rowText)
      // the cell measures padY + line + padY + rule, so the padding is what is left of the row
      expect(g.padY * 2 + LINE_BOX + ROW_RULE).toBe(g.rowHeight)
      // a row holding a whole-pixel control stays whole
      expect(Number.isInteger(g.padY * 2)).toBe(true)
    }
  })
  it('the horizontal padding and the header are the tier\'s', () => {
    for (const s of SIZES) {
      const g = geometryFor(s)
      expect(g.padX).toBe(gridDensity[g.density].cellPadX)
      expect(g.headerHeight).toBe(gridDensity[g.density].header)
    }
    expect([geometryFor('xs').padY, geometryFor('md').padY, geometryFor('lg').padY]).toEqual([3.5, 11, 14])
  })
  it('the totals row is the header\'s height at every size (grid audit E7)', () => {
    for (const s of SIZES) expect(geometryFor(s).totalsHeight).toBe(geometryFor(s).headerHeight)
  })
  it('md is the default; one geometry object per tier; the checkbox column is 40', () => {
    expect(geometryFor(undefined)).toBe(geometryFor('md'))
    expect(geometryFor('sm')).toBe(geometryFor('xs'))
    expect(geometryFor('xl')).toBe(geometryFor('lg'))
    expect(CHECKBOX_COL_W).toBe(40)
  })
  it('the wrapper variables carry the paddings and the whole-pixel line box the sheet paints', () => {
    expect(geometryVars(geometryFor('sm'))).toEqual({ '--nds-dg-pad-y': '3.5px', '--nds-dg-pad-x': '10px', '--nds-dg-line': '20px' })
    expect(geometryVars(geometryFor('md'))).toEqual({ '--nds-dg-pad-y': '11px', '--nds-dg-pad-x': '14px', '--nds-dg-line': '20px' })
  })
})
