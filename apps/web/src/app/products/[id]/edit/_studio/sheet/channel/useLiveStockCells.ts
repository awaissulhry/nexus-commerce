'use client'

/**
 * Amazon sheet gaps — the product sheet's live stock cells. When this family's listings change elsewhere (the Matrix
 * tab, another window, a background job), the one live rule (`listingValuesLive.ts`, through `useListingValuesLive`)
 * decides what the sheet re-reads:
 *
 *   stock  only Mode / Qty / Buffer / Sync moved, or stock moved: ONE Matrix read, laid over the stock and ASIN cells
 *          of the rows that changed, in place (`patchStockRows` + `refreshCells`). A row with an open editor or a save
 *          of its own in flight is left alone, and the sheet owes its quiet read for it;
 *   full   anything else (price, offer, fulfilment, ASIN fill, a settled publication): the sheet's quiet re-read (`owe`).
 *
 * `knownVersions` reads the rows at event time — and every version a stock write answered with — so the sheet's own
 * writes echo as `none`.
 */
import { useEffect, useMemo, useRef } from 'react'

import type { CellSaveTracker, GridApi } from '@/design-system/grid'

import type { MatrixRead } from '../../matrix/contract'
import { fetchMatrix, type MatrixSource } from '../../matrix/source'
import { useListingValuesLive } from '../../useListingValuesLive'
import { knownListingVersions, patchStockRows, stockEditPending, STOCK_COLUMN_KEYS, STOCK_REFRESH_COLUMNS, type StockPatchResult } from './stockCells'
import type { ChannelSheetRow } from './types'

export interface UseLiveStockCellsOptions {
  /** The family root (`ChannelScopePage.family.id`); `null` until the sheet has loaded — every event is ignored. */
  familyId: string | null
  /** The account the sheet reads with (`scope.connectionId`), so the Matrix read resolves the same listings. */
  accountId: string | null | undefined
  /** The grid's rows, read at event time. */
  rowsRef: { readonly current: readonly ChannelSheetRow[] }
  getGridApi: () => GridApi<ChannelSheetRow> | null
  /** The sheet's round-trip marks: a stock cell still saving is a save in flight. */
  tracker: CellSaveTracker
  /** The sheet's quiet re-read, taken when the sheet is idle (`followUp.owe(); followUp.settle()`). */
  owe: () => void
  /** `false` ignores every event. Default on. */
  enabled?: boolean
  /** Injectable for the node test. Defaults to `fetchMatrix`. */
  read?: (productId: string, opts: { accountId?: string | null }) => Promise<MatrixSource>
}

/** The listing versions the sheet holds, computed when the live rule asks — its own writes mutate rows without a render. */
export class LiveListingVersions implements ReadonlyMap<string, number> {
  constructor(private readonly rows: () => Iterable<ChannelSheetRow>) {}
  private get map(): Map<string, number> { return knownListingVersions(this.rows()) }
  get size(): number { return this.map.size }
  get(key: string): number | undefined { return this.map.get(key) }
  has(key: string): boolean { return this.map.has(key) }
  forEach(fn: (value: number, key: string, map: ReadonlyMap<string, number>) => void): void { this.map.forEach((v, k) => fn(v, k, this)) }
  entries(): MapIterator<[string, number]> { return this.map.entries() }
  keys(): MapIterator<string> { return this.map.keys() }
  values(): MapIterator<number> { return this.map.values() }
  [Symbol.iterator](): MapIterator<[string, number]> { return this.map[Symbol.iterator]() }
}

/** PURE — a row the live read must not touch now: an editor open on it, or a stock save of its own not settled. */
export function liveRowBusy(row: ChannelSheetRow, editingRowIds: ReadonlySet<string>, tracker: Pick<CellSaveTracker, 'get'>): boolean {
  if (editingRowIds.has(row.rowId) || stockEditPending(row)) return true
  return STOCK_COLUMN_KEYS.some((key) => {
    const state = tracker.get(row.rowId, key)?.state
    return state === 'saving' || state === 'waiting'
  })
}

/** PURE — lay a live Matrix read over the rows; `owe` = a row could not be placed now (busy, or another listing). */
export function applyLiveStockRead(rows: readonly ChannelSheetRow[], read: MatrixRead, busy: (row: ChannelSheetRow) => boolean): StockPatchResult & { owe: boolean } {
  const result = patchStockRows(rows, read, busy)
  return { ...result, owe: result.skipped.length > 0 || result.mismatched.length > 0 }
}

/** The rows an open editor sits on, by grid row id. */
function editingRowIds(api: GridApi<ChannelSheetRow> | null): Set<string> {
  const out = new Set<string>()
  if (!api || api.isDestroyed()) return out
  for (const cell of api.getEditingCells()) {
    const node = cell.rowPinned ? null : api.getDisplayedRowAtIndex(cell.rowIndex)
    if (node?.id) out.add(node.id)
  }
  return out
}

export function useLiveStockCells(opts: UseLiveStockCellsOptions): void {
  const ref = useRef(opts)
  ref.current = opts
  const versions = useMemo(() => new LiveListingVersions(() => ref.current.rowsRef.current), [])
  const members = new Set(opts.rowsRef.current.map((row) => row.id))

  const live = useMemo(() => {
    const state = { fetching: false, again: false, alive: true }
    const run = async (): Promise<void> => {
      if (state.fetching) { state.again = true; return }
      state.fetching = true
      const { familyId, accountId } = ref.current
      if (!familyId) { state.fetching = false; return }
      const got = await (ref.current.read ?? fetchMatrix)(familyId, { accountId: accountId ?? null }).catch(() => null)
      state.fetching = false
      const now = ref.current
      // Another family or account since the read left, or the sheet closed: its answer is not this sheet's.
      const stale = !state.alive || now.familyId !== familyId || (now.accountId ?? null) !== (accountId ?? null)
      if (!stale && got?.kind === 'live') {
        const api = now.getGridApi()
        const editing = editingRowIds(api)
        const result = applyLiveStockRead(now.rowsRef.current, got.read, (row) => liveRowBusy(row, editing, now.tracker))
        if (result.changed.length && api && !api.isDestroyed()) {
          const nodes = result.changed.flatMap((row) => { const node = api.getRowNode(row.rowId); return node ? [node] : [] })
          const columns = STOCK_REFRESH_COLUMNS.filter((key) => !!api.getColumn(key))
          if (nodes.length && columns.length) api.refreshCells({ rowNodes: nodes, columns, force: true })
        }
        if (result.owe) now.owe()
      }
      const more = state.again && !stale
      state.again = false
      if (more) void run()
    }
    return { state, run }
  }, [])
  useEffect(() => { live.state.alive = true; return () => { live.state.alive = false } }, [live])

  useListingValuesLive({
    familyId: opts.familyId,
    memberIds: members,
    knownVersions: versions,
    enabled: opts.enabled !== false && !!opts.familyId,
    onStock: () => { void live.run() },
    onFull: () => ref.current.owe(),
  })
}
