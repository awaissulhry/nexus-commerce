import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FormulaCellEditor, formulaCellEditorSelector } from './FormulaCellEditor'
const capture = vi.hoisted(() => ({ input: null as any, lifecycle: null as any }))
vi.mock('ag-grid-react', () => ({ useGridCellEditor: (props: any) => { capture.lifecycle = props } }))
vi.mock('../../primitives', () => ({
  Input: React.forwardRef((props: any, _ref: any) => { capture.input = props; return null }),
  Textarea: React.forwardRef((props: any, _ref: any) => { capture.input = props; return null }),
  Button: () => null,
}))
vi.mock('../../components', () => ({ ListboxPanel: () => null }))
afterEach(() => vi.unstubAllGlobals())
const wiring = { candidatesFor: () => [{ kind: 'field' as const, name: 'brand' }], preview: vi.fn(), functions: () => [], exprFor: () => null, colIdOfRef: (key: string) => key }

describe('formula entry uses the actual reactive editor contract', () => {
  it.each(['agTextCellEditor', 'agLargeTextCellEditor', 'agNumberCellEditor'])('keeps %s formula-aware after double click', component => {
    const editor = formulaCellEditorSelector(wiring, { key: 'name', formulaWritable: true }, { component }, () => 'p1').cellEditorSelector({ data: {} })
    expect(editor.component).toBe(FormulaCellEditor)
    expect(editor.popup).toBe(true)
  })
  it('retains the original editor for unsupported fields and rows', () => {
    expect(formulaCellEditorSelector(wiring, { key: 'name', formulaWritable: false }, { component: 'original' }, () => 'p1').cellEditorSelector({ data: {}, eventKey: '=' }).component).toBe('original')
    expect(formulaCellEditorSelector({ ...wiring, canEditRow: () => false }, { key: 'name', formulaWritable: true }, { component: 'original' }, () => 'p1').cellEditorSelector({ data: {}, eventKey: '=' }).component).toBe('original')
  })
  it('reports each typed formula synchronously, while opening an existing formula makes no change', () => {
    vi.stubGlobal('window', { innerWidth: 1200 })
    const onValueChange = vi.fn()
    renderToStaticMarkup(React.createElement(FormulaCellEditor, { value: 'Xavia', formulaExpr: '$brand', candidates: [], preview: vi.fn(),
      column: { getColId: () => 'name', getActualWidth: () => 240 }, node: { id: 'p1' }, onValueChange } as any))
    expect(capture.input.value).toBe('=$brand')
    expect(capture.lifecycle.isCancelAfterEnd()).toBe(true)
    expect(onValueChange).not.toHaveBeenCalled()
    capture.input.onChange({ target: { value: '=$brand & " Jacket"', selectionStart: 19 } })
    expect(onValueChange).toHaveBeenCalledWith('=$brand & " Jacket"')
  })
})
