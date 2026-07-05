'use client'

/**
 * RX.2 — Review Response Desk.
 *
 * A triage workqueue: review → status (New/In progress/Responded/
 * Resolved/Ignored) + assignee + tags + note, with AI-drafted localized
 * replies and channel-aware sending (real eBay RespondToFeedback;
 * Amazon/Shopify recorded as manual since they expose no reply API).
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so data MUST load client-side where the
 * fetch patch adds credentials. Server-side the stats fetch 401'd into
 * all-zero counters for everyone.
 */

import { useEffect, useState } from 'react'
import { Inbox } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsNav } from '../_shared/ReviewsNav'
import { ReviewLiveChip } from '../_shared/ReviewLiveChip'
import { DeskClient, type DeskStats, type DeskReview } from './DeskClient'

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

export default function ReviewDeskPage() {
  const [data, setData] = useState<{ stats: DeskStats; initial: { items: DeskReview[] } } | null>(null)

  useEffect(() => {
    let alive = true
    const backend = getBackendUrl()
    Promise.all([
      fetchJson<DeskStats>(`${backend}/api/reviews/desk/stats`, {
        counts: { NEW: 0, IN_PROGRESS: 0, RESPONDED: 0, RESOLVED: 0, IGNORED: 0 },
        open: 0,
        total: 0,
      }),
      fetchJson<{ items: DeskReview[] }>(
        `${backend}/api/reviews?triageStatus=NEW&limit=100`,
        { items: [] },
      ),
    ]).then(([stats, initial]) => {
      if (alive) setData({ stats, initial })
    })
    return () => { alive = false }
  }, [])

  return (
    <div className="px-4 py-4">
      <div className="flex items-start gap-3 mb-3">
        <Inbox className="h-6 w-6 text-blue-500 dark:text-blue-400 mt-0.5" />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Response Desk
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Triage every review and reply in one place. AI drafts an on-brand, localized reply;
            eBay replies post for real, Amazon/Shopify are recorded when you post them on-platform.
          </p>
        </div>
        <ReviewLiveChip />
      </div>

      <ReviewsNav />
      {data ? (
        <DeskClient initialStats={data.stats} initialReviews={data.initial.items} />
      ) : (
        <div aria-busy="true" className="mt-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-16 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
            ))}
          </div>
          <div className="h-40 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
        </div>
      )}
    </div>
  )
}
