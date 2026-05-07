/**
 * Phase 10d — cross-page / cross-tab invalidation via BroadcastChannel.
 *
 * Why this exists
 * ───────────────
 * Phase 1 audit verified the pages are silos: edit a product on
 * /products and /listings doesn't know until its 30s polling tick (or,
 * for the Health/Matrix/Drafts lenses, never). Cross-page invalidation
 * fixes the gap without WebSocket/SSE infrastructure (you explicitly
 * chose smart polling, Option C).
 *
 * Mechanism
 * ─────────
 * Browser-native BroadcastChannel on the well-known name
 * 'nexus:invalidations'. Any open tab on the same origin can post an
 * event when it mutates data, and any other tab subscribing to that
 * event type triggers its own refetch on next render.
 *
 *   // After a successful mutation:
 *   emitInvalidation({ type: 'product.updated', id: productId, fields: ['basePrice'] })
 *
 *   // On a page that renders products / listings / etc.:
 *   useInvalidationChannel(
 *     ['product.updated', 'listing.updated', 'bulk-job.completed'],
 *     (event) => { refetch() }
 *   )
 *
 * Event vocabulary
 * ────────────────
 * Type-safe enum-style. New types added as the codebase grows; the
 * hook accepts a subset so each page only fires when a relevant event
 * arrives. `id` is optional (not every invalidation has a single
 * subject — bulk operations affect many rows).
 *
 * SSR safety
 * ──────────
 * BroadcastChannel doesn't exist in Node. The factory checks
 * `typeof BroadcastChannel === 'undefined'` and returns no-op shims
 * for the server — pages can call emit/subscribe at any phase
 * without guarding.
 */

'use client'

import { useEffect, useRef } from 'react'

const CHANNEL_NAME = 'nexus:invalidations'

export type InvalidationType =
  | 'product.updated'
  | 'product.created'
  | 'product.deleted'
  | 'listing.updated'
  | 'listing.created'
  | 'listing.deleted'
  | 'wizard.submitted'
  | 'wizard.created'
  | 'wizard.deleted'
  | 'bulk-job.completed'
  | 'pim.changed'
  | 'channel-connection.changed'
  // P.3 — saved-view + alert events. Cross-tab visibility for the
  // saved-views dropdown and the ManageAlertsModal so a user editing
  // alerts in one tab doesn't see stale state in another.
  | 'saved-view.changed'
  | 'saved-view-alert.changed'

export interface InvalidationEvent {
  type: InvalidationType
  /** Subject id when the event has a single subject (productId, listingId, …). */
  id?: string
  /** Optional field-level granularity: `['basePrice', 'totalStock']`. */
  fields?: string[]
  /** Free-form metadata (bulk-job id, count of affected rows, etc.). */
  meta?: Record<string, unknown>
  /**
   * Source page that emitted the event — useful for debugging the
   * "who told who" story. Set automatically by emitInvalidation().
   */
  origin?: string
  /** ms since epoch when the event was emitted. */
  emittedAt?: number
}

/**
 * Lazily-created singleton BroadcastChannel. Built at first call so
 * SSR and tests don't pay the cost. Unrefenced channels GC fine; we
 * never .close() the singleton because it lives the lifetime of the tab.
 */
let _channel: BroadcastChannel | null = null
function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined') return null
  if (typeof BroadcastChannel === 'undefined') return null
  if (!_channel) _channel = new BroadcastChannel(CHANNEL_NAME)
  return _channel
}

/**
 * Emit an invalidation. Same-tab listeners are also notified so a
 * single page that has multiple components listening (e.g. a sidebar
 * count + a main grid) refresh together when the page itself
 * mutates data.
 */
export function emitInvalidation(event: InvalidationEvent): void {
  const channel = getChannel()
  if (!channel) return
  const enriched: InvalidationEvent = {
    ...event,
    origin: event.origin ?? (typeof window !== 'undefined' ? window.location.pathname : undefined),
    emittedAt: event.emittedAt ?? Date.now(),
  }
  try {
    channel.postMessage(enriched)
    // BroadcastChannel does NOT deliver to the sender's own listeners
    // by default (per spec). Re-dispatch via a custom event on window
    // so same-tab subscribers fire too — that's the typical
    // expectation for "I changed something, refresh my own UI."
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('nexus:invalidation-local', { detail: enriched }),
      )
    }
  } catch (err) {
    // Logging only; an emit failure can't fail the user's mutation.
    if (typeof console !== 'undefined') {
      // eslint-disable-next-line no-console
      console.warn('[invalidation] emit failed', err, event)
    }
  }
}

/**
 * Subscribe to one or more invalidation event types. The callback
 * fires for every matching message, both from other tabs (via
 * BroadcastChannel) and from the same tab (via the local custom event
 * re-dispatch).
 *
 * The callback is wrapped in a ref so the caller can change it on
 * each render without triggering re-subscribes — a common foot-gun
 * with useEffect-driven event listeners.
 */
export function useInvalidationChannel(
  types: InvalidationType[] | InvalidationType,
  callback: (event: InvalidationEvent) => void,
): void {
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  // Stable string set the effect can compare without retriggering on
  // a fresh array literal each render.
  const typesKey = useRef('')
  const wantedTypes = Array.isArray(types) ? types : [types]
  const nextKey = wantedTypes.slice().sort().join(',')

  useEffect(() => {
    typesKey.current = nextKey
    const wanted = new Set(wantedTypes)
    const channel = getChannel()

    const handler = (event: InvalidationEvent) => {
      if (!wanted.has(event.type)) return
      callbackRef.current(event)
    }

    const channelHandler = (e: MessageEvent<InvalidationEvent>) => handler(e.data)
    const localHandler = (e: Event) => {
      const detail = (e as CustomEvent<InvalidationEvent>).detail
      if (detail) handler(detail)
    }

    channel?.addEventListener('message', channelHandler)
    if (typeof window !== 'undefined') {
      window.addEventListener('nexus:invalidation-local', localHandler)
    }

    return () => {
      channel?.removeEventListener('message', channelHandler)
      if (typeof window !== 'undefined') {
        window.removeEventListener('nexus:invalidation-local', localHandler)
      }
    }
    // typesKey acts as a stable signature so the effect only re-runs
    // when the *set* of subscribed types changes, not when the caller
    // passes a fresh array literal each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextKey])
}
