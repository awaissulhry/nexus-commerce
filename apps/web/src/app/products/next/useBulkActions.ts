'use client'

/**
 * The bulk mutations behind the selection toolbar — real backend calls, mirroring the live
 * /products page. Each one broadcasts on the invalidation channel so the grid (and every other
 * open tab) refetches, and reports the SERVER's count, never the selection's.
 */
import { useCallback, useState } from 'react'

import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

/** Every bulk endpoint rejects more than this with a 400. Mirrored here so the page can say so
 *  before the round trip rather than relaying the server's raw message after it. */
export const BULK_MAX = 200

/** What a bulk endpoint actually reports back. Every one of them returns HTTP 200 for a
 *  PARTIAL failure, so the body is the only place the truth lives. */
interface BulkResult {
  ok?: boolean
  /** bulk-status */ updated?: number
  /** bulk-duplicate */ created?: number
  /** bulk-soft-delete */ changed?: number
  skipped?: number
  errors?: Array<{ id: string; error: string }>
}

export type Toast = (message: string, tone: 'success' | 'danger' | 'neutral') => void

export interface UseBulkActionsOptions {
  toast: Toast
  /** Called after an action that consumed the selection — the grid clears it. */
  onConsumed: () => void
}

export function useBulkActions({ toast, onConsumed }: UseBulkActionsOptions) {
  const [busy, setBusy] = useState(false)

  const runBulk = useCallback(
    async (
      /** Given the SERVER's count, produce the sentence. Never the selection size — see below. */
      label: (n: number) => string,
      path: string,
      body: Record<string, unknown>,
      ids: string[],
      source: string,
      opts?: { clearSelection?: boolean },
    ) => {
      if (!ids.length || busy) return
      // Every one of these endpoints rejects more than 200 ids with a 400. Saying so before the
      // round trip beats relaying a raw server string after it.
      if (ids.length > BULK_MAX) {
        toast(`Select ${BULK_MAX} or fewer — that action can't take ${ids.length} at once.`, 'danger')
        return
      }
      setBusy(true)
      try {
        const res = await fetch(`${getBackendUrl()}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const payload = (await res.json().catch(() => ({}))) as BulkResult & { error?: string }
        if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`)

        emitInvalidation({ type: 'product.updated', meta: { productIds: ids, source } })

        // 🔴 The count comes from the SERVER, not from the selection. These endpoints skip rows
        // that are already in the target state and collect per-row failures, so "Marked 5
        // active" was a claim about what was asked for, not what happened.
        const n = payload.updated ?? payload.created ?? payload.changed ?? ids.length
        const failed = payload.errors?.length ?? 0
        if (failed > 0) {
          // A partial failure arrives as HTTP 200 with `ok: false`.
          toast(`${label(n)} · ${failed} failed`, 'danger')
        } else if (n === 0) {
          toast('Nothing changed — already in that state', 'neutral')
        } else {
          toast(label(n), 'success')
        }
        if (opts?.clearSelection !== false) onConsumed()
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Action failed', 'danger')
      } finally {
        setBusy(false)
      }
    },
    [busy, toast, onConsumed],
  )

  // Publish: resolve the selected products to their listings on the target channel/marketplace,
  // then enqueue a publish bulk-action (2-step, like the live page).
  const publishBulk = useCallback(
    async (ids: string[], channel: string, marketplace: string, label: string) => {
      if (!ids.length || busy) return
      setBusy(true)
      try {
        const params = new URLSearchParams({ channel, marketplace, includeCoverage: 'false', pageSize: '500' })
        const foundRes = await fetch(`${getBackendUrl()}/api/listings?${params.toString()}`)
        if (!foundRes.ok) {
          const b = await foundRes.json().catch(() => ({}))
          throw new Error((b as { error?: string }).error ?? `Failed to load listings (${foundRes.status})`)
        }
        const found = (await foundRes.json()) as { listings?: Array<{ id: string; productId: string }> }
        const listingIds = (found.listings ?? []).filter((l) => ids.includes(l.productId)).map((l) => l.id)
        if (listingIds.length === 0) {
          throw new Error(`No existing listings on ${label} — create them in the listing wizard first`)
        }
        const res = await fetch(`${getBackendUrl()}/api/listings/bulk-action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'publish', listingIds }),
        })
        if (!res.ok) {
          const b = await res.json().catch(() => ({}))
          throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`)
        }
        emitInvalidation({ type: 'listing.updated', meta: { listingIds, source: 'products-publish', channel, marketplace } })
        emitInvalidation({ type: 'bulk-job.completed', meta: { action: 'publish', listingIds } })
        toast(`Queued publish of ${listingIds.length} to ${label}`, 'success')
        onConsumed()
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Publish failed', 'danger')
      } finally {
        setBusy(false)
      }
    },
    [busy, toast, onConsumed],
  )

  const setStatusBulk = useCallback(
    (ids: string[], status: 'ACTIVE' | 'DRAFT' | 'INACTIVE', includeChildren = true) =>
      runBulk((n) => `Marked ${n} ${status.toLowerCase()}`, '/api/products/bulk-status', { productIds: ids, status, includeChildren }, ids, 'bulk-status'),
    [runBulk],
  )

  const duplicateBulk = useCallback(
    (ids: string[]) =>
      runBulk((n) => `Duplicated ${n} ${n === 1 ? 'product' : 'products'}`, '/api/products/bulk-duplicate', { productIds: ids, includeChildren: true }, ids, 'bulk-duplicate'),
    [runBulk],
  )

  const softDeleteBulk = useCallback(
    (ids: string[]) =>
      runBulk((n) => `Moved ${n} to recycle bin`, '/api/products/bulk-soft-delete', { productIds: ids, includeChildren: true }, ids, 'bulk-soft-delete'),
    [runBulk],
  )

  return { busy, publishBulk, setStatusBulk, duplicateBulk, softDeleteBulk }
}
