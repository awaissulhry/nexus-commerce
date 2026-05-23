// PO.4 — SSE consumer for /api/fulfillment/purchase-orders/events.
//
// Mirrors use-inbound-events.ts. Subscribes to the PO event stream and
// re-emits each event into the shared invalidation channel so pages
// (this list, the [id] detail page, future spend-tile, etc.) refresh
// within ~200ms of a peer browser's mutation.
//
// Wire format: named SSE events with JSON data payloads + an opening
// `ping`. No-op on SSR and on browsers without EventSource.

'use client'

import { useEffect, useRef, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation, type InvalidationType } from './invalidation-channel'

interface PoEventWire {
  type: string
  poId?: string
  ts: number
  [key: string]: any
}

export interface UsePoEventsResult {
  /** True once the stream has emitted its initial `ping`. */
  connected: boolean
  /** Most recent event observed (any type). Useful for "X seconds ago" UIs. */
  lastEvent: PoEventWire | null
  /** Timestamp (ms epoch) of the last event we saw. Survives reconnects. */
  lastEventAt: number | null
}

const HANDLED: ReadonlySet<string> = new Set([
  'po.created',
  'po.updated',
  'po.transitioned',
  'po.deleted',
  'po.restored',
  'po.received',
])

export function usePoEvents(): UsePoEventsResult {
  const [connected, setConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState<PoEventWire | null>(null)
  const [lastEventAt, setLastEventAt] = useState<number | null>(null)
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (typeof EventSource === 'undefined') return

    const url = `${getBackendUrl()}/api/fulfillment/purchase-orders/events`
    const source = new EventSource(url, { withCredentials: false })
    sourceRef.current = source

    const handle = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as PoEventWire
        setLastEvent(parsed)
        if (parsed.type !== 'ping') {
          setLastEventAt(parsed.ts ?? Date.now())
        }
        if (HANDLED.has(parsed.type)) {
          emitInvalidation({
            type: parsed.type as InvalidationType,
            id: parsed.poId,
            meta: { source: 'sse', ...parsed },
          })
        }
      } catch {
        // Malformed payload / heartbeat — ignore silently.
      }
    }

    source.addEventListener('message', handle)
    const namedTypes = [
      'po.created',
      'po.updated',
      'po.transitioned',
      'po.deleted',
      'po.restored',
      'po.received',
      'ping',
    ]
    for (const t of namedTypes) source.addEventListener(t, handle as EventListener)

    source.addEventListener('ping', () => setConnected(true))
    source.onopen = () => setConnected(true)
    source.onerror = () => {
      // EventSource auto-reconnects on transient drops; flag down so
      // the LiveSync chip can render the disconnected state.
      setConnected(false)
    }

    return () => {
      source.close()
      sourceRef.current = null
      setConnected(false)
    }
  }, [])

  return { connected, lastEvent, lastEventAt }
}
