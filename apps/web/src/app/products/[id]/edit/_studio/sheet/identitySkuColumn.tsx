'use client'

/**
 * S11 — the first column's SKU as a grid column, the same in both scopes of the product sheet (plan
 * docs/sheet-ids-sku-rows/PLAN.md, step S11). The RULES are `identitySkuEdit.ts` (pure, tested); this file is the wiring:
 * the tree column's editor, keys, marks and save marks, and the one road an edit takes to the sheet's own writer.
 *
 * What a host does (both adapters): spread `columnDef` into its `autoGroupColumnDef` (the tree look — chevrons, indent,
 * role chips — stays the host's renderer), draw `node(row)` as the band's SKU, and call `onValueChanged(e)` first in its
 * `onCellValueChanged`. Everything else is here:
 *   - the DS value editor (formulas off) with the SKU cap's counter and the warning line (`CellEditorContext.notice`);
 *   - keys: F2, typing or a double-click edits; Enter edits in a channel scope and opens the record in the Shared scope
 *     (`useProductSheetInteraction`), Esc cancels; Delete and Backspace never clear a SKU; no fill handle;
 *   - the save marks and the "differs from Shared" mark + tint (the sheet's existing members — `pinned`, `attention`);
 *   - a value the client check refuses never leaves: the cell says why (the sheet's refused mark and its toast);
 *   - a save the SERVER refuses shows its sentence on the cell (the writer's refused path) and the value goes back;
 *   - ⌘Z through the sheet's own history and writer (`useSheetUndo`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  CellSaveMark, CellSaveReason, MarkedValue, SkuTag, composeCellTooltip, provenanceClassRules, roundTripClassRules, saveNote,
  scalarValueEditorSpec, suppressFormulaKeys,
  type CellSaveEntry, type CellSaveTracker, type ColDef, type GridApi, type SheetWriter, type ValueSetterParams,
} from '@/design-system/grid'
import {
  IDENTITY_SKU_COLUMN, IdentitySkuEdits, SKU_MAX_LENGTH, applyIdentitySku, identitySkuEditability, identitySkuHover, identitySkuIntent, identitySkuMark,
  identitySkuNotice, identitySkuRefusal, identitySkuShown, identitySkuSnapshot,
  type IdentitySkuIntent, type IdentitySkuRow, type IdentitySkuScope, type IdentitySkuSnapshot,
} from './identitySkuEdit'
import type { SheetCellChange } from './sheetUndo'

type KeyParams = Parameters<typeof suppressFormulaKeys>[0]

/**
 * The first column's keys. Not editing: Delete and Backspace are kept from AG (a SKU is never cleared by a key — type,
 * F2 or double-click to edit it), and in the Shared scope a plain Enter too, so the sheet opens the record panel on it
 * (`useProductSheetInteraction`). Everything else is the value editor's (`suppressFormulaKeys`: Enter and Esc belong to
 * the open editor; a typed character opens it).
 */
export function suppressIdentitySkuKeys(params: KeyParams, enterOpensRecord: boolean): boolean {
  const { event, editing } = params
  if (!editing) {
    if (event.key === 'Delete' || event.key === 'Backspace') return true
    if (enterOpensRecord && event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) return true
  }
  return suppressFormulaKeys(params)
}

export interface IdentitySkuColumnDefOptions<Row extends IdentitySkuRow> {
  /** Read at call time: the scope can change under a column built once. */
  scope: () => IdentitySkuScope
  tracker: CellSaveTracker
  rowIdOf: (row: Row) => string
  /**
   * The setter's half of an edit, called BEFORE the row shows the new SKU: what the value means, and the row as it was.
   * A `refused` or `create` intent is never applied to the row (the setter reports no change).
   */
  onSet?: (row: Row, intent: IdentitySkuIntent, before: IdentitySkuSnapshot) => void
}

/** The first column's grid half — spread into the tree column (`autoGroupColumnDef`). Pure of React; tested with the editors. */
export function identitySkuColumnDef<Row extends IdentitySkuRow>(opts: IdentitySkuColumnDefOptions<Row>) {
  const editability = (row: Row | undefined) => (row ? identitySkuEditability(opts.scope(), row) : { editable: false, reason: null })
  const read = (row: Row) => identitySkuMark(opts.scope(), row).member
  return {
    editable: (p: { data?: Row }) => editability(p.data).editable,
    valueGetter: (p: { data?: Row }) => (p.data ? identitySkuShown(opts.scope(), p.data) : null),
    // 🔴 The row is MUTATED here: AG reads the value back from the row the moment this returns
    // (reference_ag_value_setter_must_mutate_params_data).
    valueSetter: (p: ValueSetterParams<Row>) => {
      const row = p.data
      if (!row) return false
      const scope = opts.scope()
      const intent = identitySkuIntent(scope, row, p.newValue)
      if (intent.kind === 'unchanged') return false
      opts.onSet?.(row, intent, identitySkuSnapshot(row))
      if (intent.kind === 'refused' || intent.kind === 'create') return false
      applyIdentitySku(scope, row, intent)
      return true
    },
    /* The ONE value editor (formulas off) with the SKU cap's counter and the line saying what this SKU change reaches —
       led by this cell's last refusal, in full, when the person tries again (F3 / F8: the band cannot print it whole). */
    cellEditorSelector: (p: { data?: Row }) => {
      const spec = scalarValueEditorSpec('text')
      const refusal = p.data ? identitySkuRefusal(p.data, opts.tracker.get(opts.rowIdOf(p.data), IDENTITY_SKU_COLUMN)) : null
      return { ...spec, params: { ...spec.params, cellContext: { maxLength: SKU_MAX_LENGTH, notice: p.data ? identitySkuNotice(opts.scope(), p.data, refusal) : null } } }
    },
    suppressKeyboardEvent: (params: KeyParams) => suppressIdentitySkuKeys(params, opts.scope().kind === 'shared'),
    // One SKU names one product: a fill would copy one SKU onto many rows.
    suppressFillHandle: true,
    cellClassRules: { ...roundTripClassRules<Row>(opts.tracker, opts.rowIdOf), ...provenanceClassRules<Row>(read) },
    /* The save's sentence (a refusal, an unconfirmed save), and why the cell cannot be edited. The mark's own sentence is
       its hover (`ProvenanceMark`), as on every sheet cell. */
    tooltipValueGetter: (p: { data?: Row }) => {
      if (!p.data) return ''
      const { editable, reason } = editability(p.data)
      return composeCellTooltip(saveNote(opts.tracker.get(opts.rowIdOf(p.data), IDENTITY_SKU_COLUMN)), editable ? null : reason)
    },
  } satisfies Partial<ColDef<Row>>
}

