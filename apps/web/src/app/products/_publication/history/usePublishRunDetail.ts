'use client'

/**
 * Publish history — one run's detail, read from `GET /api/publications/:id`, and the actions on it.
 *
 * Live: while the run still waits for the channel, the server's `publication.status_changed` (the listing event
 * stream, mapped onto the invalidation channel by step 2) re-reads it. No polling loop of its own. Only product sheet
 * runs announce events; an older source's run is read once and on "Try again".
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { HistoryRunDetail } from '@nexus/shared/publication-history'
import type { StudioPublicationCheck, StudioRetrySelection } from '@nexus/shared/studio-publication'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { HistoryRequestError, historyRequest } from './runActions'

export type RunDetailState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  /** `stale` = the newest re-read failed; the detail shown is the last good one, and the drawer says so. */
  | { kind: 'ready'; detail: HistoryRunDetail; stale?: string }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }

export interface ListingRequest { runId: string; listingId: string; sku: string; requests: unknown[] }

const enc = encodeURIComponent

export function usePublishRunDetail(runId: string | null) {
  const [state, setState] = useState<RunDetailState>({ kind: 'idle' })
  const [nonce, setNonce] = useState(0)
  /** The detail last shown for this run: a failed re-read keeps it on screen instead of blanking the drawer. */
  const shown = useRef<{ id: string; detail: HistoryRunDetail } | null>(null)

  useEffect(() => {
    if (!runId) { setState({ kind: 'idle' }); shown.current = null; return }
    const controller = new AbortController()
    if (shown.current?.id !== runId) { shown.current = null; setState({ kind: 'loading' }) }
    historyRequest<HistoryRunDetail>(`/api/publications/${enc(runId)}`, { signal: controller.signal })
      .then(detail => {
        if (controller.signal.aborted) return
        shown.current = { id: runId, detail }
        setState({ kind: 'ready', detail })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof HistoryRequestError && error.status === 404) { shown.current = null; setState({ kind: 'not-found' }); return }
        const message = error instanceof Error ? error.message : 'The publish could not be read.'
        // Keep the last good detail; the drawer says the refresh failed.
        if (shown.current?.id === runId) setState({ kind: 'ready', detail: shown.current.detail, stale: message })
        else setState({ kind: 'error', message })
      })
    return () => controller.abort()
  }, [runId, nonce])

  const reload = useCallback(() => setNonce(n => n + 1), [])

  // A product sheet run keeps its own id as the publication id, so the event names it directly.
  useInvalidationChannel('publication.status_changed', useCallback(event => {
    const id = typeof event.meta?.publicationId === 'string' ? event.meta.publicationId : event.id
    if (runId && id === runId) reload()
  }, [runId, reload]))

  const detail = state.kind === 'ready' ? state.detail : null

  /** "Check now": ask the channel again through the publish route (read only), then read the run again. */
  const checkNow = useCallback(async () => {
    if (!detail?.run.productId) throw new Error('This publish is not tied to a product, so it cannot be checked from here.')
    await historyRequest(`/api/products/${enc(detail.run.productId)}/studio-publication/${enc(detail.run.id)}`)
    reload()
  }, [detail, reload])

  /** D3 — a person checked the listing on the channel. The status stays; the destination opens again. */
  const markChecked = useCallback(async (note: string) => {
    if (!detail?.run.productId) throw new Error('This publish is not tied to a product, so it cannot be marked from here.')
    const trimmed = note.trim()
    const result = await historyRequest<StudioPublicationCheck>(
      `/api/products/${enc(detail.run.productId)}/studio-publication/${enc(detail.run.id)}/mark-checked`,
      { method: 'POST', body: trimmed ? { note: trimmed } : {} },
    )
    reload()
    return result
  }, [detail, reload])

  /** What a NEW review should tick: the failed products and their fields. Reads only. */
  const retrySelection = useCallback(async () => {
    if (!detail?.run.productId) throw new Error('This publish is not tied to a product.')
    return historyRequest<StudioRetrySelection>(`/api/products/${enc(detail.run.productId)}/studio-publication/${enc(detail.run.id)}/retry-selection`)
  }, [detail])

  /** The exact request sent for one listing. Needs `products.publish`; loaded only when opened. */
  const loadRequest = useCallback(async (listingId: string) => {
    if (!runId) throw new Error('No publish is open.')
    return historyRequest<ListingRequest>(`/api/publications/${enc(runId)}/listings/${enc(listingId)}/request`)
  }, [runId])

  return { state, detail, reload, checkNow, markChecked, retrySelection, loadRequest }
}
