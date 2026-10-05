/**
 * CM-16 — a sync from Amazon never writes over an operator's edit that has not reached Amazon yet.
 *
 * The keyword/target list sync and the v1 export ingest overwrite local rows with what Amazon reports. While an
 * edit is queued (grace window, retries) Amazon still reports the OLD value, so writing it back made a saved edit
 * revert on screen and fed the engines the old value. Three checks, together:
 *
 *  1. A snapshot of every undelivered write, taken once before the sync's writes (`pendingWriteColumnsByEntity`):
 *     those columns are left out of the row's update.
 *  2. A row that changed after (or just before) that snapshot is asked again on its own, so an edit queued while
 *     the sync is running is held back too. `RECHECK_MARGIN_MS` covers the moment between an edit's local write
 *     and its queue row, and clock differences between the API and the sync's process.
 *  3. The update itself only lands if the row still has the `updatedAt` the sync read (the settings sync's guard),
 *     so an edit made between the sync's read and its write is never overwritten; the sync skips that row and the
 *     next run picks it up.
 *
 * Usually nothing is pending, so (1) is one query and (2) does not run.
 */
import { holdBackPendingFields } from '../ads-core/drift.js'
import { pendingWriteColumns, pendingWriteColumnsByEntity, type AdEntityType } from './ads-mutation.service.js'

export const RECHECK_MARGIN_MS = 10_000

export interface SyncHoldBack {
  /** `data` for row `id` (read with `updatedAt`), without the columns an undelivered write holds. */
  without<T extends Record<string, unknown>>(id: string, updatedAt: Date, data: T): Promise<T>
  /** Rows written without some columns because a write is on its way. */
  held: number
  /** Rows skipped because they changed between the sync's read and its write (count them with `raced++`). */
  raced: number
}

export async function syncHoldBack(entityType: AdEntityType): Promise<SyncHoldBack> {
  const since = new Date(Date.now() - RECHECK_MARGIN_MS)
  const snapshot = await pendingWriteColumnsByEntity(entityType)
  const hb: SyncHoldBack = {
    held: 0,
    raced: 0,
    async without(id, updatedAt, data) {
      let cols = snapshot.get(id)
      if (updatedAt > since) {
        const fresh = await pendingWriteColumns(entityType, id)
        if (fresh.size) cols = new Set([...(cols ?? []), ...fresh])
      }
      if (!cols?.size) return data
      hb.held++
      return holdBackPendingFields(data, cols) as typeof data
    },
  }
  return hb
}
