/**
 * RX.2 — Review Response Desk.
 *
 * A triage workqueue: review → status (New/In progress/Responded/
 * Resolved/Ignored) + assignee + tags + note, with AI-drafted localized
 * replies and channel-aware sending (real eBay RespondToFeedback;
 * Amazon/Shopify recorded as manual since they expose no reply API).
 */

import { Inbox } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsNav } from '../_shared/ReviewsNav'
import { DeskClient, type DeskStats, type DeskReview } from './DeskClient'

export const dynamic = 'force-dynamic'

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

export default async function ReviewDeskPage() {
  const backend = getBackendUrl()
  const [stats, initial] = await Promise.all([
    fetchJson<DeskStats>(`${backend}/api/reviews/desk/stats`, {
      counts: { NEW: 0, IN_PROGRESS: 0, RESPONDED: 0, RESOLVED: 0, IGNORED: 0 },
      open: 0,
      total: 0,
    }),
    fetchJson<{ items: DeskReview[] }>(
      `${backend}/api/reviews?triageStatus=NEW&limit=100`,
      { items: [] },
    ),
  ])

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
      </div>

      <ReviewsNav />
      <DeskClient initialStats={stats} initialReviews={initial.items} />
    </div>
  )
}
