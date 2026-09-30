import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CellSaveTracker, SELECT_CLEAR_LABEL } from '@/design-system/grid'
import { buildMasterColumns } from './master/columns'
import { buildChannelColumns, type BuildChannelColumnsOptions } from './master/channelColumns'
import type { SheetColumn } from './master/types'

/**
 * Audit B16 (2026-09-30) — every list can be emptied from its own list, with ONE label. Boolean cells offered only Yes and
 * No on both sheets, so a Yes set by mistake (Amazon is_heat_sensitive) could be undone only with Delete and a question.
 * BOTH builders are asserted: two column builders drift when only one is checked.
 */
const yesNo = { key: 'is_heat_sensitive', label: 'Heat sensitive', writeField: 'is_heat_sensitive', group: 'Details', defaultVisible: true,
  kind: 'boolean', storage: 'column', scope: 'global', requiredBy: [], editable: true } as unknown as SheetColumn
type Spec = { params?: { emptyLabel?: string; fallback?: Spec } }
/** The list editor the cell opens (the formula-aware editor carries it as its `fallback`). */
const select = (def: unknown) => {
  const spec = (def as { cellEditorSelector: (p: unknown) => Spec }).cellEditorSelector({ data: { id: 'p1', rowId: 'p1', values: {} }, eventKey: null })
  return spec.params?.fallback ?? spec
}
const wiring = { exprFor: () => null, errorFor: () => null, candidatesFor: () => [], preview: async () => ({ ok: true }),
  functions: () => [], colIdOfRef: () => null, canEditRow: () => true }

describe('a yes/no cell offers Clear, on both sheets', () => {
  it('Master sheet without formulas (the Variants page)', () => {
    const [def] = buildMasterColumns({ columns: [yesNo], tracker: new CellSaveTracker(), locale: 'it' }, { current: [] }) as Array<Record<string, any>>
    expect(def.cellEditorParams.emptyLabel).toBe(SELECT_CLEAR_LABEL)
  })
  it('Master sheet with formulas', () => {
    const [def] = buildMasterColumns({ columns: [yesNo], tracker: new CellSaveTracker(), locale: 'it', formula: wiring as never }, { current: [] }) as Array<Record<string, any>>
    expect(select(def).params?.emptyLabel).toBe(SELECT_CLEAR_LABEL)
  })
  it('channel sheet', () => {
    const opts = { data: { scope: { channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT' } }, gridColumns: [yesNo],
      formulaWiring: wiring, openCellDetails: () => {}, productLevelOnly: false, refusedReasonFor: () => null, tracker: new CellSaveTracker(),
      activeCellsRef: { current: null }, viewCtx: { locale: 'it', variationAxes: [], flaggedKeys: [] }, mediaEditor: { open: () => {}, actions: {} },
      shopifyEditor: { open: () => {} }, auth: { has: () => true } } as unknown as BuildChannelColumnsOptions
    const [def] = buildChannelColumns(opts)
    expect(select(def).params?.emptyLabel).toBe(SELECT_CLEAR_LABEL)
  })
})

describe('one label for the empty row', () => {
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
  it('"Set every row…" says Clear, not Empty', () => {
    expect(source('./SheetControlDialogs.tsx')).toContain('emptyLabel={SELECT_CLEAR_LABEL}')
    expect(source('./SheetControlDialogs.tsx')).not.toContain('emptyLabel="Empty"')
  })
  it('a reference list says Clear, not Not set', () => {
    expect(source('./referenceOptions.ts')).not.toContain("label: 'Not set'")
  })
})
