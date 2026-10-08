/**
 * Amazon sheet gaps (gaps 4–5) — Mode / Qty / Buffer on the product sheet are the Matrix's own columns: the engine's
 * `matrixColumnDef` over the row's Matrix cells, editable only where the server AND the Matrix rule allow, with the
 * Matrix's words (FBA "Amazon-managed", `matrixQtyText`) and no formula editor — also once spread over the sheet's column.
 */
import { describe, expect, it } from 'vitest'

import { CellSaveTracker, matrixCellTooltip, matrixQtyText, SELECT_CELL_CLASS } from '@/design-system/grid'

import { MATRIX_COPY, type MatrixCells, type MatrixCoordinate } from '../../matrix/contract'
import { buildChannelColumns, type BuildChannelColumnsOptions } from '../master/channelColumns'
import { stockEditPending } from './stockCells'
import { sheetStockCoordinate, stockColumnDef } from './stockColumns'
import type { ChannelSheetRow, SheetColumn } from './types'

const EU: MatrixCoordinate = {
  ...sheetStockCoordinate({ channel: 'AMAZON', marketplace: 'DE', label: 'Amazon · DE' }),
  key: 'AMAZON:EU', kind: 'region-inventory', market: 'EU', label: 'Amazon EU · Inventory', sharedInventoryWith: ['IT', 'DE', 'FR'],
}

function cells(over: Partial<MatrixCells> = {}): MatrixCells {
  return {
    listingId: 'L-IT', version: 7, listing: null, fulfilment: null,
    sync: { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 12, held: 12, buffer: 2, poolAvailable: 14, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false },
    queue: null, price: null, sale: null,
    writable: { syncMode: true, syncQty: true, syncBuffer: true }, writeBlockedReason: {},
    ...over,
  }
}
const fba = () => cells({
  sync: { kind: 'FBA_EXCLUDED', via: null, mode: 'FOLLOW', intended: null, held: null, buffer: 0, poolAvailable: null, routedLocations: [], fbaAtAmazon: 31, oversold: false },
  writable: { syncMode: false, syncQty: false, syncBuffer: false },
  writeBlockedReason: { syncMode: MATRIX_COPY.amazonManaged, syncQty: MATRIX_COPY.amazonManaged, syncBuffer: MATRIX_COPY.amazonManaged },
})

const column = (key: 'stock_mode' | 'stock_qty' | 'stock_buffer', matrixCell: 'syncMode' | 'syncQty' | 'syncBuffer'): SheetColumn => ({
  key, writeField: key, label: { stock_mode: 'Mode', stock_qty: 'Qty', stock_buffer: 'Buffer' }[key], width: 88, group: 'Inventory', groupKey: 'master:inventory',
  kind: 'stockControl', storage: 'listing', scope: 'per_variant', requiredBy: [], editable: true, defaultVisible: true, formulaWritable: false,
  helpText: 'The quantity Nexus sends.', matrixCell,
})
const QTY = column('stock_qty', 'syncQty'), MODE = column('stock_mode', 'syncMode'), BUFFER = column('stock_buffer', 'syncBuffer')

function row(c: MatrixCells | null, serverWritable = true, reason: string | null = null): ChannelSheetRow {
  const v = { value: 12, editable: serverWritable, writable: serverWritable, writeBlockedReason: reason }
  return {
    rowId: 'primary:v1', id: 'v1', parentId: 'root', isParent: false, aliasId: null,
    listing: { id: 'L-DE', version: 3 },
    values: { stock_mode: { ...v }, stock_qty: { ...v }, stock_buffer: { ...v } },
    stock: { key: 'AMAZON:EU', marketKey: 'AMAZON:DE', cells: c, coordinate: EU },
  } as unknown as ChannelSheetRow
}

const scope = { channel: 'AMAZON' as const, marketplace: 'DE', label: 'Amazon · DE', connectionId: 'acc-1' }
type Fn = (p: unknown) => unknown
const call = (def: object, key: string, p: unknown) => ((def as Record<string, Fn>)[key])(p)

