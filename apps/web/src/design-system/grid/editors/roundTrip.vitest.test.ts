import { describe, expect, it } from 'vitest'

import { CellSaveTracker, roundTripClassRules, SAVED_FADE_MS } from './roundTrip'

interface Row {
  id: string
  bid: number
}

const rules = (t: CellSaveTracker) => {
  const r = roundTripClassRules<Row>(t, (row) => row.id)
  // A CellClassRules value may be a string or a predicate; ours are always predicates.
  return (name: keyof typeof r, data: Row | undefined, colId: string) => (r[name] as (p: unknown) => boolean)({ data, colDef: { colId } })
}

describe('CellSaveTracker', () => {
  it('a refused save stays until the cell is touched again — it is a result, not a flash', () => {
    const t = new CellSaveTracker()
    t.set('r1', 'bid', 'refused', 'Below the floor', 0)
    expect(t.get('r1', 'bid')).toEqual({ state: 'refused', reason: 'Below the floor', at: 0 })
    t.sweep(SAVED_FADE_MS * 10)
    expect(t.get('r1', 'bid')?.state).toBe('refused')
    t.clear('r1', 'bid')
    expect(t.get('r1', 'bid')).toBeUndefined()
  })

  it('a saved mark fades after SAVED_FADE_MS; a saving one does not', () => {
    const t = new CellSaveTracker()
    t.set('r1', 'bid', 'saved', undefined, 0)
    t.set('r2', 'bid', 'saving', undefined, 0)
    expect(t.sweep(SAVED_FADE_MS - 1)).toEqual([])
    expect(t.sweep(SAVED_FADE_MS)).toEqual([CellSaveTracker.key('r1', 'bid')])
    expect(t.get('r2', 'bid')?.state).toBe('saving')
  })

  it('notifies subscribers on change only', () => {
    const t = new CellSaveTracker()
    let n = 0
    const off = t.subscribe(() => n++)
    t.set('r1', 'bid', 'saving')
    t.clear('r1', 'bid')
    t.clear('r1', 'bid') // nothing to clear → no emit
    off()
    t.set('r1', 'bid', 'saving')
    expect(n).toBe(2)
  })
})

describe('roundTripClassRules', () => {
  it('keys the class on the row id AND the column, so a sibling cell is never painted', () => {
    const t = new CellSaveTracker()
    const r = rules(t)
    t.set('r1', 'bid', 'saving')
    expect(r('nds-cell-is-saving', { id: 'r1', bid: 1 }, 'bid')).toBe(true)
    expect(r('nds-cell-is-saving', { id: 'r1', bid: 1 }, 'budget')).toBe(false)
    expect(r('nds-cell-is-saving', { id: 'r2', bid: 1 }, 'bid')).toBe(false)
    expect(r('nds-cell-is-refused', { id: 'r1', bid: 1 }, 'bid')).toBe(false)
  })

  it('a row with no data (a loading placeholder) is never painted', () => {
    const t = new CellSaveTracker()
    const r = rules(t)
    t.set('r1', 'bid', 'refused', 'x')
    expect(r('nds-cell-is-refused', undefined, 'bid')).toBe(false)
  })
})
