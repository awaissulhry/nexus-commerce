'use client'

/**
 * PES.4.10b — the moments that actually hold changes.
 *
 * Reads `GET /products/:id/restore-points` (PES.5, #366). It replaces a free `datetime-local`, and
 * the difference is not convenience — it is that the old control could not be answered honestly.
 *
 * An operator picking an arbitrary instant is asking "what did this look like at 14:32?", and the
 * true answer is almost always "exactly what it looked like at the last recorded change", because
 * nothing happened at 14:32. The input therefore invited a question whose answer was always a
 * different moment than the one asked for, and offered no way to know which moments were real. The
 * list IS the history: 23 points on a real product, 17 of them restorable.
 *
 * 🔴 `restorable: false` points are SHOWN and not clickable. Both alternatives lie: hiding them
 * omits real history — a moment that changed `attr_material` or `de.description` genuinely
 * happened — and enabling them promises a write `POST /restore` will not perform, since it accepts
 * master scalar columns only. The reason goes on the row itself, in text, because an instruction
 * that lives only on a disabled control cannot be read by the person who needs it.
 *
 * `restorableFields` comes from the same shared module the restore endpoint enforces
 * (`restorable-fields.ts`), so what this pane offers and what the endpoint honours cannot drift —
 * which is what `RESTORABLE_FIELDS` in `useRecordState` had to mirror by hand until now.
 */

import { useCallback, useMemo } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { studioFetch, useStudioRead, type StudioReadStatus } from './useStudioRead'

/** One recorded instant. Mirrors `RestorePoint` in `restore-points.service.ts`. */
export interface RestorePoint {
  /** ISO instant — what `POST /products/:id/restore` takes as `at`. */
  at: string
  action: string
  actor: string | null
  /** Every field recorded as changed at this instant. */
  fields: string[]
  /** The subset `POST /restore` will actually write. */
  restorableFields: string[]
  /** False when nothing at this instant can be written back. */
  restorable: boolean
  /**
   * WHICH restore this point needs (#482 §1.6 (H)), set by the service.
   *
   * 🔴 Never inferred from `action` here. A client parsing the action name would be reimplementing
   * the server's decision, and would silently pick `'master'` for any future formula action nobody
   * told it about — which is the failure this field exists to prevent.
   */
  restoreVia: 'master' | 'formula'
  /**
   * Present only on a `restoreVia: 'formula'` point (#488). The ONE audit row the restore acts on —
   * formula pins get their own bucket in the service, so unlike a master point this is never a
   * merge of several rows and `auditLogId` is unambiguous.
   *
   * `expr` is nullable: the confirm names the formula when it is known and says it cannot be read
   * when it is not, rather than showing an opaque id and calling it a formula.
   */
  formula?: { auditLogId: string; fieldKey: string; expr: string | null }
  layer: string | null
}

/**
 * 🔴 The coverage block is the honesty field, and it is rendered rather than logged.
 *
 * "No restore points" and "23 audit rows none of which record values" are different sentences, and
 * only the second explains itself. A product whose whole history is image-publish events yields 0
 * points legitimately — measured — and without this an operator reads that as "nothing ever
 * happened to this record".
 */
export interface RestorePointsCoverage {
  auditRowsScanned: number
  /** Rows excluded because they record an event, not values. */
  eventRowsExcluded: number
  /** Rows carrying neither a descriptor nor a map — nothing readable. */
  unreadableRowsExcluded: number
  note: string
}

export interface RestorePointsResult {
  productId: string
  points: RestorePoint[]
  coverage: RestorePointsCoverage
}

export interface RestorePointsState {
  status: StudioReadStatus
  points: RestorePoint[]
  coverage: RestorePointsCoverage | null
  error: string | null
  reload: () => void
}

/** Frozen — `?? []` in a return mints a new array every render (#166). */
const NO_POINTS: RestorePoint[] = Object.freeze([]) as unknown as RestorePoint[]

export function useRestorePoints(productId: string | null, enabled: boolean): RestorePointsState {
  const run = useCallback(
    async (signal: AbortSignal): Promise<RestorePointsResult> => {
      if (!productId) throw new Error('useRestorePoints: run called while disabled')
      const res = await studioFetch(`${getBackendUrl()}/api/products/${productId}/restore-points`, signal)
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      return (await res.json()) as RestorePointsResult
    },
    [productId],
  )

  const read = useStudioRead(run, enabled && Boolean(productId))

  return useMemo(
    () => ({
      status: read.status,
      points: read.data ? read.data.points : NO_POINTS,
      coverage: read.data ? read.data.coverage : null,
      error: read.error,
      reload: read.reload,
    }),
    [read],
  )
}

/**
 * Why a point cannot be restored — null when it can. One sentence, shown ON the row.
 *
 * Derived from what the SERVER said (`restorable`, `restorableFields`), never re-decided here: the
 * endpoint owns the allow-list and this pane must not develop a second opinion about it.
 */
export function notRestorablePointReason(point: RestorePoint): string | null {
  /**
   * A formula point is restorable through PES.6's path, and this pane now routes to it (#488), so
   * there is no refusal here any more. The guard that used to sit above this line existed because
   * the point carried no id: routing was impossible and offering it would have written a master
   * field that was never the thing pinned. `formula.auditLogId` closed that.
   *
   * A formula point WITHOUT the payload is still refused below — the server should not emit one,
   * and a missing id must not become a master-path write by falling through.
   */
  if (point.restoreVia === 'formula' && !point.formula) {
    return 'This formula pin is missing the record it would be restored from, so it cannot be re-applied.'
  }
  if (point.restorable) return null
  if (point.fields.length === 0) {
    return 'This moment records an event rather than field values, so there is nothing to write back.'
  }
  const shown = point.fields.slice(0, 3).join(', ')
  const more = point.fields.length > 3 ? ` and ${point.fields.length - 3} more` : ''
  return `Changed ${shown}${more} — restore covers the master record’s own scalar fields, so none of these can be written back.`
}
