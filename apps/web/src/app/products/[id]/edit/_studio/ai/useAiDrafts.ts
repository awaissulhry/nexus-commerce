'use client'

/**
 * PES.8 — the drafts a scope currently carries, and the two decisions an operator can make.
 *
 * One fetch per (scope, product set). The hook holds no optimistic state: an approve replays through
 * `PATCH /api/products/bulk` on the server and can be refused there — by a version conflict, by a
 * validator, by staleness — so the only honest thing to draw afterwards is what the server says on
 * the next read. Painting a cell approved and then taking it back is the shape of dishonesty the
 * 100%-honest-UI rule exists to stop.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { approveDrafts as approveApi, loadDrafts, rejectDrafts as rejectApi } from './api'
import {
  groupByColumn,
  indexDrafts,
  provenanceFor,
  type AiProvenance,
  type CellRef,
  type DraftColumnGroup,
} from './drafts'
import type { AiDraft, ApproveResponse } from './types'

export interface UseAiDraftsInput {
  /** The rows on screen. An empty list skips the fetch entirely. */
  productIds: string[]
  /** `null` = master scope. */
  channel: string | null
  marketplace: string | null
  /** The locale on screen. Absent = the master's own values only. */
  locale?: string | null
}

export interface UseAiDraftsValue {
  drafts: AiDraft[]
  groups: DraftColumnGroup[]
  counts: { total: number; pending: number; failed: number; stale: number }
  loading: boolean
  error: string | null
  /** Busy while a decision is in flight — the review surface disables its controls on this. */
  deciding: boolean
  /**
   * The AI half of PES.2's `ProvenanceLike` for one cell, or `null` when nothing is drafted there.
   * This is the whole of this lane's contribution to how a cell is drawn; wire it into the sheet's
   * column factory when PES.2's overlay hook lands (2.6).
   */
  provenanceFor(ref: CellRef): AiProvenance | null
  approve(draftIds: string[], opts?: { allowStale?: boolean }): Promise<ApproveResponse>
  reject(draftIds: string[]): Promise<{ rejected: number }>
  refresh(): void
}

const EMPTY_COUNTS = { total: 0, pending: 0, failed: 0, stale: 0 }

export function useAiDrafts(input: UseAiDraftsInput): UseAiDraftsValue {
  const { productIds, channel, marketplace, locale } = input
  const [drafts, setDrafts] = useState<AiDraft[]>([])
  const [counts, setCounts] = useState(EMPTY_COUNTS)
  const [loading, setLoading] = useState(false)
  const [deciding, setDeciding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  // A stable identity for the row set — a new array of the same ids must not refetch, or the hook
  // re-runs on every parent render for the life of the page.
  const idsKey = useMemo(() => [...productIds].sort().join(','), [productIds])

  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const ids = idsKey ? idsKey.split(',') : []
    if (ids.length === 0) {
      setDrafts([])
      setCounts(EMPTY_COUNTS)
      setError(null)
      return
    }
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setLoading(true)
    loadDrafts({ productIds: ids, channel, marketplace, locale }, ac.signal)
      .then((res) => {
        if (ac.signal.aborted) return
        setDrafts(res.drafts)
        setCounts(res.counts)
        setError(null)
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return
        // A drafts failure must not read as "no drafts" — an empty review list and a broken fetch
        // look identical, and only one of them means there is nothing to approve.
        setDrafts([])
        setCounts(EMPTY_COUNTS)
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false)
      })
    return () => ac.abort()
  }, [idsKey, channel, marketplace, locale, nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  const index = useMemo(() => indexDrafts(drafts), [drafts])
  const groups = useMemo(() => groupByColumn(drafts), [drafts])

  const provFor = useCallback((ref: CellRef) => provenanceFor(index, ref), [index])

  const approve = useCallback(
    async (draftIds: string[], opts: { allowStale?: boolean } = {}) => {
      setDeciding(true)
      try {
        const res = await approveApi(draftIds, opts)
        return res
      } finally {
        setDeciding(false)
        // Refetch whatever the outcome: a partial approval leaves some drafts pending with an
        // error on them, and that is exactly the state the operator needs to see next.
        refresh()
      }
    },
    [refresh],
  )

  const reject = useCallback(
    async (draftIds: string[]) => {
      setDeciding(true)
      try {
        return await rejectApi(draftIds)
      } finally {
        setDeciding(false)
        refresh()
      }
    },
    [refresh],
  )

  return {
    drafts,
    groups,
    counts,
    loading,
    error,
    deciding,
    provenanceFor: provFor,
    approve,
    reject,
    refresh,
  }
}
