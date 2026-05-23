'use client'

/**
 * PIM C.3 — Matrix mutation hook.
 *
 * Buffers cell edits and flushes them as a batched PATCH /products/bulk
 * call. Optimistic-by-default: the caller updates local state synchron-
 * ously, this hook tracks per-row "pending / saved / error" status and
 * rolls back on server rejection.
 *
 * Reuses the existing /products/bulk endpoint (battle-tested by /products
 * grid + cross-grid XG-series) — no new backend code.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

interface PendingChange {
  id: string
  field: string
  value: unknown
  /** Snapshot of the pre-edit value so we can roll back on error. */
  rollback: unknown
}

export type RowStatus = 'idle' | 'pending' | 'saved' | 'error'

interface UseMatrixMutationOptions {
  /** ms to wait after the last edit before flushing the batch. */
  debounceMs?: number
  /** Called when the server rejects a change; receives the rollback
   *  payload so the caller can revert its optimistic state. */
  onRollback?: (changes: PendingChange[]) => void
  /** Surface server errors to the operator (toast wiring). */
  onError?: (message: string) => void
}

interface UseMatrixMutationReturn {
  /** Schedule a cell change. Caller is expected to have already
   *  optimistically updated local state before calling this. */
  commit: (change: PendingChange) => void
  /** Force-flush any pending batch immediately (useful on unmount). */
  flush: () => Promise<void>
  /** Per-row status map for UI hints. */
  statusByRow: Record<string, RowStatus>
}

export function useMatrixMutation(
  options: UseMatrixMutationOptions = {},
): UseMatrixMutationReturn {
  const { debounceMs = 250, onRollback, onError } = options

  // Buffered changes keyed by `${id}:${field}` so a quick re-edit of
  // the same cell collapses to one PATCH entry (the last value wins).
  const bufferRef = useRef<Map<string, PendingChange>>(new Map())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [statusByRow, setStatusByRow] = useState<Record<string, RowStatus>>({})

  const setRowStatus = useCallback((id: string, status: RowStatus) => {
    setStatusByRow((prev) => ({ ...prev, [id]: status }))
  }, [])

  const flushNow = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const buffer = bufferRef.current
    if (buffer.size === 0) return
    const batch = Array.from(buffer.values())
    bufferRef.current = new Map()

    // Mark all affected rows as pending. We don't dedupe across
    // entries that share an id since the status is per-row.
    for (const c of batch) setRowStatus(c.id, 'pending')

    try {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: batch.map((c) => ({ id: c.id, field: c.field, value: c.value })),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      for (const c of batch) setRowStatus(c.id, 'saved')
      // Decay back to idle after a short delay so the "saved" tick
      // doesn't linger forever in the row indicator.
      setTimeout(() => {
        for (const c of batch) setRowStatus(c.id, 'idle')
      }, 1500)
    } catch (err: any) {
      for (const c of batch) setRowStatus(c.id, 'error')
      onError?.(err?.message ?? 'Save failed')
      onRollback?.(batch)
    }
  }, [setRowStatus, onError, onRollback])

  const commit = useCallback(
    (change: PendingChange) => {
      bufferRef.current.set(`${change.id}:${change.field}`, change)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        void flushNow()
      }, debounceMs)
    },
    [debounceMs, flushNow],
  )

  // Flush any pending batch on unmount so an edit isn't lost when the
  // operator navigates away.
  useEffect(() => {
    return () => {
      void flushNow()
    }
  }, [flushNow])

  return { commit, flush: flushNow, statusByRow }
}
