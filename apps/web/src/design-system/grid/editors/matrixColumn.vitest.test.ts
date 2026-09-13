/**
 * MX.G — `matrixColumnDef`: the ONE column builder, held to its own contract.
 *
 * `ag-grid-react` is mocked so the editors' `useGridCellEditor` lifecycle can be READ (the pattern
 * `FormulaCellEditor.vitest.test.ts` established). Everything else is the real module: the ColDef
 * pieces are called the way AG calls them, with the params shapes AG hands them.
 *
 * What a Node suite cannot prove, stated so the ledger does not claim it: AG's own commit path
 * (`saveNewValue` → `setDataValue` → the event), the popup's geometry, and a real drag of the fill
 * handle. Those are measured in the browser and the numbers go in the ledger.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ColDef, ValueSetterParams } from 'ag-grid-community'

const lifecycle: { isCancelAfterEnd?: () => boolean } = {}
vi.mock('ag-grid-react', () => ({
  useGridCellEditor: (props: { isCancelAfterEnd?: () => boolean }) => { lifecycle.isCancelAfterEnd = props.isCancelAfterEnd },
}))

import { MATRIX_CELL_KINDS, MATRIX_CELL_LABELS, MATRIX_CELL_WIDTHS, type MatrixCellKind, type MatrixCells, type MatrixCoordinate } from '../matrix/contract'
import { MATRIX_CELL_CLASSES, MATRIX_FILLABLE_KINDS } from '../renderers/matrixCells'
import { MATRIX_CELL_RENDERERS } from '../renderers/MatrixCellViews'
import { FormulaCellEditor, type FormulaWiring } from './FormulaCellEditor'
import { matrixColumnDef, type MatrixColumnOptions } from './matrixColumn'
import { CellSaveTracker } from './roundTrip'
import { SaleCellEditor } from './SaleCellEditor'
import { SelectPanelEditor, SELECT_CELL_CLASS } from './index'

interface Row { id: string; cells: Record<string, MatrixCells> }

const COORD: MatrixCoordinate = {
  key: 'AMAZON:IT', kind: 'market', channel: 'AMAZON', market: 'IT', label: 'Amazon · IT', region: 'EU', alias: null,
  accountId: 'acc', currency: 'EUR', connected: true, listed: 5, draft: 1, cells: MATRIX_CELL_KINDS, absent: [],
  sharedInventoryWith: null, inventoryOn: null, vocabulary: { fulfilment: ['FBA', 'FBM'] },
}

function cellsOf(): MatrixCells {
  return {
    listingId: 'L1', version: 3,
    listing: { state: 'listed', externalId: null, detail: null, published: true },
    fulfilment: { method: 'FBM', source: 'set', guard: 'FBM', reported: null },
    sync: { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 403, held: 403, buffer: 0, poolAvailable: 403, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false },
    queue: { state: 'sent', at: '2026-09-13T05:00:00.000Z', reason: null, syncType: 'QUANTITY_UPDATE', via: null },
    price: { value: 105, currency: 'EUR', source: 'master', formula: null, clamped: null },
    sale: { value: null, start: null, end: null },
    writable: { fulfilment: true, syncMode: true, syncQty: true, syncBuffer: true, price: true, salePrice: true },
    writeBlockedReason: {},
  }
}
const row = (): Row => ({ id: 'r1', cells: { 'AMAZON:IT': cellsOf() } })
const opts = (extra: Partial<MatrixColumnOptions<Row>> = {}): MatrixColumnOptions<Row> => ({
  colId: 'AMAZON:IT.syncQty', coordinate: COORD, cells: (d) => d?.cells['AMAZON:IT'] ?? null, rowIdOf: (d) => d.id, ...extra,
})
const def = (kind: MatrixCellKind, extra: Partial<MatrixColumnOptions<Row>> = {}) => matrixColumnDef<Row>(kind, opts({ colId: `AMAZON:IT.${kind}`, ...extra })) as Required<ColDef<Row>>
const call = <F,>(f: F | undefined | boolean | string, ...args: unknown[]) => (typeof f === 'function' ? (f as (...a: unknown[]) => unknown)(...args) : f)
/* AG types these members as `string | Func`; the builder always sets the function form. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fn = (f: unknown) => f as (...a: any[]) => any

describe('matrixColumnDef — one ColDef per kind, every piece from the engine tables', () => {
  it('width, minWidth and header come from the contract tables for all eight kinds (counted)', () => {
    let arms = 0
    for (const kind of MATRIX_CELL_KINDS) {
      const d = def(kind)
      expect(d.colId).toBe(`AMAZON:IT.${kind}`)
      expect(d.width).toBe(MATRIX_CELL_WIDTHS[kind])
      expect(d.minWidth).toBe(MATRIX_CELL_WIDTHS[kind])
      expect(d.headerName).toBe(MATRIX_CELL_LABELS[kind])
      expect(d.cellRenderer).toBe(MATRIX_CELL_RENDERERS[kind])
      expect(d.cellDataType).toBe(false)
      expect(d.suppressMovable).toBe(true)
      arms++
    }
    expect(arms).toBe(8)
  })

  it('the fill handle is suppressed on exactly the non-fillable kinds', () => {
    for (const kind of MATRIX_CELL_KINDS) expect(def(kind).suppressFillHandle).toBe(!MATRIX_FILLABLE_KINDS.includes(kind))
    expect(def('fulfilment').suppressFillHandle).toBe(true)
    expect(def('listing').suppressFillHandle).toBe(true)
    expect(def('syncState').suppressFillHandle).toBe(true)
    expect(def('syncBuffer').suppressFillHandle).toBe(false)
  })

  it('editable reads the wire: facts never, writable kinds yes, a held cell no, and fulfilment opens its select', () => {
    const r = row()
    expect(call(def('listing').editable, { data: r })).toBe(false)
    expect(call(def('syncState').editable, { data: r })).toBe(false)
    expect(call(def('syncQty').editable, { data: r })).toBe(true)
    expect(call(def('fulfilment').editable, { data: r })).toBe(true)
    r.cells['AMAZON:IT']!.writable.syncQty = false
    expect(call(def('syncQty').editable, { data: r })).toBe(false)
    expect(call(def('syncQty').editable, { data: undefined })).toBe(false)
  })

  it('editors: the DS listbox for Mode and Fulfilment, AG’s number editor for Qty/Buffer/Price, the sale popup for Sale, none for facts', () => {
    expect(def('syncMode').cellEditor).toBe(SelectPanelEditor)
    expect(def('syncMode').cellEditorPopup).toBe(true)
    expect((def('syncMode').cellEditorParams as { options: Array<{ value: string }> }).options.map((o) => o.value)).toEqual(['FOLLOW', 'PINNED'])
    expect(def('fulfilment').cellEditor).toBe(SelectPanelEditor)
    expect((def('fulfilment').cellEditorParams as { options: Array<{ value: string }> }).options.map((o) => o.value)).toEqual(['FBA', 'FBM'])
    /* A channel with no fulfilment vocabulary gets no editor at all. */
    const noVocab = def('fulfilment', { coordinate: { ...COORD, vocabulary: { fulfilment: null } } })
    expect(noVocab.cellEditor).toBeUndefined()
    expect(def('syncQty').cellEditor).toBe('agNumberCellEditor')
    expect((def('syncQty').cellEditorParams as { precision: number }).precision).toBe(0)
    expect(def('price').cellEditor).toBe('agNumberCellEditor')
    expect((def('price').cellEditorParams as { precision: number; step: number }).precision).toBe(2)
    expect(def('salePrice').cellEditor).toBe(SaleCellEditor)
    expect(def('salePrice').cellEditorPopup).toBe(true)
    expect((def('salePrice').cellEditorParams as { currency: string }).currency).toBe('EUR')
    expect(def('listing').cellEditor).toBeUndefined()
    expect(def('syncState').cellEditor).toBeUndefined()
  })

  it('price takes the formula-aware selector when the host wires formula; cellEditor is then NOT also set', () => {
    const wiring: FormulaWiring<Row> = { candidatesFor: () => [], preview: vi.fn(), functions: () => [], exprFor: () => null, colIdOfRef: (k) => k }
    const d = def('price', { formula: wiring })
    expect(d.cellEditor).toBeUndefined()
    const chosen = (d.cellEditorSelector as (p: unknown) => { component: unknown; popup: boolean })({ data: row(), eventKey: '=' })
    expect(chosen.component).toBe(FormulaCellEditor)
    expect(chosen.popup).toBe(true)
    /* Without `rowIdOf` the selector cannot address a row — the plain number editor is kept. */
    expect(def('price', { formula: wiring, rowIdOf: undefined }).cellEditor).toBe('agNumberCellEditor')
  })

  it('the value getter answers the fill-safe scalar (the compound for a sale)', () => {
    const r = row()
    expect(fn(def('syncQty').valueGetter)({ data: r } as never)).toBe(403)
    expect(fn(def('syncMode').valueGetter)({ data: r } as never)).toBe('FOLLOW')
    expect(fn(def('price').valueGetter)({ data: r } as never)).toBe(105)
    expect(fn(def('salePrice').valueGetter)({ data: r } as never)).toEqual({ value: null, start: null, end: null })
    expect(fn(def('listing').valueGetter)({ data: r } as never)).toBeNull()
    expect(fn(def('syncQty').valueGetter)({ data: undefined } as never)).toBeNull()
  })

  it('the setter MUTATES params.data by default and reports true (positive control); junk reports false and mutates nothing', () => {
    const r = row()
    const ok = fn(def('syncQty').valueSetter)({ data: r, newValue: 10, oldValue: 403 } as ValueSetterParams<Row>)
    expect(ok).toBe(true)
    expect(r.cells['AMAZON:IT']!.sync!.intended).toBe(10)
    expect(r.cells['AMAZON:IT']!.sync!.mode).toBe('FOLLOW') // the class stays untouched — the store pins
    const bad = fn(def('syncQty').valueSetter)({ data: r, newValue: 'abc', oldValue: 10 } as ValueSetterParams<Row>)
    expect(bad).toBe(false)
    expect(r.cells['AMAZON:IT']!.sync!.intended).toBe(10)
    expect(fn(def('syncQty').valueSetter)({ data: undefined, newValue: 1 } as unknown as ValueSetterParams<Row>)).toBe(false)
    /* A host-supplied `applyValue` is called instead, with the same junk guard. */
    const applyValue = vi.fn()
    expect(fn(def('syncBuffer', { applyValue }).valueSetter)({ data: r, newValue: '3', oldValue: 0 } as ValueSetterParams<Row>)).toBe(true)
    expect(applyValue).toHaveBeenCalledWith(r, 'syncBuffer', '3')
    expect(fn(def('syncBuffer', { applyValue }).valueSetter)({ data: r, newValue: -1, oldValue: 0 } as ValueSetterParams<Row>)).toBe(false)
    expect(applyValue).toHaveBeenCalledTimes(1)
  })

  it('the fulfilment setter routes the choice to onPickFulfilment, returns false, and mutates NOTHING', () => {
    const r = row()
    const onPickFulfilment = vi.fn()
    const applyValue = vi.fn()
    const p = { data: r, newValue: 'FBA', oldValue: 'FBM', node: { id: 'r1' } } as unknown as ValueSetterParams<Row>
    expect(fn(def('fulfilment', { onPickFulfilment, applyValue }).valueSetter)(p)).toBe(false)
    expect(onPickFulfilment).toHaveBeenCalledWith('FBA', p)
    expect(applyValue).not.toHaveBeenCalled()
    expect(r.cells['AMAZON:IT']!.fulfilment!.method).toBe('FBM')
    /* An unknown method opens nothing (negative control on the same path). */
    expect(fn(def('fulfilment', { onPickFulfilment }).valueSetter)({ ...p, newValue: 'DROPSHIP' } as ValueSetterParams<Row>)).toBe(false)
    expect(onPickFulfilment).toHaveBeenCalledTimes(1)
  })

  it('class rules carry the five Matrix classes (from the pure function), the select affordance, and OR the tracker’s refused', () => {
    const tracker = new CellSaveTracker()
    const r = row()
    const d = def('syncState', { tracker })
    const rules = d.cellClassRules as Record<string, (p: unknown) => boolean>
    for (const cls of MATRIX_CELL_CLASSES) expect(typeof rules[cls]).toBe('function')
    expect(rules[SELECT_CELL_CLASS]).toBeUndefined()
    expect(typeof def('syncMode').cellClassRules![SELECT_CELL_CLASS]).toBe('function')
    expect(call(def('syncMode').cellClassRules![SELECT_CELL_CLASS], { data: r })).toBe(true)
    /* A sent queue: not refused by the Matrix rule, not refused by the tracker. */
    expect(rules['nds-cell-is-refused']!({ data: r, colDef: { colId: 'AMAZON:IT.syncState' } })).toBe(false)
    /* A dead queue paints refused from the MATRIX rule. */
    r.cells['AMAZON:IT']!.queue!.state = 'dead'
    expect(rules['nds-cell-is-refused']!({ data: r, colDef: { colId: 'AMAZON:IT.syncState' } })).toBe(true)
    /* A write the server refused paints refused from the TRACKER rule, on a kind whose Matrix rule is false. */
    const q = def('syncQty', { tracker })
    const qRules = q.cellClassRules as Record<string, (p: unknown) => boolean>
    expect(qRules['nds-cell-is-refused']!({ data: r, colDef: { colId: 'AMAZON:IT.syncQty' } })).toBe(false)
    tracker.set('r1', 'AMAZON:IT.syncQty', 'refused', 'no')
    expect(qRules['nds-cell-is-refused']!({ data: r, colDef: { colId: 'AMAZON:IT.syncQty' } })).toBe(true)
    expect(qRules['nds-cell-is-inherited']!({ data: r, colDef: { colId: 'AMAZON:IT.syncQty' } })).toBe(true)
  })

  it('the validation tint reads the Matrix rule: a negative quantity is invalid, a good one is not', () => {
    const rules = def('syncQty').cellClassRules as Record<string, (p: unknown) => boolean>
    const p = (value: unknown) => ({ data: row(), value, colDef: { colId: 'AMAZON:IT.syncQty' } })
    expect(rules['nds-cell-is-invalid']!(p(-1))).toBe(true)
    expect(rules['nds-cell-is-invalid']!(p(5))).toBe(false)
    expect(rules['nds-cell-is-invalid']!(p(null))).toBe(false)
  })

  it('cellClass carries the base class, the numeric alignment on number kinds, and the editable affordance', () => {
    const r = row()
    expect(call(def('syncQty').cellClass, { data: r })).toBe('nds-ag-cell nds-ag-num nds-cell-is-editable')
    expect(call(def('price').cellClass, { data: r })).toBe('nds-ag-cell nds-ag-num nds-cell-is-editable')
    expect(call(def('listing').cellClass, { data: r })).toBe('nds-ag-cell')
    expect(def('price').headerClass).toBe('nds-ag-head-num')
    expect(def('syncMode').headerClass).toBeUndefined()
    /* `nds-cell-is-locked` is never in cellClass — it is a rule, so it cannot be added-then-removed. */
    r.cells['AMAZON:IT']!.writable.syncQty = false
    expect(call(def('syncQty').cellClass, { data: r })).toBe('nds-ag-cell nds-ag-num')
  })

  it('formatter, quick-filter text and tooltip read the ONE text and the ONE tooltip; the comparator sorts', () => {
    const r = row()
    expect(fn(def('syncQty').valueFormatter)({ data: r, value: 403 } as never)).toBe('403')
    expect(fn(def('price').valueFormatter)({ data: r, value: 105 } as never)).toBe('€105.00')
    expect(call(def('price').getQuickFilterText, { data: r })).toBe('€105.00')
    expect(call(def('syncQty').tooltipValueGetter, { data: r })).toBe('Follows the pool · 403 available at IT-MAIN − 0 buffer')
    expect(call(def('salePrice').tooltipValueGetter, { data: r })).toBeUndefined()
    expect(fn(def('syncQty').comparator)(3, 10, undefined as never, undefined as never, false)).toBeLessThan(0)
    expect(fn(def('salePrice').comparator)({ value: 9, start: null, end: null }, { value: 5, start: null, end: null }, undefined as never, undefined as never, false)).toBeGreaterThan(0)
  })

  it('equals is structural, so an unchanged sale compound compares equal and a moved date does not', () => {
    const eq = def('salePrice').equals!
    expect(eq({ value: 89, start: '2026-09-12', end: null }, { value: 89, start: '2026-09-12', end: null })).toBe(true)
    expect(eq({ value: 89, start: '2026-09-12', end: null }, { value: 89, start: '2026-09-13', end: null })).toBe(false)
  })

  it('cellRendererParams is ONE stable object carrying kind, coordinate, facts and the two callbacks', () => {
    const onJump = vi.fn()
    const d = def('syncState', { onJump })
    const rp = d.cellRendererParams as { kind: string; coordinate: MatrixCoordinate; facts: (p: unknown) => unknown; onJump: unknown }
    expect(rp.kind).toBe('syncState')
    expect(rp.coordinate).toBe(COORD)
    expect(rp.onJump).toBe(onJump)
    expect(rp.facts({ data: row() })).toEqual(cellsOf())
    expect(d.cellRendererParams).toBe(d.cellRendererParams)
  })
})
