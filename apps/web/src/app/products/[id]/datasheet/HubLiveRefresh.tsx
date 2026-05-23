'use client'

/**
 * ATM.15 — Live refresh hook for the datasheet hub.
 *
 * Subscribes to the global invalidation channel (P-RT.1 + S.4 +
 * F-RT.1 substrate that already pipes SSE events from
 * /api/listings/events → BroadcastChannel) and triggers a soft
 * router.refresh() when an event matching THIS product lands.
 *
 * Why this is a tiny client component instead of a hook on the
 * hub page: the hub is a server component that re-fetches on
 * every render. router.refresh() is the right primitive — it
 * re-runs the server component without unmounting client state
 * like the variant matrix selection. A hook would require the
 * whole hub to become client-rendered, losing the SSR data
 * fetches that make the hub fast.
 *
 * Subscribed event types:
 *   product.updated       any field mutated; refresh
 *   listing.updated       cross-listing sync done; refresh
 *                         (filtered to events matching this product
 *                          via the listingIds prop)
 *   listing.created       new ChannelListing created for product
 *   listing.deleted       ChannelListing removed
 *   channel-pricing.updated channel-side pricing flat file landed
 *   pim.changed           PIM definition change (broad refresh)
 *
 * Throttled to one refresh per ~500ms so a bulk wave of events
 * doesn't trigger N refreshes in fast succession.
 */

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'

interface HubLiveRefreshProps {
  productId: string
  /** Listing IDs for this product, used to filter listing.* events
   *  so we don't refresh on every store-wide listing change. */
  listingIds: string[]
}

export default function HubLiveRefresh({
  productId,
  listingIds,
}: HubLiveRefreshProps) {
  const router = useRouter()
  const listingIdSet = useRef<Set<string>>(new Set(listingIds))
  listingIdSet.current = new Set(listingIds)

  const lastRefreshAt = useRef(0)
  const pendingRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )

  // Debounced refresh — 500ms window. A bulk-edit that triggers
  // 10 product.updated events in 200ms still results in one refresh.
  const scheduleRefresh = () => {
    if (pendingRefreshTimer.current) return
    const now = Date.now()
    const elapsed = now - lastRefreshAt.current
    const delay = elapsed < 500 ? 500 - elapsed : 0
    pendingRefreshTimer.current = setTimeout(() => {
      lastRefreshAt.current = Date.now()
      pendingRefreshTimer.current = null
      router.refresh()
    }, delay)
  }

  useInvalidationChannel(
    [
      'product.updated',
      'listing.updated',
      'listing.created',
      'listing.deleted',
      'channel-pricing.updated',
      'pim.changed',
    ],
    (event) => {
      if (event.type === 'product.updated') {
        if (event.id === productId) scheduleRefresh()
        return
      }
      if (event.type === 'pim.changed') {
        scheduleRefresh() // PIM definition change is global; affects every product
        return
      }
      if (event.type === 'channel-pricing.updated') {
        // Channel pricing events may carry product or listing id;
        // refresh broadly since this view shows pricing.
        if (event.id == null || event.id === productId) scheduleRefresh()
        return
      }
      // listing.* events — filter to our listings.
      if (event.id != null && listingIdSet.current.has(event.id)) {
        scheduleRefresh()
      }
    },
  )

  useEffect(() => {
    return () => {
      if (pendingRefreshTimer.current) {
        clearTimeout(pendingRefreshTimer.current)
      }
    }
  }, [])

  return null
}
