'use client'

/**
 * Amazon sheet gaps — the live hook the product sheet and the Matrix share. It listens on the invalidation channel,
 * asks the one rule (`listingValuesLive.ts`) what each event means for this view, coalesces a burst, and calls
 * `onStock` or `onFull`. The caller decides whether it can re-read now (no open editor, no save in flight) or owes it.
 */
import { useEffect, useMemo, useRef } from 'react'

import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'

import { awayTooLong, createLiveCoalescer, liveRefreshNeeded, LIVE_EVENT_TYPES, type LiveScope } from './listingValuesLive'

export interface UseListingValuesLiveOptions extends LiveScope {
  onStock: () => void
  onFull: () => void
  /** `false` (preview data, nothing loaded) ignores every event. Default on. */
  enabled?: boolean
}

export function useListingValuesLive(opts: UseListingValuesLiveOptions): void {
  const ref = useRef(opts)
  ref.current = opts
  const coalescer = useMemo(() => createLiveCoalescer((decision) => (decision === 'full' ? ref.current.onFull() : ref.current.onStock())), [])
  useEffect(() => () => coalescer.cancel(), [coalescer])

  useInvalidationChannel(LIVE_EVENT_TYPES, (event) => {
    const o = ref.current
    if (o.enabled === false) return
    coalescer.push(liveRefreshNeeded(event, o))
  })

  useEffect(() => {
    if (typeof document === 'undefined') return
    let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return }
      const away = awayTooLong(hiddenAt, Date.now())
      hiddenAt = null
      if (away && ref.current.enabled !== false && ref.current.familyId) coalescer.push('full')
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [coalescer])
}
