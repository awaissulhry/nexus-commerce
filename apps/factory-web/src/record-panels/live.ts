'use client'

import { useLiveBus } from '../shell/live/use-live'
import type { LiveChange } from './model'

/**
 * Live screens (apps/factory-api core/sse.ts, `GET /live`): the API streams a small "record changed" message per event
 * the viewer may see (`event: change`, `data: {type, subject, companyId, siteId, occurredAt, fields}`), a `ready` when
 * the stream is live, and pings. A message is a HINT: the screen reads the part again; nothing is replayed, so after a
 * reconnect (the browser's EventSource reconnects by itself) the screen reads everything again (`onReconnect`).
 * The stream is reached through this app's `/api` (the session cookie is first-party); it needs no company header.
 * B-W2b-05: one connection per browser tab (shell/live/bus.ts), whoever listens.
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
  /** The stream came back after a break (or the tab's fallback poll while it is down): read everything again. */
  onReconnect?: () => void
}

/**
 * Listens to the live stream while the screen is open (and `enabled`) — through the tab's ONE live connection
 * (B-W2b-05, shell/live/bus.ts), shared with the bell and every other screen of the tab.
 */
export function useLiveChanges(handlers: LiveHandlers, enabled = true): void {
  useLiveBus(handlers, enabled)
}
