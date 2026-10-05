import { describe, expect, it } from 'vitest'

import { rendererOwnsKeyboard } from '../rendererKeyboard'
import { ChangeCell } from '../renderers/ChangeCell'
import { actionsColumn, changeColumn } from './presets'

type Fn = (p: unknown) => unknown

describe('actionsColumn shapes (G2)', () => {
  it('the existing shapes keep their width and AG keyboard handling', () => {
    const edit = actionsColumn({ primary: { label: 'Edit', href: () => '#' }, items: () => [] })
    expect(edit.width).toBe(120)
    expect(edit.suppressKeyboardEvent).toBeUndefined()
    expect(actionsColumn({ items: () => [] }).width).toBe(56)
    expect(edit.pinned).toBe('right')
  })

  it('two verbs or a per-row function: 200 wide, and the cell controls keep their keys (Tab walks the verbs)', () => {
    const two = actionsColumn<{ id: string }>({ primary: [{ label: 'Approve' }, { label: 'Reject' }] })
    expect(two.width).toBe(200)
    expect(two.suppressKeyboardEvent).toBe(rendererOwnsKeyboard)
    expect(actionsColumn<{ id: string }>({ primary: () => [] }).width).toBe(200)
    expect(actionsColumn<{ id: string }>({ primary: () => [], width: 240 }).width).toBe(240)
  })
})

describe('changeColumn (G1)', () => {
  const col = changeColumn('change')
  const value = { changes: [{ label: 'Price', from: '€49.90', to: '€44.90' }, { label: 'Stock', from: null, to: '5' }], more: 1 }

  it('draws ChangeCell, unsortable, and says the same words to the tooltip, the CSV and the quick filter', () => {
    expect(col.cellRenderer).toBe(ChangeCell)
    expect(col.sortable).toBe(false)
    expect((col.tooltipValueGetter as Fn)({ value })).toBe('Price: €49.90 → €44.90\nStock: → 5 (new)\n+1 more')
    expect((col.valueFormatter as Fn)({ value })).toBe('Price: €49.90 → €44.90; Stock: → 5 (new); +1 more')
    expect((col.getQuickFilterText as Fn)({ value })).toBe('Price: €49.90 → €44.90; Stock: → 5 (new); +1 more')
  })

  it('no change: no tooltip, an empty export cell — never "[object Object]"', () => {
    expect((col.tooltipValueGetter as Fn)({ value: null })).toBeUndefined()
    expect((col.valueFormatter as Fn)({ value: { changes: [] } })).toBe('')
  })
})
