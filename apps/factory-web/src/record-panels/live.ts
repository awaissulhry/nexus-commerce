'use client'

import { useEffect, useRef } from 'react'
import type { LiveChange } from './model'

/**
 * Live screens (apps/factory-api core/sse.ts, `GET /live`): the API streams a small "record changed" message per event
 * the viewer may see (`event: change`, `data: {type, subject, companyId, siteId, occurredAt, fields}`), a `ready` when
 * the stream is live, and pings. A message is a HINT: the screen reads the part again; nothing is replayed, so after a
 * reconnect (the browser's EventSource reconnects by itself) the screen reads everything again (`onReconnect`).
 * The stream is reached through this app's `/api` (the session cookie is first-party); it needs no company header.
 */

/** A `change` message's data, or null when it is not one. */
export function parseLiveData(text: string): LiveChange | null {
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value !== 'object' || value === null) return null
    const { type, fields } = value as { type?: unknown; fields?: unknown }
    if (typeof type !== 'string') return null
    return { type, fields: typeof fields === 'object' && fields !== null ? (fields as Record<string, unknown>) : {} }
  } catch {
    return null
  }
}

export interface LiveHandlers {
  onChange: (change: LiveChange) => void
  /** The stream came back after a break: read everything again. */
  onReconnect?: () => void
}

/** Listens to the live stream while the screen is open (and `enabled`). */
export function useLiveChanges(handlers: LiveHandlers, enabled = true): void {
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return
    const source = new EventSource('/api/live')
    let readyOnce = false
    const onReady = () => {
      if (readyOnce) latest.current.onReconnect?.()
      readyOnce = true
    }
    const onChange = (event: MessageEvent<string>) => {
      const change = parseLiveData(event.data)
      if (change) latest.current.onChange(change)
    }
    source.addEventListener('ready', onReady)
    source.addEventListener('change', onChange as EventListener)
    return () => {
      source.removeEventListener('ready', onReady)
      source.removeEventListener('change', onChange as EventListener)
      source.close()
    }
  }, [enabled])
}
