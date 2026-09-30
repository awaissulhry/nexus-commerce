'use client'

/**
 * P1 — full control on BOTH sheets (fix/product-sheet-editing; report 2 I-5, I-6; report 1 I-10):
 *
 *  - the cell menu offers "Reset to inherited" as a direct item (was: right-click → Cell details… → Remove listing
 *    override on a channel, nothing at all on Master), and a range offers "Reset selection to inherited";
 *  - a column's header menu offers "Set every row…" and "Reset column to inherited";
 *  - Delete asks once, "Clear" or "Reset to inherited", instead of silently storing a blank;
 *  - Shift+F10 (or the ContextMenu key) opens a focused cell's menu, so all of it works from the keyboard.
 *
 * Every write takes the existing roads: a reset is `writer.set(…, { intent })` (the intent the bulk-save path already
 * honours), a clear or a set is `setDataValue` through the grid (the typed-edit road: write gate, acknowledgement,
 * formula check) — each whole operation fenced into ONE save.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { useActionConfirm, type AgMenuItemDef, type ColDef, type ColGroupDef, type GetContextMenuItemsParams, type GridApi, type IRowNode, type SheetWriter } from '@/design-system/grid'
import { ClearOrResetDialog, SetColumnDialog, type ClearChoiceRequest, type SetColumnRequest } from './SheetControlDialogs'
import { clearChoiceCounts, deleteAsks, isClearKey, isMenuKey, resetTargets, selectedCells, withControlVerbs, type ClearChoice, type ResetOffer, type ResetTarget, type SetColumnFacts } from './sheetReset'

export interface SheetControlOptions<Row> {
  getGridApi: () => GridApi<Row> | null
  writer: SheetWriter<Row>
  /** Value writes as ONE undo step and ONE save — `useSheetUndo().operation`. */
  operation: (run: () => void) => void
  rowIdOf: (row: Row) => string
  skuOf: (row: Row) => string
  offerOf: (row: Row, colId: string) => ResetOffer | null
  /** The list a list position belongs to (its positions reset together), or null. */
  listOf?: (row: Row, colId: string) => string | null
  /** The columns these verbs act on: attribute columns, never identity, progress or media. */
  columnFacts: (colId: string) => SetColumnFacts | null
  /** A cleared cell here would hide an inherited value (every channel row; a variation on Master). */
  hidesInherited: (row: Row) => boolean
  /** Drop a cell's formula, keeping the value it last produced (`useCellFormulas().pinOver`). */
  removeFormula: (rowId: string, colId: string) => Promise<{ ok: boolean; error?: string }>
  /** One cell's reset from its menu, when the scope owns a review for it (a channel list). `true` = handled. */
  resetOne?: (row: Row, colId: string, offer: ResetOffer) => boolean
  /** A refusal said out loud (the sheet's toast). */
  say: (message: string) => void
}

type Cell<Row> = { rowId: string; colId: string; row: Row }

