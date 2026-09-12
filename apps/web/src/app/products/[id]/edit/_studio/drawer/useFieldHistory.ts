'use client'

/**
 * PES.4.5 — per-cell history.
 *
 * Reads PES.5 §3.5, `GET /api/products/:id/studio/history` — the Owner-approved contract, not the
 * shape this lane originally asked for. It distinguishes FOUR outcomes and the pane says which:
 *
 *   rows                      → the history
 *   no rows, coverage started → "nothing recorded for this field since <date>"
 *   no rows, coverage null    → "per-cell history is not being recorded yet"
 *   endpoint absent (404/501) → "the history API has not shipped yet"
 *
 * Conflating any two of those is the failure this repo has been caught by before: an empty list
 * that means "the feature is not wired" looks exactly like an empty list that means "nobody has
 * ever changed this field", and only one of them is a bug worth reporting.
 *
 * 🔴 `coverageSince` is the honesty field and this hook surfaces it unchanged. PES.5 §4 fills in
 * `by` and `previous` for the single-product write path the studio autosaves through — but rows
 * written before it, and every catalogue-wide bulk-op after it, still carry neither. The pane
 * renders that in words and never reconstructs a previous value from the row beneath it.
 */

import { useCallback, useMemo } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { studioFetch, useStudioRead, type StudioReadStatus } from './useStudioRead'
import type { DrawerScope, FieldHistoryEntry, FieldHistoryPage } from './types'

export type HistoryStatus = StudioReadStatus

export interface FieldHistoryState {
  status: HistoryStatus
  entries: FieldHistoryEntry[]
  /** Null = nothing is covered yet. See `FieldHistoryPage.coverageSince`. */
  coverageSince: string | null
  coverageNote?: string
  error: string | null
  reload: () => void
}

interface HistoryPayload {
  entries: FieldHistoryEntry[]
  coverageSince: string | null
  coverageNote?: string
}

/** Frozen: `?? []` in the return would mint a new array every render (#166). */
const NO_ENTRIES: FieldHistoryEntry[] = Object.freeze([]) as unknown as FieldHistoryEntry[]

export function useFieldHistory(
  productId: string | null,
  fieldKey: string | null,
  scope: DrawerScope,
  /** The row whose history is wanted — a family read returns parent AND variations. */
  rowId: string | null,
): FieldHistoryState {
  const run = useCallback(
    async (signal: AbortSignal): Promise<HistoryPayload> => {
      // Unreachable: `enabled` below is the same condition. Thrown rather than silently returning
      // an empty page, which would be indistinguishable from "no history recorded".
      if (!productId || !fieldKey) throw new Error('useFieldHistory: run called while disabled')
      const qs = new URLSearchParams({ fieldKey, scope: scope.kind, limit: '50' })
      if (scope.locale) qs.set('locale', scope.locale)
      if (scope.channel) qs.set('channel', scope.channel)
      if (scope.marketplace) qs.set('marketplace', scope.marketplace)
      if (scope.kind === 'channel') qs.set('aliasKey', scope.aliasId ?? '')
      if (scope.accountId !== undefined) qs.set('accountId', scope.accountId)
      if (scope.listingId) qs.set('listingId', scope.listingId)
      if (rowId) qs.set('rowId', rowId)
      const res = await studioFetch(
        `${getBackendUrl()}/api/products/${rowId ?? productId}/studio/history?${qs}`,
        signal,
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const page = (await res.json()) as FieldHistoryPage
      return { entries: page.entries ?? [], coverageSince: page.coverageSince ?? null, coverageNote: page.coverageNote }
    },
    [productId, fieldKey, rowId, scope.kind, scope.channel, scope.marketplace, scope.aliasId, scope.accountId, scope.listingId, scope.locale],
  )

  const read = useStudioRead(run, Boolean(productId) && Boolean(fieldKey))

  // The four-outcome contract in the header is unchanged — it is mapped onto the shared read here
  // rather than re-implemented. `coverageSince` still passes through untouched.
  return useMemo(
    () => ({
      status: read.status,
      entries: read.data ? read.data.entries : NO_ENTRIES,
      coverageSince: read.data ? read.data.coverageSince : null,
      coverageNote: read.data?.coverageNote,
      error: read.error,
      reload: read.reload,
    }),
    [read],
  )
}
