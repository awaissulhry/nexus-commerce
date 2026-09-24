import { describe, expect, it } from 'vitest'
import { CellSaveTracker, FormulaCellEditor, textEditor } from '@/design-system/grid'
import { buildMasterColumns } from './master/columns'
import { buildChannelColumns, type BuildChannelColumnsOptions } from './master/channelColumns'
import type { SheetColumn } from './master/types'

/*
 * R-63 (A-42 step 1, 2026-09-24) — text and number open the ONE value editor on every studio surface: the formula-aware
 * value popup where a formula is available (#775), the SAME popup with formulas off everywhere else — a sheet built without
 * formula wiring (the Variants page) and a column or row the formula writer refuses. Never AG's inline editors.
 * BOTH builders are asserted, because two column builders drift when only one is checked.
 */
const AG_INLINE = ['agTextCellEditor', 'agNumberCellEditor']
const col = (key: string, kind: 'text' | 'number', extra: Record<string, unknown> = {}) =>
  ({ key, label: key, writeField: key, group: 'Details', defaultVisible: true, kind, storage: 'column', scope: 'global',
    requiredBy: [], editable: true, ...extra }) as unknown as SheetColumn

type Spec = { component: unknown; popup?: boolean; params?: { formulas?: boolean; commitKind?: string } }
const select = (def: unknown, eventKey: string | null = null, data: unknown = { id: 'p1', rowId: 'p1', values: {} }) =>
  (def as { cellEditorSelector: (p: unknown) => Spec }).cellEditorSelector({ data, eventKey })

describe('master builder (the Variants page builds it WITHOUT formula wiring)', () => {
  const defs = buildMasterColumns({ columns: [col('brand', 'text'), col('basePrice', 'number')], tracker: new CellSaveTracker(), locale: 'it' },
    { current: [] }) as Array<Record<string, unknown>>
  it.each([['brand', 'text'], ['basePrice', 'number']])('%s opens the value editor, formulas off (%s)', (key, kind) => {
    const def = defs.find(d => d.colId === key)!
    expect(def.cellEditor).toBe(FormulaCellEditor)
    expect(AG_INLINE).not.toContain(def.cellEditor)
    expect(def.cellEditorPopup).toBe(true)
    expect(def.cellEditorParams).toMatchObject({ formulas: false, commitKind: kind })
    expect(typeof def.suppressKeyboardEvent).toBe('function')
  })
})

describe('master builder WITH formula wiring', () => {
  const wiring = { exprFor: () => null, errorFor: () => null, candidatesFor: () => [], preview: async () => ({ ok: true }),
    functions: () => [], colIdOfRef: () => null, canEditRow: () => true }
  const defs = buildMasterColumns({ columns: [col('brand', 'text'), col('basePrice', 'number'), col('fixedCode', 'text', { formulaWritable: false })],
    tracker: new CellSaveTracker(), locale: 'it', formula: wiring as never }, { current: [] }) as Array<Record<string, unknown>>
  it('a column that can hold a formula opens the formula-aware value popup (formulas on)', () => {
    for (const key of ['brand', 'basePrice']) {
      const spec = select(defs.find(d => d.colId === key))
      expect(spec.component).toBe(FormulaCellEditor)
      expect(spec.params?.formulas).not.toBe(false)
    }
  })
  it('a column the formula writer refuses opens the SAME value editor, formulas off — not AG\'s inline one', () => {
    const spec = select(defs.find(d => d.colId === 'fixedCode'), '=')
    expect(spec.component).toBe(FormulaCellEditor)
    expect(spec.popup).toBe(true)
    expect(spec.params).toMatchObject({ formulas: false, commitKind: 'text' })
  })
})

describe('channel builder', () => {
  const setup = (columns: unknown[]) => buildChannelColumns({
    data: { scope: { channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT' } },
    gridColumns: columns, formulaWiring: { exprFor: () => null, errorFor: () => null },
    openCellDetails: () => {}, productLevelOnly: false, refusedReasonFor: () => null,
    tracker: new CellSaveTracker(), activeCellsRef: { current: null }, viewCtx: { locale: 'it', variationAxes: [], flaggedKeys: [] },
    mediaEditor: { open: () => {}, actions: {} }, shopifyEditor: { open: () => {} }, auth: { has: () => true },
  } as unknown as BuildChannelColumnsOptions) as unknown as Array<Record<string, unknown>>
  it.each([['brand', 'text'], ['item_weight_value', 'number']])('%s names the value editor, formulas off, as its column editor (%s)', (key, kind) => {
    const [def] = setup([col(key, kind as 'text' | 'number')])
    expect(def.cellEditor).toBe(FormulaCellEditor)
    expect(def.cellEditorParams).toMatchObject({ formulas: false, commitKind: kind })
  })
  it.each([['brand', 'text'], ['item_weight_value', 'number']])('%s, formula-refused, opens the value editor formulas off (%s)', (key, kind) => {
    const [def] = setup([col(key, kind as 'text' | 'number', { formulaWritable: false })])
    const spec = select(def, '=')
    expect(spec.component).toBe(FormulaCellEditor)
    expect(spec.params).toMatchObject({ formulas: false, commitKind: kind })
  })
})

describe('the DS textEditor() helper (the Variants page\'s channel projection)', () => {
  it('opens the value editor, formulas off — not agTextCellEditor', () => {
    const def = textEditor() as Record<string, unknown>
    expect(def.cellEditor).toBe(FormulaCellEditor)
    expect(def.cellEditorPopup).toBe(true)
    expect(def.cellEditorParams).toMatchObject({ formulas: false, commitKind: 'text' })
  })
})
