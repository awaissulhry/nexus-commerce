'use client'

/**
 * Reviews area — the sub-sidebar's counts (Inbox: reviews that need a reply), from GET /api/sidebar/counts, the
 * endpoint the app rail reads for the same badge. Read on mount, every 60 s, when the tab regains focus, and shortly
 * after this or another tab changes a review (the invalidation channel). A failed read keeps the last counts: the
 * badge is a hint, never a reason to break the shell.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import type { SidebarCounts } from '@/app/_shared/app-nav'
import type { ReviewsNavCounts } from './reviews-navigation'

export function useReviewsCounts(): ReviewsNavCounts {
  const [counts, setCounts] = useState<ReviewsNavCounts>({})
  const inFlight = useRef(false)
  const alive = useRef(true)
  const timer = useRef<number | null>(null)

  const read = useCallback(async () => {
    // One read at a time: the poll, focus and a change can fire together (AppNavRail measured five stacked copies).
    if (inFlight.current) return
    inFlight.current = true
    try {
      // The timeout makes the read always settle, so `inFlight` always clears.
      const res = await fetch(`${getBackendUrl()}/api/sidebar/counts`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) })
      if (!res.ok) return
      const data = (await res.json()) as SidebarCounts
      if (alive.current) setCounts({ needReply: data.reviews?.needReply })
    } catch {
      /* keep the last counts */
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void read()
    const id = window.setInterval(read, 60_000)
    const onFocus = () => void read()
    window.addEventListener('focus', onFocus)
    return () => {
      alive.current = false
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [read])

  useInvalidationChannel(['review.updated', 'review.replied', 'review.imported'], () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      void read()
    }, 300)
  })

  return counts
}
