/**
 * The FBA qty column on the product sheet (Owner 2026-10-07; the Amazon sheet only — eBay, Shopify and Etsy sell from the
 * pool): the Matrix page's locked column, spread over the sheet's own column. Amazon's units are SHOWN; nothing writes them.
 */
import { describe, expect, it } from 'vitest'

import { CellSaveTracker, LockedCell } from '@/design-system/grid'

import { fbaTooltip } from '../../matrix/columns'
import { MATRIX_COPY, type MatrixFbaStock } from '../../matrix/contract'
import { buildChannelColumns, type BuildChannelColumnsOptions } from '../master/channelColumns'
import { STOCK_FBA_KEY } from './stockCells'
import type { ChannelSheetRow, SheetColumn } from './types'

/** The column as the API serves it on the Amazon sheet (`studio-stock.ts` `fbaColumn` + `stockControlRouting`). */
const FBA: SheetColumn = {
  key: STOCK_FBA_KEY, writeField: STOCK_FBA_KEY, label: 'FBA qty', width: 96, group: 'Offer', groupKey: 'sheet:offer',
  kind: 'number', storage: 'listing', scope: 'per_variant', requiredBy: [], editable: false, defaultVisible: true, formulaWritable: false,
  helpText: MATRIX_COPY.fbaLocked,
} as SheetColumn

const AT_AMAZON: MatrixFbaStock = { units: 14, locations: [{ code: 'AMAZON-EU-FBA', units: 14 }], updatedAt: '2026-10-07T03:04:05.000Z' }
function row(fba: MatrixFbaStock | null | undefined, isParent = false): ChannelSheetRow {
  return {
    rowId: 'primary:v1', id: 'v1', parentId: isParent ? null : 'root', isParent, aliasId: null, listing: null,
    values: { [STOCK_FBA_KEY]: { value: fba?.units ?? null, editable: false, writable: false, writeBlockedReason: MATRIX_COPY.fbaLocked } },
    stock: { key: 'AMAZON:EU', marketKey: 'AMAZON:DE', cells: null, coordinate: null, ...(fba !== undefined ? { fba } : {}) },
  } as unknown as ChannelSheetRow
}

type Fn = (p: unknown) => unknown
const call = (def: object, key: string, p: unknown) => ((def as Record<string, Fn>)[key])(p)
function fbaDef() {
  const [def] = buildChannelColumns({
    data: { scope: { channel: 'AMAZON', marketplace: 'DE', label: 'Amazon · DE', connectionId: 'acc-1' } }, gridColumns: [FBA],
    formulaWiring: { exprFor: () => null, errorFor: () => null }, productLevelOnly: false, refusedReasonFor: () => null,
    tracker: new CellSaveTracker(), activeCellsRef: { current: null }, viewCtx: { locale: 'de', variationAxes: [], flaggedKeys: [] },
    mediaEditor: { open: () => {}, actions: {} }, shopifyEditor: { open: () => {} }, auth: { has: () => true },
  } as unknown as BuildChannelColumnsOptions) as unknown as Array<Record<string, unknown>>
  return def!
}

describe('the FBA qty column on the Amazon product sheet', () => {
  it('🔴 is locked in its DEFINITION once spread over the sheet\'s column: not editable, not movable, no fill, no paste, no editor, no setter', () => {
    const d = fbaDef()
    expect(d.colId).toBe(STOCK_FBA_KEY)
    expect(d.headerName).toBe('FBA qty')
    expect(d.editable).toBe(false)
    expect(d.suppressMovable).toBe(true)
    expect(d.suppressFillHandle).toBe(true)
    expect(d.suppressPaste).toBe(true)
    expect(d.cellEditorSelector).toBeUndefined()
    expect(d.valueParser).toBeUndefined()
    expect(d.field).toBeUndefined()
    // The sheet's own setter is replaced: a write reaching the column changes nothing.
    const data = row(AT_AMAZON)
    expect(call(d, 'valueSetter', { data, newValue: 99 })).toBe(false)
    expect(data.stock?.fba?.units).toBe(14)
    // The DS locked cell (value + lock glyph named with the reason) and the locked tint on every row.
    expect(d.cellRenderer).toBe(LockedCell)
    expect(d.cellRendererParams).toEqual({ kind: 'integer', reason: MATRIX_COPY.fbaLocked })
    for (const r of [row(AT_AMAZON), row(null), row(undefined)]) expect(call((d.cellClassRules as object), 'nds-cell-is-locked', { data: r })).toBe(true)
  })

  it('shows Amazon\'s units; a measured 0 is 0; no FBA row and not read are both empty, never 0', () => {
    const d = fbaDef()
    expect(call(d, 'valueGetter', { data: row(AT_AMAZON) })).toBe(14)
    expect(call(d, 'valueGetter', { data: row({ units: 0, locations: [], updatedAt: null }) })).toBe(0)
    expect(call(d, 'valueGetter', { data: row(null) })).toBeNull()
    expect(call(d, 'valueGetter', { data: row(undefined) })).toBeNull()
    expect(call(d, 'valueFormatter', { value: 0 })).toBe('0')
    expect(call(d, 'valueFormatter', { value: null })).toBe('')
  })

  it('the tooltip is the Matrix page\'s: how many, where, a parent\'s family total, and why it is locked', () => {
    const d = fbaDef()
    expect(call(d, 'tooltipValueGetter', { data: row(AT_AMAZON) })).toBe(fbaTooltip({ role: 'variant', fba: AT_AMAZON }))
    expect(call(d, 'tooltipValueGetter', { data: row(AT_AMAZON) })).toContain('14 units at Amazon (AMAZON-EU-FBA 14)')
    expect(call(d, 'tooltipValueGetter', { data: row(AT_AMAZON, true) })).toMatch(/^Family total: 14 units at Amazon/)
    expect(call(d, 'tooltipValueGetter', { data: row(null) })).toBe(`${MATRIX_COPY.fbaNone} · ${MATRIX_COPY.fbaLocked}`)
    expect(call(d, 'tooltipValueGetter', { data: row(undefined) })).toBe(`${MATRIX_COPY.fbaNotRead} · ${MATRIX_COPY.fbaLocked}`)
  })
})
