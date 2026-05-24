'use client'

// EC.3.1 — useEbayChannelEvents
//
// Filters the cross-tab SSE bus + invalidation channel down to
// events that matter for THIS (productId, marketplace) cockpit
// instance. Returns:
//   - connected:           SSE pipe is live (vs reconnecting / never up)
//   - lastEvent:           most recent raw SSE event observed (any kind)
//   - listingUpdatedAt:    when this exact listing last got an update
//   - masterChangedAt:     when this product's master record last changed
//   - siblingChangedAt:    when a sibling-marketplace listing for the
//                          same product changed (useful for "your
//                          Sibling source preview is stale")
//   - secondsSinceLast:    re-ticks once per second so HeartbeatDot
//                          can show fresh-ness without re-rendering
//                          the rest of the cockpit
//
// Each timestamp updates ONLY when the event matches the productId /
// marketplace filter, so unrelated chatter doesn't flicker the UI.

import { useEffect, useRef, useState } from 'react'
import { useListingEvents } from '@/lib/sync/use-listing-events'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'

interface Args {
  productId: string
  marketplace: string
  /** Listings for OTHER marketplaces on the same channel — used to
   *  match invalidation events back to a sibling. */
  siblingListingIds?: string[]
  /** Current listing ID, if any. Listings can be created on the fly
   *  so this may flip from undefined → string mid-session. */
  currentListingId?: string
}

interface State {
  connected: boolean
  lastEvent: { type: string; ts: number } | null
  listingUpdatedAt: number | null
  masterChangedAt: number | null
  siblingChangedAt: number | null
  secondsSinceLast: number
}

export function useEbayChannelEvents({
  productId,
  marketplace: _marketplace,
  siblingListingIds = [],
  currentListingId,
}: Args): State {
  const { connected, lastEvent } = useListingEvents()
  const [listingUpdatedAt, setListingUpdatedAt] = useState<number | null>(null)
  const [masterChangedAt, setMasterChangedAt] = useState<number | null>(null)
  const [siblingChangedAt, setSiblingChangedAt] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const siblingsRef = useRef(new Set(siblingListingIds))
  const currentRef = useRef(currentListingId)

  // Keep the sibling + current refs in sync with the latest props so
  // the invalidation subscriber (which captures them once) always
  // sees current values without re-subscribing.
  useEffect(() => {
    siblingsRef.current = new Set(siblingListingIds)
  }, [siblingListingIds])
  useEffect(() => {
    currentRef.current = currentListingId
  }, [currentListingId])

  // Mirror raw SSE events into the typed timestamps. Listing events
  // from the SSE bus carry listingId; product events carry productId.
  useEffect(() => {
    if (!lastEvent) return
    if (lastEvent.type === 'product.updated' || lastEvent.type === 'product.created') {
      if (lastEvent.productId === productId) {
        setMasterChangedAt(Date.now())
      }
    }
    if (lastEvent.type === 'listing.updated' || lastEvent.type === 'listing.synced') {
      const id = lastEvent.listingId
      if (id && id === currentRef.current) {
        setListingUpdatedAt(Date.now())
      } else if (id && siblingsRef.current.has(id)) {
        setSiblingChangedAt(Date.now())
      }
    }
  }, [lastEvent, productId])

  // Local-tab invalidation channel — fires for in-tab mutations as
  // well as cross-tab broadcasts. Catches mutations that go through
  // the invalidation bus but not the SSE bus (e.g. an inline PATCH
  // in another tab on the SAME product).
  useInvalidationChannel(
    ['product.updated', 'listing.updated', 'pim.changed', 'channel-pricing.updated'],
    (event) => {
      if (event.type === 'product.updated' || event.type === 'pim.changed') {
        if (event.id === productId) setMasterChangedAt(Date.now())
      }
      if (event.type === 'listing.updated' || event.type === 'channel-pricing.updated') {
        const id = event.id as string | undefined
        if (id && id === currentRef.current) setListingUpdatedAt(Date.now())
        else if (id && siblingsRef.current.has(id)) setSiblingChangedAt(Date.now())
      }
    },
  )

  // Re-tick every second so consumers reading "secondsSinceLast" get
  // fresh values without re-rendering the world. The tick state itself
  // is only used to recompute the derived value below.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => (t + 1) % 100_000), 1000)
    return () => window.clearInterval(id)
  }, [])

  const lastTs = Math.max(
    listingUpdatedAt ?? 0,
    masterChangedAt ?? 0,
    siblingChangedAt ?? 0,
  )
  const secondsSinceLast = lastTs > 0 ? Math.floor((Date.now() - lastTs) / 1000) : -1
  // Reference `tick` so the linter knows we want a re-render each second.
  void tick

  return {
    connected,
    lastEvent: lastEvent
      ? { type: lastEvent.type as string, ts: (lastEvent as any).ts ?? Date.now() }
      : null,
    listingUpdatedAt,
    masterChangedAt,
    siblingChangedAt,
    secondsSinceLast,
  }
}
