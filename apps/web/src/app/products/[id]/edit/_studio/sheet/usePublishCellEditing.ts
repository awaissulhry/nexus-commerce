'use client'

/**
 * The Status and Action cells of ONE listing on ONE destination, edited — the one implementation for every grid whose
 * publish cell is a single listing: a channel sheet (one Status and one Action column, P8) and the Matrix (the same
 * Status column once per market, Owner 2026-10-07: "use the same column, not a copy"). The Shared scope's product
 * cells fan out to every market of a product and keep their own wiring (`master/useMasterSheetAdapter.tsx`, P9).
 *
 * A cell edit, a fill, a paste, a reset (Delete / Backspace) or Action ▾ STAGES its cells in one fence
 * (`PublishActionFence`): they leave as one write per column and value (`groupStaged`), each cell marked saving, then
 * cleared or refused with the server's words, and ONE toast (`operationToast`). A choice that started new listings asks
 * the page to read its rows again (`onStarted`). Nothing here sends anything to a channel: Publish does.
 *
 * The page says where each listing's cell is (`places`) — read ONCE per operation, before the write: a write that starts
 * new listings changes their ids on the next read, and the marks stay on the cells the write was sent from.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PublishActionChange, PublishActionCell } from '@nexus/shared/publish-actions'
import { CellSaveTracker, publishActionModel, sellingStatusModel, waitingWhen } from '@/design-system/grid'
import type { Tone } from '@/design-system/primitives/tone'
import { ACTION_COLUMN, actionCellValue } from './channel/actionColumn'
import { STATUS_COLUMN, statusCellValue, type PublishCellReadState } from './channel/statusColumn'
import { isClearKey, selectedCells, type SelectionApi } from './sheetReset'
import {
  PublishActionFence, groupStaged, operationToast, withoutSameNewChoice,
  type PublishActionWriteOutcome, type PublishCellInput, type StagedPublishCell,
} from './usePublishActions'

type Column = PublishActionChange['column']
/** What the reset reads off the grid: its selection, and whether it is alive and not editing. */
type GridSelectionApi<Row> = SelectionApi<Row> & { isDestroyed(): boolean; getEditingCells(): unknown[] }

/** One publish cell on the grid: where it is, which column kind, its stored value, and the SKU that names it. */
export interface PublishCellPlace {
  /** The grid row id (AG's and the tracker's). */
  rowId: string
  /** The grid column id of this cell. */
  colId: string
  column: Column
  /** The cell's stored (and optimistic) value; null when the read holds none for it. */
  cell: PublishActionCell | null
  /** The listing's SKU on this destination, for the fence and the toast. */
  sku: string
}

/** Where the cells are NOW: a listing id (or a new row's `new:` id) to its grid row and column, and its name. */
export interface PublishCellPlaces {
  place: (listingId: string, column: Column) => { rowId: string; colId: string } | null
  label: (listingId: string) => string | null
}

export interface PublishCellEditingDeps {
  /** The live store's write (`usePublishActions(...).write`). */
  write: (change: PublishActionChange, listingIds: readonly string[]) => Promise<PublishActionWriteOutcome>
  places: () => PublishCellPlaces
  /** The read state the cells are drawn with (what the reset may clear). */
  read: () => PublishCellReadState
  /** Redraw these rows' publish cells (every row when absent). */
  repaint: (rowIds?: Iterable<string>) => void
  toast: (message: string, tone: Tone, options: { duration: number }) => void
  /** A choice started new listings: read the rows again (their real listing ids). */
  onStarted: () => void
}

export interface PublishCellEditing {
  tracker: CellSaveTracker
  /** Bracket a fill or a paste: its cells leave as one operation. */
  begin: () => void
  end: () => void
  /** A cell received a value: a refusal is marked at once; a change waits in the fence for the rest of its operation. */
  stage: (place: PublishCellPlace, received: PublishCellInput) => void
  /** Fill these cells with one change (Action ▾): one operation, so one write and one toast. */
  fill: (change: PublishActionChange, places: readonly PublishCellPlace[]) => void
  /**
   * Fill these cells with one change NOW and answer what the server did (the Matrix's bulk Edit, 2026-10-07): the same
   * marks, writes and refresh as `fill`; `quiet` leaves the toast out, because the caller says the result itself.
   */
  fillNow: (change: PublishActionChange, places: readonly PublishCellPlace[], options?: { quiet?: boolean }) => Promise<PublishFillResult>
  /**
   * Delete / Backspace on a publish cell: the selected publish cells go back to "no change" (Status) / Partial update
   * (Action). `isPublishColumn` says whether the key's own column is one; `placeOf` gives each selected cell's place, or
   * null for a cell that is not a publish cell. True when the key was handled.
   */
  onClearKey: <Row>(event: { event?: Event | null; column?: { getColId(): string } | null }, api: GridSelectionApi<Row> | null, rowIdOf: (row: Row) => string,
    isPublishColumn: (colId: string) => boolean, placeOf: (target: { rowId: string; colId: string; row: Row }) => PublishCellPlace | null) => boolean
}

/** What one fill did: the server's answer per write, and the cells refused before any write. */
export interface PublishFillResult {
  outcomes: PublishActionWriteOutcome[]
  refused: Array<{ column: Column; sku: string; reason: string }>
}

