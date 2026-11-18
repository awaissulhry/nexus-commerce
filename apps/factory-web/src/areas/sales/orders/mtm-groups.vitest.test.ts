import { describe, expect, it } from 'vitest'
import { groupMadeToMeasure, mtmKeyOf, unitsOf } from './mtm-groups'

/**
 * F-SA-232 / F-SA-234 (R9, review C-3): made to measure is grouped per style × colourway on the order page — one row per group,
 * never one per unit; the list's order is kept, the other lines stay as they are.
 */
describe('made to measure, grouped per style × colourway', () => {
  const line = (id: string, kind: string, style: string, colour: string, ordered = 1) => ({ id, kind, style: { code: style, name: style }, colourway: { code: colour, name: colour }, ordered })

  it('the units of one style × colourway are ONE group in the place of the first; size-grid lines stay one each', () => {
    const lines = [line('a', 'SIZE_GRID', 'JKT', 'BLK', 40), line('u1', 'MADE_TO_MEASURE', 'JKT', 'BLK'), line('b', 'SIZE_GRID', 'TRS', 'BLK', 20), line('u2', 'MADE_TO_MEASURE', 'JKT', 'BLK'), line('u3', 'MADE_TO_MEASURE', 'JKT', 'RED')]
    const grouped = groupMadeToMeasure(lines, (entry) => entry.id)
    expect(grouped.map((entry) => entry.key)).toEqual(['a', 'mtm:JKT|BLK', 'b', 'mtm:JKT|RED'])
    const black = grouped[1]!
    expect(black.kind === 'mtm' ? black.lines.map((entry) => entry.id) : null).toEqual(['u1', 'u2'])
  })

  it('a unit is one garment (a line closed short holds none); an unknown style or colourway groups as "—"', () => {
    expect(unitsOf([{ ordered: 1 }, { ordered: 1 }, { ordered: 0 }])).toBe(2)
    expect(unitsOf([{ quantity: 1 }])).toBe(1)
    expect(mtmKeyOf(null, { code: 'BLK' })).toBe('—|BLK')
  })
})
