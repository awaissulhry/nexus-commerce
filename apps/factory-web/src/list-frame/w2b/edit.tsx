'use client'

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ComponentType } from 'react'
import { CellSaveMark, CellSaveTracker, numericEditor, type CellSaveState, roundTripClassRules, SAVED_FADE_MS, selectEditor, type ColDef, type GridApi, type ICellRendererParams } from '@nexus/ui/grid'
import type { CellSaveMarkLabels } from '@nexus/ui/grid'
import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import { Input } from '@nexus/ui/primitives'
import type { BulkRefusal, BulkValue } from '@nexus/factory-domain/views/bulk/rules'
import type { ListToolsTransport } from '../tools/transport'
import { refusalKey, typedValue, valueProblemKey, type ListEdit, type ListEditField } from './model'

/**
 * Inline edit in the list's grid (B-W2b-13; PLT-166; design shell.lists sec:grid "Inline edit only for one simple
 * in-house field (planned date, priority, bin), autosaved per cell with CellSaveMark and a version check; paste a
 * range"). The grid edits in read-only mode (AG `readOnlyEdit`): it never changes the list's rows itself; each edit — a
 * typed cell, or every cell of a pasted range, gathered into one write — goes through the list's bulk target
 * (platform/views/bulk, the record's own command) with the version the row had, and the list puts the saved values in
 * its rows (`edit.onSaved`). Each cell says how its save went (the DS round trip: saving ↻ · waiting … · unknown ? with
 * the CellSaveMark, saved green then fading, refused red with the reason in its tooltip); the toolbar's SaveStatus says
 * it for the list ("Saving…", "All changes saved · 15:42", "2 not saved · Retry").
 */

type Translate = (key: string, params?: Record<string, string | number>) => string

interface EditRequest<T> {
  data?: T
  newValue?: unknown
  colDef: ColDef<T>
  column?: { getColId(): string }
}

export interface InlineEdit<T> {
  /** The cells edit in the grid (the list opted in, the person may, the tools are there). */
  readonly active: boolean
  /** The list's columns with the edit fields made editable, marked and explained. */
  columns(columns: ColDef<T>[]): ColDef<T>[]
  onCellEditRequest(event: EditRequest<T>): void
  /** The cell takes an edit (Enter edits it instead of opening the row). */
  editableFor(row: T, colId: string): boolean
  readonly status: SaveStatusState
  /** Some cell the server refused or never answered may be sent again (a value the field refused may not). */
  readonly retryable: boolean
  retry(): void
  /** One field of one row, outside the grid (the calendar's Move to …): true once saved. */
  save(row: T, field: string, value: BulkValue): Promise<boolean>
}

export interface InlineEditArgs<T> {
  readonly edit: ListEdit<T> | undefined
  readonly transport: ListToolsTransport | null
  readonly listKey: string | null
  readonly rowId: (row: T) => string
  readonly api: () => GridApi<T> | null
  readonly t: Translate
  readonly markLabels: CellSaveMarkLabels
}

const LIST_KEYS = new Set(['x', 'j', 'k', '/', '?'])
const key = (rowId: string, field: string) => `${rowId}::${field}`

/** The day editor of a date cell (composed: the DS registers no date cell editor): the browser's day picker. */
export function DateCellEditor<T>(props: { data?: T; valueOf?: (row: T) => BulkValue; label?: string; onValueChange?: (value: string | null) => void; stopEditing?: (cancel?: boolean) => void }) {
  const initial = props.data && props.valueOf ? props.valueOf(props.data) : null
  return (
    <Input
      size="xs"
      type="date"
      autoFocus
      aria-label={props.label}
      defaultValue={typeof initial === 'string' ? initial : ''}
      onChange={(event) => props.onValueChange?.(event.target.value || null)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          props.stopEditing?.()
        }
        if (event.key === 'Escape') props.stopEditing?.(true)
      }}
    />
  )
}

