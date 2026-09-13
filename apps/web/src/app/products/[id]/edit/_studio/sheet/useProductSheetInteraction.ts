'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { gridSelection, useGridLifetime, type GridApi } from '@/design-system/grid'
import { useToast } from '@/design-system/components'
import { useStudioRecord } from '../contracts'
import { isRevealAnchor } from '../drawer'
import { productSheetRowKey, type ProductSheetRowIdentity } from './productSheetRows'

type CellEvent<Row> = { column?: unknown; data?: Row; event?: Event | null }

export function sheetEventColumn(column: unknown, acceptsString = false): string | undefined {
  if (typeof column === 'string') return acceptsString ? column : undefined
  const col = column as { getColId?: () => string } | null | undefined
  return typeof col?.getColId === 'function' ? col.getColId() : undefined
}

/** Selection, focus and editor gestures have one implementation across scopes. */
export function useProductSheetInteraction<Row extends ProductSheetRowIdentity>(scope: 'master' | 'channel') {
  const lifetime = useGridLifetime<GridApi<Row>>()
  const { toast } = useToast()
  const record = useStudioRecord()
  const live = useRef({ record, toast, scope })
  live.current = { record, toast, scope }
  const [selectedRows, setSelectedRows] = useState<Row[]>([])
  const [search, setSearch] = useState('')
  const [showRefusedOnly, setShowRefusedOnly] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const lastDataCell = useRef<string | null>(null)
  const refusalReason = useRef<(key: string, row: Row) => string | null>(() => null)
  const lastSaid = useRef({ text: '', at: 0 })
  /**
   * R-VT-15 — the ONE way a refusal sentence reaches the operator, used by both moments it can arrive.
   *
   * Two callers, one implementation and one de-duplication window: the write path announces the
   * server's sentence the instant the commit is refused (`danger` — it just happened), and
   * `explainRefusal` repeats it when the operator returns to a cell that is already marked (`info` —
   * it is a reminder, not news). Before this, only the second caller existed, so a refusal showed no
   * sentence at all until the operator double-clicked the red cell.
   *
   * The 2,500 ms window is what keeps a paste honest: twenty cells refused for the same reason are
   * one sentence, and two different reasons are two.
   */
  const sayRefusal = useCallback((reason: string, tone: 'info' | 'danger') => {
    const now = Date.now()
    if (reason === lastSaid.current.text && now - lastSaid.current.at < 2500) return false
    lastSaid.current = { text: reason, at: now }
    live.current.toast(reason, tone)
    return true
  }, [])
  /** One call per settled batch (the engine's `onRefused`), however many cells it names. */
  const announceRefusals = useCallback((refusals: ReadonlyArray<{ colId: string; reason?: string }>) => {
    // Distinct sentences only, in the order the server gave them. A cell refused without a sentence
    // says so rather than inventing one — the mark is already on the cell.
    const sentences = [...new Set(refusals.map(r => r.reason?.trim()).filter((r): r is string => !!r))]
    for (const sentence of sentences) sayRefusal(sentence, 'danger')
    return sentences.length
  }, [sayRefusal])
  const explainRefusal = useCallback((event: CellEvent<Row>) => {
    const key = sheetEventColumn(event.column)
    if (!key || !event.data) return false
    const reason = refusalReason.current(key, event.data)
    if (!reason) return false
    sayRefusal(reason, 'info')
    return true
  }, [sayRefusal])
  const onCellFocused = useCallback((event: CellEvent<Row>) => {
    // AG also emits bare IDs while it restores layout. The original channel sheet ignored
    // those events; treating them as user focus opens a different drawer field on reload.
    const key = sheetEventColumn(event.column, live.current.scope === 'master')
    if (isRevealAnchor(key)) lastDataCell.current = key ?? null
  }, [])
  const onCellDoubleClicked = useCallback((event: CellEvent<Row>) => { explainRefusal(event) }, [explainRefusal])
  const onCellKeyDown = useCallback((event: CellEvent<Row>) => {
    const key = event.event as KeyboardEvent | undefined
    if (!key || key.altKey || key.ctrlKey || key.metaKey) return
    const opens = key.key === 'Enter' || key.key === 'F2' || (key.key.length === 1 && key.key !== ' ')
    if (opens && explainRefusal(event)) return
    const column = sheetEventColumn(event.column)
    if (live.current.scope !== 'master' || key.key !== 'Enter' || key.shiftKey || !event.data || !['ag-Grid-AutoColumn', 'sku'].includes(column ?? '')) return
    key.preventDefault()
    live.current.record.open(productSheetRowKey(event.data), lastDataCell.current ?? undefined)
  }, [explainRefusal])
  const onSelectionChanged = useCallback(() => {
    const api = lifetime.getApi()
    setSelectedRows(live.current.scope === 'channel'
      ? api?.getSelectedRows() ?? []
      : api?.getSelectedNodes().flatMap(node => node.data ? [node.data] : []) ?? [])
  }, [lifetime.getApi])
  const clearSelection = useCallback(() => lifetime.getApi()?.deselectAll(), [lifetime.getApi])
  const rowSelection = useMemo(() => gridSelection<Row>(), [])
  return {
    apiRef: lifetime.apiRef, gridReady: lifetime.gridApi, getGridApi: lifetime.getApi,
    bindGridApi: lifetime.bind, releaseGrid: lifetime.onGridPreDestroyed,
    selectedRows, setSelectedRows, search, setSearch, showRefusedOnly, setShowRefusedOnly,
    lastSavedAt, setLastSavedAt, lastDataCell, refusalReason, onCellFocused,
    onCellDoubleClicked, onCellKeyDown, onSelectionChanged, clearSelection, rowSelection,
    announceRefusals,
  }
}
