// O.32 — SSE consumer for /api/fulfillment/outbound/events.
//
// One open EventSource per tab. Auto-reconnects on transient drops.
// Each event re-emits via the existing invalidation channel so the
// outbound surfaces (Pending, Shipments, drawer, sidebar badge)
// already-subscribed to shipment.* events refresh in <200ms instead
// of waiting for an operator click.
//
// Wire format mirrors S.4's listing-events: named SSE events with
// JSON data payloads + an opening `ping`. The hook is a no-op on SSR
// and on browsers without EventSource (rare; older mobile browsers).

'use client'

import { useEffect, useRef, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from './invalidation-channel'

interface OutboundEvent {
  type: string
  shipmentId?: string
  orderId?: string
  status?: string
  code?: string
  channel?: string
  ts: number
  [key: string]: any
}

export interface UseOutboundEventsResult {
  /** True once the SSE stream has produced its initial 'ping' event. */
  connected: boolean
  /** Most recent event observed (any type). */
  lastEvent: OutboundEvent | null
}

export function useOutboundEvents(): UseOutboundEventsResult {
  const [connected, setConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState<OutboundEvent | null>(null)
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (typeof EventSource === 'undefined') return

    const url = `${getBackendUrl()}/api/fulfillment/outbound/events`
    const source = new EventSource(url, { withCredentials: false })
    sourceRef.current = source

    const handle = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as OutboundEvent
        setLastEvent(parsed)

        // Re-emit to invalidation channel. Pages subscribing to
        // shipment.* / order.shipped already have refresh logic.
        if (parsed.type === 'shipment.created') {
          emitInvalidation({ type: 'shipment.created', id: parsed.shipmentId, meta: { source: 'sse' } })
        } else if (parsed.type === 'shipment.updated' || parsed.type === 'tracking.event') {
          emitInvalidation({ type: 'shipment.updated', id: parsed.shipmentId, meta: { source: 'sse', subtype: parsed.type } })
        } else if (parsed.type === 'shipment.deleted') {
          emitInvalidation({ type: 'shipment.deleted', id: parsed.shipmentId, meta: { source: 'sse' } })
        } else if (parsed.type === 'order.shipped') {
          emitInvalidation({ type: 'order.shipped', id: parsed.orderId, meta: { source: 'sse' } })
        }
      } catch {
        // Malformed event payload — ignore silently.
      }
    }

    source.addEventListener('message', handle)
    const namedTypes = [
      'shipment.created',
      'shipment.updated',
      'shipment.deleted',
      'order.shipped',
      'tracking.event',
      'ping',
    ]
    for (const t of namedTypes) source.addEventListener(t, handle as EventListener)

    source.addEventListener('ping', () => setConnected(true))
    source.onopen = () => setConnected(true)
    source.onerror = () => {
      // EventSource auto-reconnects; just flag down so any indicator
      // can degrade.
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
