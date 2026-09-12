'use client'

/**
 * PES.4.10 — the record as it stood at a point in time.
 *
 * Reads `GET /api/products/:id/state?at=<ISO>` (ES.5), which reconstructs the product by walking
 * AuditLog `before` snapshots and ProductEvent deltas BACKWARDS from the current row. Two things
 * about that are worth stating, because they decide how this pane must behave:
 *
 * 1. **The server already grades every field** — `unchanged | reconstructed | uncertain` — and
 *    already authors `warnings[]` (the uncertain-field list, and a caveat when a flat-file import
 *    landed after the chosen time). Both are rendered VERBATIM. The old Snapshot modal derived its
 *    own tags client-side, which is how they became a guess; this does not repeat that.
 *
 * 2. **A reconstruction is not a snapshot.** Nothing stored the record as it was; this is inferred
 *    from what was recorded about the changes since. `uncertain` is the server admitting the
 *    inference failed for a field — and those fields are EXCLUDED from restore entirely
 *    (Owner, 2026-09-01), not merely defaulted off.
 */

import { useCallback, useMemo, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { studioFetch, useStudioRead, type StudioReadStatus } from './useStudioRead'

export type FieldCoverage = 'unchanged' | 'reconstructed' | 'uncertain'

export interface RecordStateResponse {
  state: Record<string, unknown>
  /**
   * The record NOW, in the same keyspace as `state`, fetched alongside it.
   *
   * Not optional cleverness — without it there is nothing true to diff against. The drawer's row
   * comes from the SHEET, whose cells are keyed by sheet column (`item_name`, `brand`), while the
   * reconstruction is keyed by PRODUCT COLUMN (`bulletPoints`, `lowStockThreshold`). Comparing the
   * two keyspaces made every field look emptied: measured on GALE-JACKET, 28 fields rendered as
   * "(empty) → value", which would tell an operator the record had just been wiped.
   */
  current: Record<string, unknown>
  coverage: Record<string, FieldCoverage>
  /** Server-authored, rendered verbatim. Never re-derived here. */
  warnings: string[]
  reconstructedAt: string
  eventCount: number
  auditCount: number
}

export type RecordStateStatus = StudioReadStatus

export interface RecordStateResult {
  status: RecordStateStatus
  data: RecordStateResponse | null
  error: string | null
  /** `at` is an ISO instant; passing null clears back to idle. */
  load: (at: string | null) => void
}

export function useRecordState(productId: string | null): RecordStateResult {
  const [at, setAt] = useState<string | null>(null)

  const run = useCallback(
    async (signal: AbortSignal): Promise<RecordStateResponse> => {
      if (!productId || !at) throw new Error('useRecordState: run called while disabled')
      const res = await studioFetch(
        `${getBackendUrl()}/api/products/${productId}/state?at=${encodeURIComponent(at)}`,
        signal,
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const json = (await res.json()) as RecordStateResponse
      // Same keyspace, same moment. One extra read, taken only when an operator actually asks for
      // a reconstruction. Plain `fetch`: a 404 HERE means this product is gone, which is a real
      // error rather than "the endpoint has not shipped", so it must not raise NotShipped.
      const nowRes = await fetch(`${getBackendUrl()}/api/products/${productId}`, {
        cache: 'no-store',
        signal,
      })
      const nowBody = nowRes.ok ? ((await nowRes.json()) as Record<string, unknown>) : null
      const current = (nowBody?.product as Record<string, unknown> | undefined) ?? nowBody ?? {}
      return { ...json, current }
    },
    [productId, at],
  )

  const read = useStudioRead(run, Boolean(productId) && Boolean(at))

  const load = useCallback((next: string | null) => setAt(next), [])
  return useMemo(
    () => ({ status: read.status, data: read.data, error: read.error, load }),
    [read, load],
  )
}

/**
 * The fields `POST /api/products/:id/restore` will actually apply.
 *
 * 🔴 A MIRROR of the route's own `ALLOWED` set (products.routes.ts), and mirrors are how this lane
 * has been bitten three times — so `restorable.vitest.test.ts` pins it against that source. It is
 * mirrored rather than fetched because no endpoint exposes it, and the alternative is worse: send
 * everything and let the server silently drop what it does not accept, which would show an
 * operator a restore of 30 fields and apply 24 without saying which.
 *
 * Master scalars only — no `attr_*`, no channel fields. A field outside this set is shown with the
 * reason rather than omitted, so the pane never quietly narrows what it offered.
 */
export const RESTORABLE_FIELDS: ReadonlySet<string> = new Set([
  'name', 'description', 'status', 'basePrice', 'costPrice', 'minPrice', 'maxPrice',
  'brand', 'manufacturer', 'ean', 'gtin', 'upc', 'productType',
  'bulletPoints', 'keywords', 'weightValue', 'weightUnit',
  'dimLength', 'dimWidth', 'dimHeight', 'dimUnit',
  'hsCode', 'countryOfOrigin', 'totalStock', 'lowStockThreshold',
])

/** Why this field cannot be restored — null when it can. One sentence, shown on the row. */
export function notRestorableReason(field: string, coverage: FieldCoverage): string | null {
  if (coverage === 'uncertain') {
    return 'Changed after this time, but its prior value was never recorded — restoring would write a value nobody has.'
  }
  if (!RESTORABLE_FIELDS.has(field)) {
    return field.startsWith('attr_') || field.includes('.')
      ? 'Schema attribute — restore covers the master record’s own fields only.'
      : 'Not a restorable field on the master record.'
  }
  return null
}
