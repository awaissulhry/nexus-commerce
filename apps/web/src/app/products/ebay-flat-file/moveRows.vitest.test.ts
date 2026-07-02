import { describe, it, expect } from 'vitest'
import { moveRowsToParent, type MoveableRow } from './moveRows'

const mkRow = (overrides: Partial<MoveableRow> & { _rowId: string }): MoveableRow => ({
  ...overrides,
})

describe('moveRowsToParent', () => {
  it('(a) moves a selected child row to the target parent', () => {
    const rows: MoveableRow[] = [
      mkRow({ _rowId: 'r1', _isParent: false, platformProductId: 'old-parent', _productId: 'p-r1' }),
    ]
    const result = moveRowsToParent(rows, new Set(['r1']), 'new-parent')
    expect(result[0].platformProductId).toBe('new-parent')
    expect(result[0]._isParent).toBe(false)
    expect(result[0]._dirty).toBe(true)
  })

  it('(b) leaves a selected _isParent row unchanged', () => {
    const rows: MoveableRow[] = [
      mkRow({ _rowId: 'p1', _isParent: true, platformProductId: undefined }),
    ]
    const result = moveRowsToParent(rows, new Set(['p1']), 'target')
    expect(result[0]).toBe(rows[0])
  })

  it('(c) leaves a selected _shared row unchanged', () => {
    const rows: MoveableRow[] = [
      mkRow({ _rowId: 'r1', _isParent: false, _shared: true }),
    ]
    const result = moveRowsToParent(rows, new Set(['r1']), 'target')
    expect(result[0]).toBe(rows[0])
  })

  it('(c) leaves a selected _readonly row unchanged', () => {
    const rows: MoveableRow[] = [
      mkRow({ _rowId: 'r1', _isParent: false, _readonly: true }),
    ]
    const result = moveRowsToParent(rows, new Set(['r1']), 'target')
    expect(result[0]).toBe(rows[0])
  })

  it("(d) no-ops when target matches the row's own _productId (self-parent guard)", () => {
    const rows: MoveableRow[] = [
      mkRow({ _rowId: 'r1', _isParent: false, _productId: 'same-id', platformProductId: 'old' }),
    ]
    const result = moveRowsToParent(rows, new Set(['r1']), 'same-id')
    expect(result[0]).toBe(rows[0])
  })

  it('(e) no-ops (not dirty) when row is already under the target parent', () => {
    const rows: MoveableRow[] = [
      mkRow({ _rowId: 'r1', _isParent: false, platformProductId: 'existing-parent', _dirty: false }),
    ]
    const result = moveRowsToParent(rows, new Set(['r1']), 'existing-parent')
    expect(result[0]).toBe(rows[0])
    expect(result[0]._dirty).toBeFalsy()
  })

  it('(f) leaves an unselected row unchanged', () => {
    const rows: MoveableRow[] = [
      mkRow({ _rowId: 'r1', _isParent: false, platformProductId: 'old' }),
      mkRow({ _rowId: 'r2', _isParent: false, platformProductId: 'old' }),
    ]
    const result = moveRowsToParent(rows, new Set(['r1']), 'new-parent')
    expect(result[1]).toBe(rows[1])
    expect(result[0].platformProductId).toBe('new-parent')
  })
})
