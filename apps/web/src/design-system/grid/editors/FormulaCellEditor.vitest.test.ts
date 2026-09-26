import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CELL_EDITING_UNDER_CLASS, FormulaCellEditor, formulaCellEditorSelector, scalarValueEditor, suppressFormulaKeys } from './FormulaCellEditor'
const capture = vi.hoisted(() => ({ input: null as any, lifecycle: null as any, icons: [] as string[] }))
vi.mock('ag-grid-react', () => ({ useGridCellEditor: (props: any) => { capture.lifecycle = props } }))
vi.mock('../../primitives', () => ({
  Input: React.forwardRef((props: any, _ref: any) => { capture.input = props; return null }),
  Textarea: React.forwardRef((props: any, _ref: any) => { capture.input = props; return null }),
  Button: () => null,
  ToolbarButton: (props: any) => { capture.icons.push(props.label); return null },
  TooltipPortalProvider: (props: any) => props.children,
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

it('passes the edited field to reference candidates, source labels and reference highlighting', () => {
  const candidatesFor = vi.fn(() => [{ name: 'name', kind: 'field' as const }, { name: 'brand', kind: 'field' as const }])
  const sourceLabel = vi.fn(() => 'Shared product · fr')
  const colIdOfRef = vi.fn((name: string, fieldKey?: string) => name === 'name' ? fieldKey! : name)
  const editor = formulaCellEditorSelector({ ...wiring, candidatesFor, sourceLabel, colIdOfRef },
    { key: 'name@fr', formulaWritable: true }, { component: 'agTextCellEditor' }, () => 'p1').cellEditorSelector({ data: {} })
  const params = editor.params as any
  expect(candidatesFor).toHaveBeenCalledWith({}, 'name@fr')
  expect(sourceLabel).toHaveBeenCalledWith('name@fr')
  expect(params.candidates.map((candidate: any) => candidate.name)).toEqual(['brand'])
  expect(params.colIdOfRef('name')).toBe('name@fr')
  expect(colIdOfRef).toHaveBeenLastCalledWith('name', 'name@fr')
})

describe('Option A (Owner, 2026-09-26) — the value editor opens under its cell, as one line with its context', () => {
  const render = (extra: Record<string, unknown>) => {
    vi.stubGlobal('window', { innerWidth: 1200 })
    capture.icons = []
    return renderToStaticMarkup(React.createElement(FormulaCellEditor, { value: 'Xavia', candidates: [], preview: vi.fn(),
      column: { getColId: () => 'brand', getActualWidth: () => 240 }, node: { id: 'p1' }, onValueChange: vi.fn(), ...extra } as any))
  }

  it('opens the value editor UNDER the cell and says so to the editor, with the cell\'s context and length cap', () => {
    const contextFor = vi.fn(() => ({ inherited: { from: 'AIREON', value: 'Nero' } }))
    const editor = formulaCellEditorSelector({ ...wiring, contextFor }, { key: 'colour', formulaWritable: true, maxLength: 50 }, { component: 'agTextCellEditor' }, () => 'p1')
      .cellEditorSelector({ data: { id: 'p1' } }) as any
    expect(editor.popupPosition).toBe('under')
    expect(editor.params.openedUnder).toBe(true)
    expect(editor.params.cellContext).toEqual({ inherited: { from: 'AIREON', value: 'Nero' }, maxLength: 50 })
    expect(contextFor).toHaveBeenCalledWith({ id: 'p1' }, 'colour')
  })

  it('leaves an option / list editor where it opens: an `=` typed there swaps inside that popup, which is not `under`', () => {
    const editor = formulaCellEditorSelector(wiring, { key: 'material', formulaWritable: true }, { component: 'ListPanelEditor' }, () => 'p1')
      .cellEditorSelector({ data: {} }) as any
    expect(editor.popupPosition).toBeUndefined()
    expect(editor.params.openedUnder).toBe(false)
  })

  it('opens the formulas-off value editor under the cell too, on both the selector and the static ColDef path', () => {
    const plain = formulaCellEditorSelector(wiring, { key: 'code', formulaWritable: false, maxLength: 8 }, { component: 'agTextCellEditor' }, () => 'p1')
      .cellEditorSelector({ data: {} }) as any
    expect(plain.popupPosition).toBe('under')
    expect(plain.params).toMatchObject({ formulas: false, openedUnder: true, cellContext: { maxLength: 8 } })
    expect(scalarValueEditor('number')).toMatchObject({ cellEditorPopup: true, cellEditorPopupPosition: 'under' })
  })

  it('shows a context icon only for what the cell carries', () => {
    render({})
    expect(capture.icons).toEqual([])
    render({ cellContext: { aiDraft: { value: 'Xavia Racing', accept: vi.fn(), reject: vi.fn() }, history: vi.fn(), inherited: { from: 'AIREON', value: 'Nero' } } })
    expect(capture.icons).toEqual(['AI draft', 'History', 'Follows AIREON'])
  })

  it('counts long text against the cap and marks it past the cap — never truncating', () => {
    const html = render({ multiline: true, value: 'x'.repeat(12), cellContext: { maxLength: 10 } })
    expect(html).toContain('nds-formula-count bad')
    expect(html).toContain('12 / 10')
    expect(capture.input.value).toBe('x'.repeat(12))
    expect(html).toContain('Shift+Enter adds a line.')
  })

  it('draws no Cancel / Apply: the foot is the key line (and the counter)', () => {
    const html = render({})
    expect(html).toContain('nds-formula-foot')
    expect(html).not.toContain('nds-formula-actions')
  })

  it('exports the class grid.css keys the under-cell rule on', () => {
    expect(CELL_EDITING_UNDER_CLASS).toBe('nds-cell-editing-under')
  })
})

describe('suppressFormulaKeys — Tab on a FORMULA is the editor\'s, so a broken formula is refused like Enter', () => {
  class FakeElement { constructor(readonly attrs: Record<string, string>) {} closest() { return { getAttribute: (name: string) => this.attrs[name] ?? null } } }
  const press = (key: string, attrs: Record<string, string>) => {
    vi.stubGlobal('Element', FakeElement)
    return suppressFormulaKeys({ event: { key, target: new FakeElement(attrs) } as unknown as KeyboardEvent, editing: true })
  }
  it('keeps Tab for AG on a plain value (AG saves the reported value and moves right)', () => {
    expect(press('Tab', { 'data-formula': 'false', 'data-completions': 'false' })).toBe(false)
  })
  it('takes Tab on a formula, and while completions are open', () => {
    expect(press('Tab', { 'data-formula': 'true', 'data-completions': 'false' })).toBe(true)
    expect(press('Tab', { 'data-formula': 'false', 'data-completions': 'true' })).toBe(true)
  })
  it('always takes Enter and Esc', () => {
    expect(press('Enter', {})).toBe(true)
    expect(press('Escape', {})).toBe(true)
    expect(press('ArrowDown', {})).toBe(false)
  })
})
