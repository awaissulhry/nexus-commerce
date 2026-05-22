// F-RT.1 — SSE consumer for /api/fulfillment/inbound/events.
//
// Mirrors use-outbound-events.ts (O.32) and use-listing-events.ts (S.4).
// Replaces the inline EventSource originally added by H.14 in
// InboundWorkspace so multiple pages (stock, replenishment, returns,
// purchase orders) can subscribe to inbound shipment changes via the
// same lightweight invalidation channel they already use for the
// other event families.
//
// Wire format: named SSE events with JSON data payloads + an opening
// `ping`. No-op on SSR and on browsers without EventSource.

'use client'

import { useEffect, useRef, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from './invalidation-channel'

interface InboundEvent {
  type: string
  shipmentId?: string
  reason?: string
  ts: number
  [key: string]: any
}

export interface UseInboundEventsResult {
  /** True once the SSE stream has produced its initial 'ping' event. */
  connected: boolean
  /** Most recent event observed (any type). */
  lastEvent: InboundEvent | null
}

export function useInboundEvents(): UseInboundEventsResult {
  const [connected, setConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState<InboundEvent | null>(null)
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (typeof EventSource === 'undefined') return

    const url = `${getBackendUrl()}/api/fulfillment/inbound/events`
    const source = new EventSource(url, { withCredentials: false })
    sourceRef.current = source

    const handle = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as InboundEvent
        setLastEvent(parsed)
        // Re-emit to the invalidation channel. Subscribers (stock,
        // replenishment, returns, POs) already opt-in via
        // invalidationTypes; pages that don't care simply don't.
        if (parsed.type === 'inbound.created') {
          emitInvalidation({ type: 'inbound.created', id: parsed.shipmentId, meta: { source: 'sse' } })
        } else if (parsed.type === 'inbound.updated') {
          emitInvalidation({ type: 'inbound.updated', id: parsed.shipmentId, meta: { source: 'sse', reason: parsed.reason } })
        } else if (parsed.type === 'inbound.received') {
          emitInvalidation({ type: 'inbound.received', id: parsed.shipmentId, meta: { source: 'sse' } })
        } else if (parsed.type === 'inbound.discrepancy') {
          emitInvalidation({ type: 'inbound.discrepancy', id: parsed.shipmentId, meta: { source: 'sse' } })
        } else if (parsed.type === 'inbound.cancelled') {
          emitInvalidation({ type: 'inbound.cancelled', id: parsed.shipmentId, meta: { source: 'sse' } })
        }
      } catch {
        // Malformed event payload — ignore silently. Heartbeats etc.
      }
    }

    source.addEventListener('message', handle)
    const namedTypes = [
      'inbound.created',
      'inbound.updated',
      'inbound.received',
      'inbound.discrepancy',
      'inbound.cancelled',
      'ping',
    ]
    for (const t of namedTypes) source.addEventListener(t, handle as EventListener)

    source.addEventListener('ping', () => setConnected(true))
    source.onopen = () => setConnected(true)
    source.onerror = () => {
      // EventSource auto-reconnects on transient drops; we just flag
      // down so any UI indicator can show the polling-fallback state.
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