/** The SKU as the band draws it: its mark (the "differs from Shared" warning), the text, and the save marks. */
export function identitySkuNode(scope: IdentitySkuScope, row: IdentitySkuRow, save: CellSaveEntry | undefined): ReactNode {
  const shown = identitySkuShown(scope, row)
  const text = scope.kind === 'channel' ? <SkuTag>{shown}</SkuTag> : shown
  const mark = identitySkuMark(scope, row)
  if (mark.member === 'own' && !save) return text
  return (
    <MarkedValue provenance={mark.member} tooltip={mark.sentence ?? undefined}
      after={save ? <><CellSaveReason reason={saveNote(save)} /><CellSaveMark state={save.state} /></> : undefined}>
      {text}
    </MarkedValue>
  )
}

export interface IdentitySkuColumnOptions<Row extends IdentitySkuRow> {
  scope: IdentitySkuScope
  tracker: CellSaveTracker
  writer: SheetWriter<Row>
  getGridApi: () => GridApi<Row> | null | undefined
  rowIdOf: (row: Row) => string
  /** The sheet's undo history (`useSheetUndo().record`). */
  recordUndo: (change: SheetCellChange, source?: string) => void
  /** Says a refusal the moment it happens (`useProductSheetInteraction().announceRefusals`). */
  announce: (refusals: ReadonlyArray<{ colId: string; reason?: string }>) => unknown
  /** Add rows: an unsaved row's typed SKU (`newRows.store.type`). Absent = such a SKU is refused (`CREATE_NOT_READY`). */
  onCreate?: (row: Row, sku: string) => void
}

/** The first column, wired to the host's writer, tracker and undo (the bookkeeping is `IdentitySkuEdits`). */
export function useIdentitySkuColumn<Row extends IdentitySkuRow>(options: IdentitySkuColumnOptions<Row>) {
  const live = useRef(options)
  live.current = options
  const { tracker } = options
  const [edits] = useState(() => new IdentitySkuEdits<Row>({
    scope: () => live.current.scope,
    rowIdOf: (row) => live.current.rowIdOf(row),
    tracker,
    write: (rowId, value, row, intent) => live.current.writer.set(rowId, IDENTITY_SKU_COLUMN, value, { row, intent }),
    recordUndo: (change, source) => live.current.recordUndo(change, source),
    announce: (refusals) => live.current.announce(refusals),
    create: (row, sku) => {
      const onCreate = live.current.onCreate
      if (!onCreate) return false
      onCreate(row, sku)
      return true
    },
    // After the current turn: the grid repaints the cell when the edit ends, and the writer when the save settles.
    repaint: (row) => setTimeout(() => {
      const api = live.current.getGridApi()
      if (!api || api.isDestroyed()) return
      const node = api.getRowNode(live.current.rowIdOf(row))
      if (node) api.refreshCells({ rowNodes: [node], columns: [IDENTITY_SKU_COLUMN], force: true })
    }, 0),
  }))
  useEffect(() => tracker.subscribe(() => edits.trackerChanged()), [tracker, edits])

  const columnDef = useMemo(() => identitySkuColumnDef<Row>({
    scope: () => live.current.scope,
    tracker,
    rowIdOf: (row) => live.current.rowIdOf(row),
    onSet: (row, intent, before) => edits.setterSaw(row, intent, before),
  }), [tracker, edits])

  /** The host's `onCellValueChanged` calls this first: true = the first column's change, handled here. */
  const onValueChanged = useCallback((e: { data?: Row; colDef: { colId?: string }; source?: string }): boolean => edits.changed(e), [edits])
  /** The band's SKU node for this row (read at paint time). */
  const node = useCallback((row: Row) => identitySkuNode(live.current.scope, row, live.current.tracker.get(live.current.rowIdOf(row), IDENTITY_SKU_COLUMN)), [])
  /** Why this row's first column cannot be edited (`refusalReason`), or null. */
  const refusal = useCallback((row: Row) => identitySkuEditability(live.current.scope, row).reason, [])
  /**
   * F3 (browser check 2026-10-05) — the band's hover for this row (`IdentityBand title`): this cell's last refusal FIRST,
   * then the band's own sentence (`own`), so the band's sentence never covers a refusal; unchanged on every other row.
   */
  const hover = useCallback((row: Row, own?: string | null) => identitySkuHover(
    identitySkuRefusal(row, live.current.tracker.get(live.current.rowIdOf(row), IDENTITY_SKU_COLUMN)), own), [])

  return { columnDef, onValueChanged, node, refusal, hover }
}