describe('stockColumnDef — the Matrix column, on the sheet\'s row', () => {
  it('editable only when the server says writable AND the Matrix rule (matrixCellEditable) says editable', () => {
    const tracker = new CellSaveTracker()
    const def = stockColumnDef(QTY, { tracker, scope })
    expect(call(def, 'editable', { data: row(cells()) })).toBe(true)
    expect(call(def, 'editable', { data: row(cells(), false, MATRIX_COPY.accountMismatch) })).toBe(false)
    expect(call(def, 'editable', { data: row(cells({ writable: { syncQty: false }, writeBlockedReason: { syncQty: 'Offer closed — reopen in Sync Control' } })) })).toBe(false)
    expect(call(def, 'editable', { data: row(null, false, MATRIX_COPY.noListingYet) })).toBe(false)
    expect(String(call(def, 'cellClass', { data: row(cells(), false, 'x') }))).not.toContain('nds-cell-is-editable')
    expect(String(call(def, 'cellClass', { data: row(cells()) }))).toContain('nds-cell-is-editable')
  })

  it('FBA reads as the Matrix reads it: the dash, "Amazon-managed" on the hover, locked, never editable', () => {
    const def = stockColumnDef(QTY, { tracker: new CellSaveTracker(), scope })
    const data = row(fba(), false, MATRIX_COPY.amazonManaged)
    expect(call(def, 'valueFormatter', { data })).toBe('—')
    expect(String(call(def, 'tooltipValueGetter', { data }))).toMatch(/^Amazon-managed · 31 at Amazon/)
    expect(call(def, 'editable', { data })).toBe(false)
    const rules = def.cellClassRules as Record<string, Fn>
    expect(rules['nds-cell-is-locked']({ data, colDef: { colId: 'stock_qty' } })).toBe(true)
  })

  it('the Qty text IS matrixQtyText (copy, export, filter and screen read one string)', () => {
    const def = stockColumnDef(QTY, { tracker: new CellSaveTracker(), scope })
    for (const c of [cells(), cells({ sync: { ...cells().sync!, kind: 'PINNED', mode: 'PINNED', intended: 4 } }), cells({ sync: { ...cells().sync!, kind: 'PAUSED', via: 'POLICY', intended: null, held: 6 } }), fba()]) {
      const data = row(c)
      expect(call(def, 'valueFormatter', { data })).toBe(matrixQtyText(c, MATRIX_COPY))
      expect(call(def, 'getQuickFilterText', { data })).toBe(matrixQtyText(c, MATRIX_COPY))
    }
  })

  it('the hover is the Matrix\'s, with the EU sentence of the ROW\'s coordinate; a refusal leads with its reason; a held row says the server\'s sentence', () => {
    const tracker = new CellSaveTracker()
    const def = stockColumnDef(QTY, { tracker, scope })
    const data = row(cells())
    /* The Matrix's cell words, then this sheet's own EU line (the Matrix says it once, in its EU group's label). */
    const matrix = `${matrixCellTooltip('syncQty', data.stock!.cells, EU, MATRIX_COPY)} · Shared by IT DE FR — one quantity per SKU on Amazon EU`
    expect(call(def, 'tooltipValueGetter', { data })).toBe(matrix)
    expect(matrixCellTooltip('syncQty', data.stock!.cells, EU, MATRIX_COPY)).not.toContain('Shared by')
    tracker.set('primary:v1', 'stock_qty', 'refused', 'Shared stock — this SKU sells from Moto Lender\'s stock')
    expect(call(def, 'tooltipValueGetter', { data })).toBe(`Shared stock — this SKU sells from Moto Lender's stock · ${matrix}`)
    tracker.clear('primary:v1', 'stock_qty')
    expect(call(def, 'tooltipValueGetter', { data: row(null, false, MATRIX_COPY.accountMismatch) })).toBe(MATRIX_COPY.accountMismatch)
  })

  it('the Matrix\'s labels, the server\'s widths and help; the typed value goes into a copy of the cells', () => {
    const def = stockColumnDef(QTY, { tracker: new CellSaveTracker(), scope })
    expect([def.colId, def.headerName, def.width, def.headerTooltip]).toEqual(['stock_qty', 'Qty', 88, 'The quantity Nexus sends.'])
    const data = row(cells())
    const stored = data.stock!.cells
    expect(call(def, 'valueSetter', { data, newValue: '9' })).toBe(true)
    expect(data.stock!.cells!.sync!.intended).toBe(9)
    expect(stored!.sync!.intended).toBe(12)
    expect(stockEditPending(data)).toBe(true)
    expect(call(def, 'valueSetter', { data, newValue: 'abc' })).toBe(false)
  })

  it('Mode is the Matrix\'s select, its chevron class only where editable; Buffer the number editor', () => {
    const mode = stockColumnDef(MODE, { tracker: new CellSaveTracker(), scope })
    expect((mode.cellEditorParams as { options: Array<{ value: string }> }).options.map((o) => o.value)).toEqual(['FOLLOW', 'PINNED'])
    const chevron = (mode.cellClassRules as Record<string, Fn>)[SELECT_CELL_CLASS]
    expect(chevron({ data: row(cells()) })).toBe(true)
    expect(chevron({ data: row(cells(), false, 'held') })).toBe(false)
    expect(stockColumnDef(BUFFER, { tracker: new CellSaveTracker(), scope }).cellEditor).toBe('agNumberCellEditor')
  })
})

describe('the sheet\'s column builder spreads the stock column LAST — no formula editor survives', () => {
  function build(columns: SheetColumn[]) {
    return buildChannelColumns({
      data: { scope }, gridColumns: columns, formulaWiring: { exprFor: () => null, errorFor: () => null },
      productLevelOnly: false, refusedReasonFor: () => null,
      tracker: new CellSaveTracker(), activeCellsRef: { current: null }, viewCtx: { locale: 'de', variationAxes: [], flaggedKeys: [] },
      mediaEditor: { open: () => {}, actions: {} }, shopifyEditor: { open: () => {} }, auth: { has: () => true },
    } as unknown as BuildChannelColumnsOptions)
  }
  it('Qty: the number editor, no selector, no scalar parser, the Matrix renderer and text', () => {
    const [qty] = build([QTY])
    expect(qty.cellEditorSelector).toBeUndefined()
    expect(qty.valueParser).toBeUndefined()
    expect(qty.suppressKeyboardEvent).toBeUndefined()
    expect(qty.cellEditor).toBe('agNumberCellEditor')
    const data = row(cells({ sync: { ...cells().sync!, kind: 'PINNED', mode: 'PINNED', intended: 4 } }))
    expect(call(qty, 'valueGetter', { data })).toBe(4)
    expect(call(qty, 'valueFormatter', { data })).toBe('4')
    expect(call(qty, 'editable', { data })).toBe(true)
    expect(call(qty, 'editable', { data: row(fba(), false, MATRIX_COPY.amazonManaged) })).toBe(false)
  })
})
