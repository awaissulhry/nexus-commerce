import { describe, expect, it, vi } from 'vitest'
import { formulaFillSourceIndex, formulaTransfer } from './formulaTransfer'

describe('formula copy and fill', () => {
  it('repeats the source rows in both directions, using displayed order', () => {
    expect([0, 1, 2, 3].map(i => formulaFillSourceIndex(5 + i, i, 2, 'down'))).toEqual([3, 4, 3, 4])
    expect([0, 1, 2, 3].map(i => formulaFillSourceIndex(4 - i, i, 2, 'up'))).toEqual([6, 5, 6, 5])
  })
  it('copies the expression and retains normal formatting for ordinary cells', () => {
    const transfer = formulaTransfer<{ id: string }>({ exprFor: row => row.id === 'formula' ? '$brand & " Jacket"' : null })
    const p = { node: { data: { id: 'formula' } }, column: { getColId: () => 'name' }, value: 'Xavia Jacket', formatValue: () => 'formatted' }
    expect(transfer.processCellForClipboard(p as never)).toBe('=$brand & " Jacket"')
    p.node.data.id = 'literal'
    expect(transfer.processCellForClipboard(p as never)).toBe('formatted')
  })
  it('fills a saved formula rather than its numeric result', () => {
    const col = { getColId: () => 'price' }
    const exprFor = vi.fn(() => '$costPrice * 1.2')
    const transfer = formulaTransfer({ exprFor })
    const p = { initialValues: [12], rowNode: { data: { id: 'target' }, rowIndex: 4 }, column: col, currentIndex: 1, direction: 'down',
      api: { getAllDisplayedColumns: () => [col], getDisplayedRowAtIndex: (index: number) => ({ data: { id: `row-${index}` } }) } }
    expect(transfer.cellSelection.handle.setFillValue(p as never)).toBe('=$costPrice * 1.2')
    expect(exprFor).toHaveBeenCalledWith({ id: 'row-2' }, 'price')
  })
})