export function useSheetControl<Row>(options: SheetControlOptions<Row>) {
  const live = useRef(options)
  live.current = options
  const confirm = useActionConfirm()
  const [clearAsk, setClearAsk] = useState<(ClearChoiceRequest & { resolve: (choice: ClearChoice | null) => void }) | null>(null)
  const [setAsk, setSetAsk] = useState<(SetColumnRequest & { targets: IRowNode<Row>[] }) | null>(null)

  const rowOf = (rowId: string): Row | null => live.current.getGridApi()?.getRowNode(rowId)?.data ?? null
  const editable = (rowId: string, colId: string): boolean => {
    const api = live.current.getGridApi(), node = api?.getRowNode(rowId), column = api?.getColumn(colId)
    return !!node && !!column && column.isCellEditable(node)
  }
  const offer = (rowId: string, colId: string): ResetOffer | null => {
    const row = rowOf(rowId)
    return row && live.current.columnFacts(colId) ? live.current.offerOf(row, colId) : null
  }
  const listOf = (rowId: string, colId: string) => {
    const row = rowOf(rowId)
    return row ? live.current.listOf?.(row, colId) ?? null : null
  }
  const attributeCells = (cells: Cell<Row>[]) => cells.filter(c => !!live.current.columnFacts(c.colId))
  const subject = (cells: Array<{ colId: string }>) => {
    const columns = [...new Set(cells.map(c => c.colId))]
    const n = cells.length
    return columns.length === 1 ? `${n} ${n === 1 ? 'cell' : 'cells'} of ${live.current.columnFacts(columns[0])?.label ?? columns[0]}` : `${n} cells in ${columns.length} columns`
  }

  /** Resets as ONE save; formulas first (each keeps its last value, which the reset then removes). */
  const reset = useCallback(async (targets: ResetTarget[]) => {
    const { writer, removeFormula, say } = live.current
    const formulas = targets.filter(t => t.formula)
    const refused = (await Promise.all(formulas.map(async t => ({ t, r: await removeFormula(t.rowId, t.colId) })))).filter(x => !x.r.ok)
    if (refused.length) say(`${refused.length} formula ${refused.length === 1 ? 'cell was' : 'cells were'} not reset: ${refused[0].r.error ?? 'the formula could not be removed.'}`)
    const skip = new Set(refused.map(x => `${x.t.rowId}\u0000${x.t.colId}`))
    writer.beginOperation()
    try {
      for (const t of targets) {
        if (skip.has(`${t.rowId}\u0000${t.colId}`)) continue
        const row = rowOf(t.rowId)
        if (row) writer.set(t.rowId, t.colId, null, { row, intent: t.intent })
      }
    } finally {
      writer.endOperation()
    }
  }, [])

  /** A bulk reset says what it will do first: which cells, and that their own values go. */
  const confirmReset = useCallback(async (targets: ResetTarget[], title: string) => {
    if (!targets.length) return
    const { columnFacts, skuOf } = live.current
    const lines = targets.slice(0, 8).map(t => {
      const row = rowOf(t.rowId)
      return `${row ? skuOf(row) : t.rowId} · ${columnFacts(t.colId)?.label ?? t.colId}`
    })
    const more = targets.length > lines.length ? [`…and ${targets.length - lines.length} more`] : []
    const formulas = targets.filter(t => t.formula).length
    const ok = await confirm.ask({ level: 'confirm', title, consequences: [
      `${targets.length} ${targets.length === 1 ? 'cell drops its' : 'cells drop their'} own value and show the value they inherit again. One save.`,
      ...(formulas ? [`${formulas} ${formulas === 1 ? 'formula is' : 'formulas are'} removed first.`] : []),
      ...lines, ...more,
    ] })
    if (ok) await reset(targets)
  }, [confirm.ask, reset])

  /** The grid's own road for values: gate, acknowledgement and formula check per cell, ONE save for all. */
  const writeValues = useCallback((writes: Array<{ node: IRowNode<Row>; colId: string; value: unknown }>, source: string) => {
    if (!writes.length) return
    live.current.operation(() => { for (const w of writes) w.node.setDataValue(w.colId, w.value, source) })
  }, [])

  const clearOrReset = useCallback(async (cells: Cell<Row>[]) => {
    const api = live.current.getGridApi()
    if (!api) return
    const targets = attributeCells(cells)
    const counts = clearChoiceCounts(targets, editable, offer)
    const hides = targets.some(c => live.current.hidesInherited(c.row))
    let choice: ClearChoice | null = 'clear'
    if (deleteAsks(counts, hides)) choice = await new Promise<ClearChoice | null>(resolve => setClearAsk({ subject: subject(targets), ...counts, resolve }))
    setClearAsk(null)
    if (choice === 'reset') await reset(resetTargets(targets, offer, listOf))
    else if (choice === 'clear') writeValues(targets.filter(c => editable(c.rowId, c.colId)).flatMap(c => {
      const node = api.getRowNode(c.rowId)
      return node ? [{ node, colId: c.colId, value: null }] : []
    }), 'clear')
  }, [reset, writeValues])

  /** The rows a column verb acts on: every row shown (after filters), in order. */
  const shownRows = (api: GridApi<Row>) => {
    const nodes: IRowNode<Row>[] = []
    api.forEachNodeAfterFilterAndSort(node => { if (node.data && !node.rowPinned) nodes.push(node) })
    return nodes
  }

  const columnMenuItems = useCallback((colId: string): AgMenuItemDef<Row>[] => {
    const api = live.current.getGridApi(), facts = live.current.columnFacts(colId)
    if (!api || !facts) return []
    const rows = shownRows(api)
    const writable = rows.filter(node => editable(live.current.rowIdOf(node.data as Row), colId))
    const targets = resetTargets(rows.map(node => ({ rowId: live.current.rowIdOf(node.data as Row), colId })), offer, listOf)
    return [
      ...(facts.settable === false ? [] : [{ name: 'Set every row…', disabled: writable.length === 0, tooltip: writable.length ? undefined : `No row shown can be edited in ${facts.label}.`,
        action: () => setSetAsk({ column: facts, rows: writable.length, locked: rows.length - writable.length, targets: writable }) }]),
      { name: `Reset column to inherited (${targets.length})`, disabled: targets.length === 0,
        tooltip: targets.length ? undefined : `No row shown holds a ${facts.label} value of its own.`,
        action: () => { void confirmReset(targets, `Reset ${facts.label} to inherited on ${targets.length} ${targets.length === 1 ? 'row' : 'rows'}?`) } },
    ]
  }, [confirmReset])

  const applySetColumn = useCallback((raw: string | string[] | null) => {
    const request = setAsk
    setSetAsk(null)
    const api = live.current.getGridApi()
    if (!request || !api) return
    const column = api.getColumn(request.column.colId)
    const colDef = column?.getColDef() as ColDef<Row> | undefined
    const parse = typeof colDef?.valueParser === 'function' ? colDef.valueParser : null
    writeValues(request.targets.map(node => ({
      node, colId: request.column.colId,
      // The paste rule: the column's own parser reads the value (a label → its code, "2 kg" → a measure).
      value: raw === null || !parse ? raw : parse({ newValue: raw, oldValue: api.getCellValue({ rowNode: node, colKey: request.column.colId }), data: node.data, node, colDef: colDef!, column: column!, api, context: api.getGridOption('context') } as never),
    })), 'setColumn')
  }, [setAsk, writeValues])

  const cellMenuItems = useCallback((params: GetContextMenuItemsParams<Row>): AgMenuItemDef<Row>[] => {
    const row = params.node?.data, colId = params.column?.getColId()
    const { columnFacts, rowIdOf, resetOne } = live.current
    if (!row || !colId || !columnFacts(colId)) return []
    const cells = attributeCells(selectedCells(params.api, rowIdOf))
    const rowId = rowIdOf(row)
    if (cells.length > 1 && cells.some(c => c.rowId === rowId && c.colId === colId)) {
      const targets = resetTargets(cells, offer, listOf)
      return [{ name: `Reset selection to inherited (${targets.length})`, disabled: targets.length === 0,
        tooltip: targets.length ? undefined : 'No selected cell holds a value of its own.',
        action: () => { void confirmReset(targets, `Reset ${subject(targets)} to inherited?`) } }]
    }
    const own = offer(rowId, colId)
    if (!own) return [{ name: 'Reset to inherited', disabled: true, tooltip: 'This cell holds no value of its own: it already shows what it inherits, or nothing sits above it.' }]
    return [{ name: own.label, action: () => {
      if (resetOne?.(row, colId, own)) return
      void reset([{ rowId, colId, intent: own.intent, formula: own.formula }])
    } }]
  }, [reset, confirmReset])

  /** Delete / Backspace and the menu key on a cell. `true` = handled here (the column already kept AG off it). */
  const onKeyDown = useCallback((event: { event?: Event | null; node?: IRowNode<Row> | null; column?: { getColId(): string } | null; api?: GridApi<Row> }): boolean => {
    const key = event.event as KeyboardEvent | null | undefined
    const api = event.api ?? live.current.getGridApi()
    if (!key || !api || (api.getEditingCells().length ?? 0) > 0) return false
    const colId = event.column?.getColId()
    if (isMenuKey(key) && event.node && event.column) {
      key.preventDefault()
      api.showContextMenu({ rowNode: event.node, column: event.column as never, value: undefined, source: 'ui' })
      return true
    }
    if (isClearKey(key, false) && colId && live.current.columnFacts(colId)) {
      key.preventDefault()
      void clearOrReset(selectedCells(api, live.current.rowIdOf))
      return true
    }
    return false
  }, [clearOrReset])

  const columnMenuItemsRef = useRef(columnMenuItems)
  columnMenuItemsRef.current = columnMenuItems
  /**
   * Give each attribute column its header verbs and keep AG from clearing on Delete (the sheet asks instead). Called
   * inside the host's column memo: everything read here goes through refs, so the column model never rebuilds for it.
   */
  const decorate = useCallback(<D extends ColDef<Row> | ColGroupDef<Row>>(defs: D[]): D[] =>
    defs.map(def => withControlVerbs<Row, D>(def, colId => !!live.current.columnFacts(colId), colId => columnMenuItemsRef.current(colId))), [])

  const element = useMemo(() => <>
    <ClearOrResetDialog request={clearAsk} onChoose={choice => clearAsk?.resolve(choice)} />
    <SetColumnDialog request={setAsk} onApply={applySetColumn} onClose={() => setSetAsk(null)} />
    {confirm.element}
  </>, [clearAsk, setAsk, applySetColumn, confirm.element])

  return { cellMenuItems, columnMenuItems, onKeyDown, decorate, element, reset }
}
