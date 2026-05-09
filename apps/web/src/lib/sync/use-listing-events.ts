// S.4 — SSE consumer for /api/listings/events.
//
// One open connection per tab. The hook auto-reconnects on transient
// drops (EventSource native behaviour) and dispatches every event to
// the existing invalidation channel — so any page using usePolledList
// with the relevant invalidationTypes refreshes within ~200ms instead
// of waiting for the next 30s polling tick.
//
// Why route through the invalidation channel instead of returning
// state directly: every workspace already subscribes to `listing.*`
// invalidation events for cross-tab sync (e.g., a bulk action in one
// tab refreshes other tabs). Mapping SSE events into the same channel
// means the wire protocol upgrade requires zero changes to consumer
// pages — they keep listening to invalidation types they already know
// about. Sharper cadence for free.
//
// Mapping:
//   listing.synced   → invalidation 'listing.updated' (refresh state)
//   listing.syncing  → invalidation 'listing.updated' (cells flip amber)
//   listing.updated  → invalidation 'listing.updated'
//   listing.created  → invalidation 'listing.created'
//   listing.deleted  → invalidation 'listing.deleted'
//   wizard.submitted → invalidation 'wizard.submitted' (DR-C.3 — closes
//                       the closed-source-tab gap when the operator
//                       leaves /products/[id]/list-wizard mid-submit)
//   bulk.progress    → invalidation 'bulk-job.completed' (debounced upstream)
//   bulk.completed   → invalidation 'bulk-job.completed'
//   ping             → no-op (just confirms liveness)

'use client'

import { useEffect, useRef, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from './invalidation-channel'

interface ListingEvent {
  type: string
  listingId?: string
  jobId?: string
  reason?: string
  status?: string
  durationMs?: number
  ts: number
  [key: string]: any
}

export interface UseListingEventsResult {
  /** True once the SSE stream has produced its initial 'ping' event. */
  connected: boolean
  /** Most recent event observed (any type). Useful for "X listings updated just now" indicators. */
  lastEvent: ListingEvent | null
}

export function useListingEvents(): UseListingEventsResult {
  const [connected, setConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState<ListingEvent | null>(null)
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (typeof EventSource === 'undefined') return

    const url = `${getBackendUrl()}/api/listings/events`
    const source = new EventSource(url, { withCredentials: false })
    sourceRef.current = source

    const handle = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as ListingEvent
        setLastEvent(parsed)

        // Dispatch to the invalidation channel so usePolledList et al.
        // refresh. Pages that don't care simply don't subscribe.
        if (parsed.type === 'listing.synced' || parsed.type === 'listing.syncing' || parsed.type === 'listing.updated') {
          emitInvalidation({
            type: 'listing.updated',
            id: parsed.listingId,
            meta: { source: 'sse', subtype: parsed.type, ...parsed },
          })
        } else if (parsed.type === 'listing.created') {
          emitInvalidation({ type: 'listing.created', id: parsed.listingId, meta: { source: 'sse' } })
        } else if (parsed.type === 'listing.deleted') {
          emitInvalidation({ type: 'listing.deleted', id: parsed.listingId, meta: { source: 'sse' } })
        } else if (parsed.type === 'wizard.submitted') {
          // DR-C.3 — fan out wizard.submitted from the SSE bus into
          // the cross-tab invalidation channel so /products/drafts,
          // ProductsWorkspace, and the listings workspaces all
          // refresh even when the source wizard tab has been closed.
          emitInvalidation({
            type: 'wizard.submitted',
            id: parsed.wizardId,
            meta: { source: 'sse', productId: parsed.productId, status: parsed.status },
          })
        } else if (parsed.type === 'bulk.progress' || parsed.type === 'bulk.completed') {
          emitInvalidation({
            type: 'bulk-job.completed',
            meta: { source: 'sse', subtype: parsed.type, jobId: parsed.jobId, ...parsed },
          })
        }
      } catch {
        // Malformed event payload — ignore silently. The bus may have
        // sent a non-JSON heartbeat / comment line that some browsers
        // surface as a message event.
      }
    }

    // Listen on both the generic 'message' (default) and the named
    // event types we publish from the backend (event: type prefix).
    source.addEventListener('message', handle)
    const namedTypes = [
      'listing.synced',
      'listing.syncing',
      'listing.updated',
      'listing.created',
      'listing.deleted',
      'wizard.submitted',
      'bulk.progress',
      'bulk.completed',
      'ping',
    ]
    for (const t of namedTypes) source.addEventListener(t, handle as EventListener)

    source.addEventListener('ping', () => setConnected(true))
    source.onopen = () => setConnected(true)
    source.onerror = () => {
      // EventSource auto-reconnects on transient errors; we just flag
      // the connection as down so the UI can degrade gracefully (the
      // 30s polling cadence kicks back in implicitly because we're not
      // suppressing it — SSE is purely additive).
      setConnected(false)
    }

    return () => {
      source.close()
      sourceRef.current = null
      setConnected(false)
    }
  }, [])

  return { connected, lastEvent }
}
