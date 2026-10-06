import { describe, expect, it } from 'vitest'

import { LockedCell } from '@/design-system/grid'

import { buildMatrixColumns, FBA_COL, fbaTooltip, fbaUnitsOf, STATUS_COL, STOCK_COL } from './columns'
import { MATRIX_COPY, type MatrixRowRead } from './contract'

/**
 * The FBA qty column (Owner 2026-10-06): the Matrix shows Amazon's FBA units next to Stock, and the column is LOCKED —
 * FBA quantity is Amazon's number and nothing in Nexus may write it (feedback_fba_quantity_untouchable).
 */
const row = (id: string, fba: MatrixRowRead['fba'], role: MatrixRowRead['role'] = 'variant'): MatrixRowRead => ({
  id, sku: id.toUpperCase(), role, stock: { available: 4, uncounted: false, locations: [] }, basePrice: 10, status: 'ACTIVE', cells: {},
  ...(fba === undefined ? {} : { fba }),
})
const ROWS: Record<string, MatrixRowRead> = {
  counted: row('counted', { units: 14, locations: [{ code: 'AMAZON-EU-FBA', units: 14 }], updatedAt: '2026-01-02T03:04:05.000Z' }),
  zero: row('zero', { units: 0, locations: [{ code: 'AMAZON-EU-FBA', units: 0 }], updatedAt: null }),
  none: row('none', null),
  unread: row('unread', undefined),
  parent: row('parent', { units: 20, locations: [{ code: 'AMAZON-EU-FBA', units: 20 }], updatedAt: null }, 'parent'),
}

type Def = Record<string, unknown>
function shared(): Def[] {
  const defs = buildMatrixColumns({
    coordinates: [], cellsOf: () => null, rowOf: (id: string) => ROWS[id] ?? null, tracker: null, sheetColumns: [], locale: 'it', market: 'IT',
    axesRef: { current: [] }, rowMenuRef: { current: () => [] }, masterHeldReason: null, onJump: () => undefined, onPickFulfilment: () => undefined, rowsRef: { current: [] },
  } as never) as Def[]
  return (defs.find((g) => g.groupId === 'grp-shared')!.children as Def[])
}
const fbaDef = () => shared().find((d) => d.colId === FBA_COL)!
const call = <T,>(fn: unknown, params: unknown): T => (fn as (p: unknown) => T)(params)

describe('the FBA qty column on the Matrix', () => {
  it('sits in the Shared group right after Stock, headed "FBA qty"', () => {
    expect(shared().map((d) => d.colId)).toEqual(['basePrice', STOCK_COL, FBA_COL, STATUS_COL])
    expect(fbaDef().headerName).toBe('FBA qty')
  })

  it('🔴 is locked in its DEFINITION: not editable, not movable, no fill handle, no paste, no editor, no setter', () => {
    const d = fbaDef()
    expect(d.editable).toBe(false)
    expect(d.suppressMovable).toBe(true)
    expect(d.suppressFillHandle).toBe(true)
    expect(d.suppressPaste).toBe(true)
    expect(d.cellEditor).toBeUndefined()
    expect(d.cellEditorSelector).toBeUndefined()
    expect(d.valueSetter).toBeUndefined()
    expect(d.field).toBeUndefined()
    // The DS locked cell (value + lock glyph named with the reason) and the locked tint on every row.
    expect(d.cellRenderer).toBe(LockedCell)
    expect(d.cellRendererParams).toEqual({ kind: 'integer', reason: MATRIX_COPY.fbaLocked })
    for (const id of Object.keys(ROWS)) expect(call<boolean>((d.cellClassRules as Record<string, unknown>)['nds-cell-is-locked'], { data: { id } })).toBe(true)
  })

  it('shows the units Nexus mirrors; a measured 0 is 0; no FBA row and not read are both "—", never 0', () => {
    const d = fbaDef()
    const value = (id: string) => call<number | null>(d.valueGetter, { data: { id } })
    expect(value('counted')).toBe(14)
    expect(value('zero')).toBe(0)
    expect(value('none')).toBeNull()
    expect(value('unread')).toBeNull()
    expect(value('parent')).toBe(20)
    // Copy, export and sort read the same number; an empty cell copies as nothing, not 0.
    expect(call<string>(d.valueFormatter, { value: 0 })).toBe('0')
    expect(call<string>(d.valueFormatter, { value: null })).toBe('')
    expect(fbaUnitsOf(ROWS.unread)).toBeNull()
  })

  it('the tooltip says how many, where, when, and — on every row — why it is locked; the three empties say different things', () => {
    const counted = fbaTooltip(ROWS.counted)
    expect(counted).toContain('14 units at Amazon (AMAZON-EU-FBA 14)')
    expect(counted).toContain('Last updated in Nexus')
    expect(fbaTooltip(ROWS.zero)).toBe(`0 units at Amazon (AMAZON-EU-FBA 0) · ${MATRIX_COPY.fbaLocked}`)
    expect(fbaTooltip(ROWS.parent)).toMatch(/^Family total: 20 units at Amazon/)
    expect(fbaTooltip(ROWS.none)).toBe(`${MATRIX_COPY.fbaNone} · ${MATRIX_COPY.fbaLocked}`)
    expect(fbaTooltip(ROWS.unread)).toBe(`${MATRIX_COPY.fbaNotRead} · ${MATRIX_COPY.fbaLocked}`)
    for (const r of Object.values(ROWS)) expect(fbaTooltip(r)).toContain(MATRIX_COPY.fbaLocked)
    expect(call<string>(fbaDef().tooltipValueGetter, { data: { id: 'counted' } })).toBe(counted)
  })
})
