import { describe, expect, it } from 'vitest'
import { costChangesOf, costChangeWords, sheetKeysOf, type CostLine } from './model'

/** B-W2b-380 (XF6:02): cost changed since priced — which sheets are read, how far each line moved, the mark's words. */

const cell = (colourwayId: string, size: string, total: string | null, complete = true) => ({ colourwayId, size, complete, material: { amount: total }, labour: { amount: '0' }, overhead: null, total })
const line = (id: string, extra: Partial<CostLine> = {}): CostLine => ({ id, kind: 'SIZE_GRID', styleId: 's1', styleRevisionId: 'r1', colourwayId: 'c1', quantity: 3, unitCost: '250', sizes: [{ size: '50', quantity: 1 }, { size: '52', quantity: 2 }], ...extra })

describe('cost changed since priced', () => {
  it('reads one sheet per style revision of a priced size-grid line (never a fee, never a line without its cost)', () => {
    expect(sheetKeysOf([line('a'), line('b'), line('c', { styleRevisionId: 'r2' }), line('fee', { kind: 'FEE' }), line('none', { unitCost: undefined }), line('norev', { styleRevisionId: null })]).map((entry) => entry.key)).toEqual(['s1:r1', 's1:r2'])
  })

  it("weights the sheet's cells by the line's pieces per size, against the cost the line keeps; unknown stays unknown", () => {
    const sheets = new Map([['s1:r1', { cells: [cell('c1', '50', '250'), cell('c1', '52', '256')] }]])
    const changes = costChangesOf([line('a'), line('b', { unitCost: '254' }), line('c', { styleRevisionId: 'r9' }), line('d', { sizes: [{ size: null, quantity: 3 }] })], sheets)
    // (250 + 2 × 256) / 3 = 254: 4 dearer than 250, nothing against 254.
    expect([...changes.entries()]).toEqual([
      ['a', 4],
      ['b', 0],
      ['c', null],
      ['d', null],
    ])
    expect(costChangesOf([line('a')], new Map([['s1:r1', { cells: [cell('c1', '50', '250', false), cell('c1', '52', '256')] }]])).get('a')).toBeNull()
  })

  it('the words: dearer or cheaper by the amount; nothing when it did not move', () => {
    expect(costChangeWords(4.2)).toEqual({ key: 'cost.up', amount: 4.2 })
    expect(costChangeWords(-2.5)).toEqual({ key: 'cost.down', amount: 2.5 })
    expect(costChangeWords(0)).toBeNull()
    expect(costChangeWords(null)).toBeNull()
  })
})
