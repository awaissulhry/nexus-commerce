'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { Button } from '../primitives'
import { DataGrid, type Column } from '../grid/datagrid'
import { FormulaComposer, GridCard, NexusGrid, SHEET_GRID_OPTIONS, formulaCellEditorSelector, formulaTransfer, suppressFormulaKeys,
  exprOf, isFormulaDraft, type ColDef, type FormulaPreviewResponse, type NexusGridProps } from '../grid'

type ExampleRow = { id: string; brand: string; manufacturer: string; title: string; price: number }
const INITIAL: ExampleRow[] = [
  { id: 'one', brand: 'Xavia', manufacturer: '', title: 'Jacket', price: 10 },
  { id: 'two', brand: 'Nexus', manufacturer: '', title: 'Gloves', price: 20 },
  { id: 'three', brand: 'Atlas', manufacturer: '', title: 'Boots', price: 30 },
]
const FIELDS = [{ key: 'brand', label: 'Brand' }, { key: 'manufacturer', label: 'Manufacturer' },
  { key: 'title', label: 'Title' }, { key: 'price', label: 'Price' }] as const
const FUNCTIONS = [{ name: 'upper', signature: 'upper(text)', summary: 'Convert text to uppercase.', group: 'Text' }]
const getRowId: NexusGridProps<ExampleRow>['getRowId'] = p => p.data.id
const rowKey = (row: ExampleRow) => row.id
const REVIEW_COLUMNS: Column<ExampleRow>[] = [
  { key: 'brand', label: 'Brand', width: 180, render: row => row.brand },
  { key: 'title', label: 'Current title', width: 220, render: row => row.title },
]

/** Deliberately finite sample responses. The product editor uses its server evaluator. */
function samplePreview(expr: string, row: ExampleRow): FormulaPreviewResponse {
  const source = expr.trim()
  const values: Record<string, unknown> = {
    '$brand': row.brand, '$manufacturer': row.manufacturer, '$title': row.title, '$price': row.price,
    '$brand & " Jacket"': `${row.brand} Jacket`, 'upper($brand)': row.brand.toUpperCase(),
    'UPPER($brand)': row.brand.toUpperCase(), '10 * 1.2': 12,
  }
  return source in values ? { ok: true, value: values[source] } :
    { ok: false, error: 'This sample supports a field reference, upper($brand), $brand & " Jacket", or 10 * 1.2.' }
}

export function FormulaEditorExample() {
  const [rows, setRows] = useState(() => INITIAL.map(row => ({ ...row })))
  const [formOpen, setFormOpen] = useState(false)
  const [formText, setFormText] = useState('=')
  const formPreview = useCallback(async (expr: string) => samplePreview(expr, rows[0]), [rows])
  const [notice, setNotice] = useState('No sample changes yet.')
  const formulas = useRef(new Map<string, string>())
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const wiring = useMemo(() => ({
    candidatesFor: (row: ExampleRow) => [...FIELDS.map(f => ({ name: f.key, label: f.label, kind: 'field' as const, value: String(row[f.key]) })),
      { name: 'upper', kind: 'function' as const, label: 'upper(text)' }],
    functions: () => FUNCTIONS,
    replaceFormula: async (id: string, field: string, value: unknown) => {
      setRows(current => current.map(row => row.id === id ? { ...row, [field]: value } : row))
      formulas.current.delete(`${id}:${field}`)
      setNotice(`Replaced ${field} formula with a value.`)
      return { ok: true }
    },
    exprFor: (row: string, field: string) => formulas.current.get(`${row}:${field}`) ?? null,
    colIdOfRef: (name: string) => name,
    preview: async (id: string, _field: string, expr: string) => samplePreview(expr, rowsRef.current.find(row => row.id === id)!),
  }), [])
  const columns = useMemo<ColDef<ExampleRow>[]>(() => FIELDS.map(f => ({
    field: f.key, headerName: f.label, editable: true, cellDataType: false, minWidth: 150, flex: 1,
    suppressKeyboardEvent: suppressFormulaKeys,
    ...formulaCellEditorSelector(wiring, { key: f.key, kind: f.key === 'price' ? 'number' : 'text', formulaWritable: true },
      { component: f.key === 'title' ? 'agLargeTextCellEditor' : 'agTextCellEditor' }, row => row.id),
  })), [wiring])
  const clipboard = useMemo(() => formulaTransfer<ExampleRow>({ exprFor: (row, field) => wiring.exprFor(row.id, field) }), [wiring])
  const onCellValueChanged = useCallback<NonNullable<NexusGridProps<ExampleRow>['onCellValueChanged']>>(event => {
    const field = event.column.getColId() as keyof Omit<ExampleRow, 'id'>
    const key = `${event.data.id}:${field}`
    const formula = typeof event.newValue === 'string' && isFormulaDraft(event.newValue)
    const expr = formula ? exprOf(event.newValue) : null
    const next = expr ? samplePreview(expr, event.data).value : event.newValue
    if (expr) formulas.current.set(key, expr)
    else formulas.current.delete(key)
    setRows(current => current.map(row => row.id === event.data.id ? { ...row, [field]: next } : row))
    setNotice(`Saved ${field} for ${event.data.brand}: ${String(next)}`)
  }, [])
  return <div id="formula-editor-example">
    <p>Try the real cell editor with sample rows. Double-click Manufacturer and type <code>=</code>, then click Brand in that row.
      For Title, insert Brand and use Add text to append “ Jacket”, or try <code>=$brand &amp; " Jacket"</code> or <code>=upper($brand)</code>. Copy or fill down to use each row’s brand.</p>
    <p>This sample accepts only the example formulas and changes sample data in this page. Product formulas use the server evaluator.</p>
    <GridCard><NexusGrid<ExampleRow> {...SHEET_GRID_OPTIONS} {...clipboard} rowData={rows} columnDefs={columns}
      getRowId={getRowId} domLayout="autoHeight" onCellValueChanged={onCellValueChanged} /></GridCard>
    <p role="status">{notice}</p>
    <Button size="sm" onClick={() => setFormOpen(value => !value)}>{formOpen ? 'Close formula form' : 'Open formula form'}</Button>
    {formOpen && <div style={{ maxWidth: 320, marginBlock: 'var(--nds-space-12)' }}>
      <p>The same composer used in record drawers, constrained to a narrow form.</p>
      <FormulaComposer text={formText} onChange={setFormText} candidates={wiring.candidatesFor(rows[0]).filter(c => c.name !== 'title')}
        functions={FUNCTIONS} preview={formPreview} sourceLabel="Sample product" ariaLabel="Sample title formula"
        onCancel={() => setFormOpen(false)} onApply={async text => {
          const result = isFormulaDraft(text) ? samplePreview(exprOf(text), rows[0]) : { ok: true, value: text }
          if (result.ok) {
            setRows(current => current.map((row, index) => index === 0 ? { ...row, title: String(result.value) } : row))
            if (isFormulaDraft(text)) formulas.current.set('one:title', exprOf(text))
            else formulas.current.delete('one:title')
            setNotice(`Saved sample title: ${String(result.value)}`)
          }
          return { ok: result.ok, error: result.error ?? undefined }
        }} />
      <p>Result grids stay within a narrow form. Focus a cell and use arrow keys to reach the next column.</p>
      <DataGrid ariaLabel="Sample formula results" keyboardScroll columns={REVIEW_COLUMNS} rows={rows} rowKey={rowKey} size="sm" />
    </div>}
    <Button size="sm" onClick={() => { formulas.current.clear(); setRows(INITIAL.map(row => ({ ...row }))); setNotice('Sample reset.') }}>Reset sample</Button>
  </div>
}