export function useInlineEdit<T>({ edit, transport, listKey, rowId, api, t, markLabels }: InlineEditArgs<T>): InlineEdit<T> {
  const tracker = useRef(new CellSaveTracker()).current
  // The marks this list set, mirrored for the SaveStatus (the tracker keeps its cells to itself).
  const marks = useRef(new Map<string, { state: CellSaveState; reason?: string }>())
  const mark = useCallback(
    (id: string, field: string, state: CellSaveState | null, reason?: string) => {
      if (state === null) {
        marks.current.delete(key(id, field))
        tracker.clear(id, field)
      } else {
        marks.current.set(key(id, field), { state, ...(reason ? { reason } : {}) })
        tracker.set(id, field, state, reason)
      }
    },
    [tracker],
  )
  // The tracker's changes re-draw the SaveStatus (the cells are refreshed by the grid).
  const version = useRef(0)
  const tick = useSyncExternalStore(
    useCallback(
      (onChange: () => void) =>
        tracker.subscribe(() => {
          version.current++
          onChange()
        }),
      [tracker],
    ),
    () => version.current,
    () => 0,
  )
  const savedAt = useRef<string | null>(null)
  const queue = useRef(new Map<string, { row: T; changes: Record<string, BulkValue> }>())
  const failed = useRef(new Map<string, { row: T; field: string; value: BulkValue }>())
  const versions = useRef(new Map<string, number>())
  const flight = useRef<Promise<void>>(Promise.resolve())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef({ edit, transport, listKey, rowId, t })
  latest.current = { edit, transport, listKey, rowId, t }
  const active = !!edit && edit.inline !== false && !edit.held && !!transport && !!listKey

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const refresh = useCallback(
    (ids: readonly string[]) => {
      const grid = api()
      if (!grid || grid.isDestroyed()) return
      const nodes = ids.map((id) => grid.getRowNode(id)).filter((node): node is NonNullable<typeof node> => !!node)
      if (nodes.length) grid.refreshCells({ rowNodes: nodes, force: true })
    },
    [api],
  )

  const refusalWords = useCallback((refusal: BulkRefusal) => latest.current.t(refusalKey(refusal)), [])

  const flush = useCallback(() => {
    timer.current = null
    const batch = [...queue.current.values()]
    queue.current.clear()
    if (batch.length === 0) return flight.current
    const run = async () => {
      const { edit: own, transport: seam, listKey: list, rowId: idOf, t: say } = latest.current
      if (!own || !seam || !list) return
      const rows = batch.map(({ row, changes }) => {
        const id = idOf(row)
        return { id, version: Math.max(own.versionOf(row), versions.current.get(id) ?? 0), changes }
      })
      for (const { id, changes } of rows) for (const field of Object.keys(changes)) mark(id, field, 'saving')
      refresh(rows.map((row) => row.id))
      try {
        const results = await seam.bulkApply({ listKey: list, rows }, seam.newKey())
        for (const result of results) {
          const asked = rows.find((row) => row.id === result.id)
          const source = batch.find(({ row }) => idOf(row) === result.id)
          if (!asked) continue
          for (const field of Object.keys(asked.changes)) {
            if (result.ok) {
              mark(result.id, field, 'saved')
              failed.current.delete(key(result.id, field))
            } else {
              mark(result.id, field, 'refused', refusalWords(result.refusal ?? { code: 'failed' }))
              if (source) failed.current.set(key(result.id, field), { row: source.row, field, value: asked.changes[field] ?? null })
            }
          }
          if (result.ok) {
            versions.current.set(result.id, result.version)
            savedAt.current = new Date().toISOString()
            own.onSaved(result.id, result.after, result.version)
          }
        }
      } catch {
        // No answer: it may or may not have been written (the DS's `unknown`, never "refused").
        for (const { row, changes } of batch) {
          const id = idOf(row)
          for (const field of Object.keys(changes)) {
            mark(id, field, 'unknown', say('edit.unknown'))
            failed.current.set(key(id, field), { row, field, value: changes[field] ?? null })
          }
        }
      }
      refresh(rows.map((row) => row.id))
      setTimeout(() => {
        for (const dropped of tracker.sweep()) marks.current.delete(dropped)
        refresh(rows.map((row) => row.id))
      }, SAVED_FADE_MS + 50)
    }
    flight.current = flight.current.then(run, run)
    return flight.current
  }, [tracker, mark, refresh, refusalWords])

  /** One field of one row into the next write (cells edited together — a pasted range — go in one write). */
  const enqueue = useCallback(
    (row: T, field: string, typed: unknown): boolean => {
      const { edit: own, rowId: idOf, t: say } = latest.current
      const spec = own?.fields[field]
      if (!own || !spec) return false
      const id = idOf(row)
      const held = spec.held?.(row) ?? null
      if (held) {
        mark(id, field, 'refused', held)
        refresh([id])
        return false
      }
      const value = typedValue(spec, typed)
      const problem = valueProblemKey(spec, value)
      if (problem) {
        mark(id, field, 'refused', say(problem, { min: spec.min ?? 0, max: spec.max ?? 0 }))
        refresh([id])
        return false
      }
      if (value === spec.valueOf(row)) return false
      const entry = queue.current.get(id) ?? { row, changes: {} }
      entry.changes[field] = value
      queue.current.set(id, entry)
      if (!timer.current) timer.current = setTimeout(() => void flush(), 0)
      return true
    },
    [mark, refresh, flush],
  )

  const onCellEditRequest = useCallback(
    (event: EditRequest<T>) => {
      const field = event.column?.getColId() ?? event.colDef.colId ?? (typeof event.colDef.field === 'string' ? event.colDef.field : null)
      if (!event.data || !field || !active) return
      enqueue(event.data, field, event.newValue)
    },
    [enqueue, active],
  )

  const retry = useCallback(() => {
    const again = [...failed.current.values()]
    failed.current.clear()
    for (const entry of again) {
      mark(latest.current.rowId(entry.row), entry.field, null)
      enqueue(entry.row, entry.field, entry.value)
    }
  }, [enqueue, mark])

  const save = useCallback(
    async (row: T, field: string, value: BulkValue) => {
      if (!enqueue(row, field, value)) return false
      await flush()
      return tracker.get(latest.current.rowId(row), field)?.state === 'saved'
    },
    [enqueue, flush, tracker],
  )

  const editableFor = useCallback((row: T, colId: string) => {
    const spec = latest.current.edit?.fields[colId]
    return active && !!spec && !spec.held?.(row)
  }, [active])

  // The columns change with the list's own columns, the fields it edits (by id and kind) and the words; the fields'
  // rules are read when a cell asks, so a list that builds its `edit` on every render keeps its grid as it is.
  const fieldsKey = edit ? Object.entries(edit.fields).map(([id, field]) => `${id}:${field.kind}`).join(',') : ''
  const columns = useCallback(
    (list: ColDef<T>[]): ColDef<T>[] => {
      const own = latest.current.edit
      if (!own || !active) return list
      const classRules = roundTripClassRules<T>(tracker, (row) => latest.current.rowId(row))
      return list.map((column) => {
        const colId = column.colId ?? (typeof column.field === 'string' ? column.field : null)
        const spec = colId ? own.fields[colId] : undefined
        if (!colId || !spec) return column
        return decorate(column, colId, spec, { tracker, classRules, rowId: (row) => latest.current.rowId(row), specOf: () => latest.current.edit?.fields[colId], markLabels, t: (k, p) => latest.current.t(k, p) })
      })
    },
    [fieldsKey, active, tracker, markLabels],
  )

  const status = useMemo<SaveStatusState>(() => {
    void tick
    let saving = 0
    let refused = 0
    let reason: string | null = null
    for (const entry of marks.current.values()) {
      if (entry.state === 'saving' || entry.state === 'waiting') saving++
      else if (entry.state === 'refused' || entry.state === 'unknown') {
        refused++
        reason = reason ?? entry.reason ?? null
      }
    }
    if (saving > 0) return { kind: 'saving' }
    if (refused > 0) return { kind: 'failed', count: refused, reason }
    return savedAt.current ? { kind: 'saved', at: savedAt.current } : { kind: 'idle' }
  }, [tick, tracker])

  // `tick` re-reads the ref after each mark.
  const retryable = useMemo(() => {
    void tick
    return failed.current.size > 0
  }, [tick])

  return { active, columns, onCellEditRequest, editableFor, status, retryable, retry, save }
}

