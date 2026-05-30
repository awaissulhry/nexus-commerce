'use client'

/**
 * RX.3 — "Live" indicator + alert handler for review surfaces.
 *
 * Subscribes to negative-review + spike events and raises a toast + an
 * (opt-in) browser notification, with quick links into the Desk / spikes.
 * The pulsing dot signals the page is wired to the live bus.
 */

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/components/ui/Toast'
import {
  useReviewEventsRefresh,
  type ReviewEventPayload,
} from '@/hooks/use-review-events-refresh'
import { fireBrowserNotification } from '@/lib/notifications/browser-notifications'

export function ReviewLiveChip() {
  const router = useRouter()
  const { toast } = useToast()
  const [lastTs, setLastTs] = useState<number | null>(null)

  const onEvent = useCallback(
    (e: ReviewEventPayload) => {
      setLastTs(Date.now())
      if (e.type === 'review.negative') {
        const mkt = e.marketplace ? ` · ${e.marketplace}` : ''
        const excerpt = typeof e.excerpt === 'string' ? e.excerpt : ''
        toast({
          title: `New negative review (${e.channel}${mkt})`,
          description: excerpt,
          tone: 'warning',
          durationMs: 8000,
          action: { label: 'Open Desk', onClick: () => router.push('/marketing/reviews/desk') },
        })
        fireBrowserNotification('reviewNegative', `New negative review (${e.channel})`, {
          body: excerpt || 'A customer left a negative review — respond from the Desk.',
          tagSuffix: String(e.reviewId ?? ''),
        })
      } else if (e.type === 'review.spike.detected') {
        toast({
          title: 'Review spike detected',
          description: `${e.category} · ${e.marketplace}`,
          tone: 'warning',
          durationMs: 8000,
          action: { label: 'View spikes', onClick: () => router.push('/marketing/reviews/spikes') },
        })
        fireBrowserNotification('reviewSpike', 'Review spike detected', {
          body: `${e.category} on ${e.marketplace}`,
          tagSuffix: String(e.spikeId ?? ''),
        })
      }
    },
    [toast, router],
  )

  const noop = useCallback(() => {}, [])

  useReviewEventsRefresh(noop, {
    onEvent,
    eventTypes: ['review.negative', 'review.spike.detected'],
    debounceMs: 4000,
  })

  return (
    <span
      className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider px-2 py-1 rounded ring-1 ring-inset bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900"
      title={lastTs ? `Last live event ${new Date(lastTs).toLocaleTimeString()}` : 'Listening for live review events'}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
      </span>
      Live
    </span>
  )
}
