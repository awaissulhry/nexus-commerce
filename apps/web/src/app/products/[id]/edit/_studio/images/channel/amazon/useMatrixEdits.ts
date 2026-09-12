'use client'

/**
 * PES.7 — committing a matrix edit.
 *
 * Writes go straight to the server. There is no Save button on this tab (layout §2.7), and each
 * write reports through the frame's `useSaveReporter()` so the studio header speaks for matrix
 * edits exactly as it does for sheet edits and master-gallery work.
 *
 * After a write the workspace is REFETCHED rather than patched optimistically. It costs a round
 * trip, and it is the honest choice: `bulk-save` resets `publishStatus` to DRAFT, clears
 * `publishError`, and assigns ids to created rows — a local guess would show a green publish tick
 * over bytes Amazon has not seen, which is the exact class of lie this tab is being rebuilt to
 * remove. Speed here is worth less than the screen being true.
 */
import { useCallback, useMemo, useState } from 'react'

import { apiSend, routes, type ApiResult } from '../../api'
import { writeSubject } from '../../imageWrites'
import type { ResolvedCell } from './cascade'
import { clearCell, moveImage, placeImage, type CellCoordinate } from './edits'

interface BulkSaveResult { saved: number; deleted: number; total: number }

export interface MatrixEdits {
  /** Non-null while a write is in flight — the matrix dims rather than accepting a second edit. */
  busy: boolean
  /** The last refusal, in the server's words or the rule's. Cleared on the next edit. */
  refusal: string | null
  dismissRefusal(): void
  place(at: CellCoordinate, url: string, resolved: ResolvedCell, sourceProductImageId?: string | null): Promise<void>
  clear(at: CellCoordinate, resolved: ResolvedCell): Promise<void>
  move(from: CellCoordinate, fromResolved: ResolvedCell, to: CellCoordinate, toResolved: ResolvedCell): Promise<void>
}

export function useMatrixEdits(args: {
  productId: string
  reload(): Promise<void>
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
}): MatrixEdits {
  const { productId, reload, write } = args
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  const commit = useCallback(async (body: { upserts?: unknown[]; deletes?: string[] }) => {
    setBusy(true)
    setRefusal(null)
    const res = await write(writeSubject.surface('amazon-matrix'), () => apiSend<BulkSaveResult>(
      routes.bulkSave(productId), 'POST', body))
    if (!res.ok) {
      setRefusal(res.message)
      setBusy(false)
      return
    }
    await reload()
    setBusy(false)
  }, [productId, reload, write])

  const place = useCallback(async (
    at: CellCoordinate, url: string, resolved: ResolvedCell, sourceProductImageId: string | null = null,
  ) => {
    await commit({ upserts: [placeImage({ at, url, resolved, sourceProductImageId })] })
  }, [commit])

  const clear = useCallback(async (at: CellCoordinate, resolved: ResolvedCell) => {
    const outcome = clearCell({ at, resolved })
    // A refusal is a RESULT, shown where the operator is looking — not a silent no-op.
    if (outcome.kind === 'refused') { setRefusal(outcome.reason); return }
    await commit({ deletes: [outcome.id] })
  }, [commit])

  const move = useCallback(async (
    from: CellCoordinate, fromResolved: ResolvedCell, to: CellCoordinate, toResolved: ResolvedCell,
  ) => {
    const plan = moveImage({ from, fromResolved, to, toResolved })
    if (!plan) { setRefusal('There is no picture in that slot to move.'); return }
    // One transaction: the route deletes before it upserts, so a move cannot leave the picture in
    // neither place if the request fails halfway.
    await commit({ upserts: [plan.upsert], ...(plan.deleteId ? { deletes: [plan.deleteId] } : {}) })
  }, [commit])

  // Stable on its own, so a consumer can depend on the callback rather than the whole object.
  const dismissRefusal = useCallback(() => setRefusal(null), [])

  // Memoised: a fresh object here breaks any consumer that correctly lists it as a
  // dependency — the memo never caches, and reads as though it does (PES ruling #156).
  return useMemo(
    () => ({ busy, refusal, dismissRefusal, place, clear, move }),
    [busy, refusal, dismissRefusal, place, clear, move],
  )
}