interface DecorateTools<T> {
  /** The field's rules as the list gives them now. */
  specOf: () => ListEditField<T> | undefined
  tracker: CellSaveTracker
  classRules: NonNullable<ColDef<T>['cellClassRules']>
  rowId: (row: T) => string
  markLabels: CellSaveMarkLabels
  t: Translate
}

/** An edit field's column: editable where the row allows, its editor, its marks and their words. */
function decorate<T>(column: ColDef<T>, colId: string, spec: ListEditField<T>, tools: DecorateTools<T>): ColDef<T> {
  const editor: Partial<ColDef<T>> =
    spec.kind === 'integer'
      ? // No min / max for AG's editor: every typed number reaches the field's own check, which says why on the cell.
        (numericEditor({ min: Number.MIN_SAFE_INTEGER, step: 1, precision: 0 }) as Partial<ColDef<T>>)
      : spec.kind === 'choice'
        ? (selectEditor((spec.choices ?? []).map((value) => ({ value, label: spec.choiceLabels?.[value] ?? value }))) as Partial<ColDef<T>>)
        : spec.kind === 'date'
          ? { cellEditor: DateCellEditor as ComponentType, cellEditorParams: { valueOf: spec.valueOf, label: typeof column.headerName === 'string' ? column.headerName : colId } }
          : { cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: spec.maxLength } }
  const Original = column.cellRenderer as ComponentType<ICellRendererParams<T>> | string | undefined
  const Marked = (params: ICellRendererParams<T>) => {
    const state = params.data ? tools.tracker.get(tools.rowId(params.data), colId)?.state : undefined
    const inner = typeof Original === 'function' ? <Original {...params} /> : <span>{params.valueFormatted ?? (params.value === null || params.value === undefined ? '' : String(params.value))}</span>
    return (
      <span className="fw-list-edit-cell">
        {inner}
        <CellSaveMark state={state} labels={tools.markLabels} />
      </span>
    )
  }
  const ownTooltip = column.tooltipValueGetter
  const ownKeys = column.suppressKeyboardEvent
  return {
    ...column,
    ...editor,
    ...(column.field === undefined && column.valueGetter === undefined ? { valueGetter: (params: { data?: T }) => (params.data ? (tools.specOf() ?? spec).valueOf(params.data) : null) } : {}),
    editable: (params: { data?: T }) => !!params.data && !(tools.specOf() ?? spec).held?.(params.data),
    ...(typeof Original === 'string' ? {} : { cellRenderer: Marked }),
    cellClassRules: { ...(column.cellClassRules ?? {}), ...tools.classRules },
    tooltipValueGetter: (params: Parameters<NonNullable<ColDef<T>['tooltipValueGetter']>>[0]) => {
      const data = params.data as T | undefined
      if (data) {
        const entry = tools.tracker.get(tools.rowId(data), colId)
        if (entry?.reason) return entry.reason
        const held = (tools.specOf() ?? spec).held?.(data)
        if (held) return held
      }
      return ownTooltip ? ownTooltip(params) : tools.t('edit.cellHint')
    },
    // The list's keys (x j k / ?) stay the list's on an editable cell that is not being edited.
    suppressKeyboardEvent: (params) => {
      const event = params.event as KeyboardEvent
      if (!params.editing && LIST_KEYS.has(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) return true
      return ownKeys ? ownKeys(params) : false
    },
  }
}