export function usePublishCellEditing(deps: PublishCellEditingDeps): PublishCellEditing {
  const live = useRef(deps)
  live.current = deps
  const [tracker] = useState(() => new CellSaveTracker())

  /** One operation's cells, sent: marks while it is on its way, the server's word per cell after, and ONE toast. */
  const flush = useRef<(items: StagedPublishCell[], options?: { quiet?: boolean }) => Promise<PublishFillResult>>(async () => ({ outcomes: [], refused: [] }))
  flush.current = async (items, options = {}) => {
    const { writes, refused } = groupStaged(items)
    const at = live.current.places()
    const touched: string[] = []
    for (const write of writes)
      for (const id of write.listingIds) {
        const place = at.place(id, write.change.column)
        if (place) { tracker.set(place.rowId, place.colId, 'saving'); touched.push(place.rowId) }
      }
    live.current.repaint(touched)
    const outcomes: PublishActionWriteOutcome[] = await Promise.all(writes.map((write) => live.current.write(write.change, write.listingIds)))
    for (const outcome of outcomes) {
      const mark = (listingId: string, reason: string | null) => {
        const place = at.place(listingId, outcome.change.column)
        if (!place) return
        if (reason) tracker.set(place.rowId, place.colId, 'refused', reason)
        else tracker.clear(place.rowId, place.colId)
      }
      if (!outcome.ok) { for (const id of outcome.requested) mark(id, outcome.error ?? 'The change could not be saved.'); continue }
      for (const id of outcome.applied) mark(id, null)
      for (const r of outcome.refused) mark(r.listingId, r.reason)
      for (const c of outcome.conflicts) mark(c.listingId, `${c.setByName ?? 'Someone else'} changed this first${c.setAt ? ` ${waitingWhen(c.setAt)}` : ''}. Nexus kept their value.`)
    }
    live.current.repaint(touched)
    // S11 follow-up — each listing named by the SKU it holds or sends here, never the product SKU in its place.
    const summary = operationToast(outcomes, refused, at.label)
    if (summary && !summary.quiet && !options.quiet) live.current.toast(summary.message, summary.tone, { duration: summary.tone === 'success' ? 5000 : 10000 })
    // New listings: a choice started the family's drafts — the page reads its rows again (their listing ids).
    if (outcomes.some((outcome) => outcome.started)) live.current.onStarted()
    return { outcomes, refused }
  }
  const [fence] = useState(() => new PublishActionFence((items) => { void flush.current(items) }))
  useEffect(() => () => fence.dispose(), [fence])

  const stage = useCallback((place: PublishCellPlace, received: PublishCellInput) => {
    // A new row's current choice again (a paste, a fill or Action ▾ of the same word): nothing to write.
    const input = withoutSameNewChoice(place.cell, received)
    if ('refused' in input) tracker.set(place.rowId, place.colId, 'refused', input.refused)
    else tracker.clear(place.rowId, place.colId)
    live.current.repaint([place.rowId])
    // Full update on a row not on the channel (it reads it already), or a new row's own choice again: nothing to set.
    if ('skip' in input) return
    // Only a listing this read knows can be written; any other cell is refused with the reason (the server would refuse
    // the whole write for one unknown id).
    fence.stage({ column: place.column, listingId: place.cell?.listingId ?? null, sku: place.sku, input })
  }, [fence, tracker])

  const fill = useCallback((change: PublishActionChange, places: readonly PublishCellPlace[]) => {
    fence.begin()
    try {
      for (const place of places) stage(place, { change })
    } finally {
      fence.end()
    }
  }, [fence, stage])

  const fillNow = useCallback(async (change: PublishActionChange, places: readonly PublishCellPlace[], options: { quiet?: boolean } = {}): Promise<PublishFillResult> => {
    const items: StagedPublishCell[] = []
    for (const place of places) {
      // A new row's current choice again: nothing to write (as `stage`).
      const input = withoutSameNewChoice(place.cell, { change })
      if ('skip' in input) continue
      tracker.clear(place.rowId, place.colId)
      items.push({ column: place.column, listingId: place.cell?.listingId ?? null, sku: place.sku, input })
    }
    return flush.current(items, options)
  }, [tracker])

  const onClearKey: PublishCellEditing['onClearKey'] = useCallback((event, api, rowIdOf, isPublishColumn, placeOf) => {
    const key = event.event as KeyboardEvent | null | undefined
    const colId = event.column?.getColId()
    if (!colId || !isPublishColumn(colId) || !isClearKey(key, false)) return false
    if (!api || api.isDestroyed() || api.getEditingCells().length > 0) return false
    key!.preventDefault()
    fence.begin()
    try {
      for (const target of selectedCells(api, rowIdOf)) {
        const place = placeOf(target)
        if (!place) continue
        const cell = place.cell
        if (place.column === 'status' && cell?.status.target && sellingStatusModel(statusCellValue(cell, live.current.read())).editable)
          stage(place, { change: { column: 'status', target: null } })
        // A row not on the channel reads Full update: nothing to reset (its Status says whether it goes out).
        if (place.column === 'send' && cell && !cell.create && cell.send.mode !== 'partial' && publishActionModel(actionCellValue(cell, live.current.read())).editable)
          stage(place, { change: { column: 'send', mode: 'partial' } })
      }
    } finally {
      fence.end()
    }
    return true
  }, [fence, stage])

  const begin = useCallback(() => fence.begin(), [fence])
  const end = useCallback(() => fence.end(), [fence])
  return { tracker, begin, end, stage, fill, fillNow, onClearKey }
}

/** A channel sheet's two publish column ids, by column kind. */
export const sheetPublishColumnOf = (column: Column): string => (column === 'send' ? ACTION_COLUMN : STATUS_COLUMN)
