/**
 * RX.5 — Review action items (closed SR.3 loop).
 *
 * Spike-driven AI fixes (improved bullets, A+ modules, recall flags)
 * surfaced as an apply/dismiss workqueue.
 */

import { Wrench } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsNav } from '../_shared/ReviewsNav'
import { ActionsClient, type ActionItem } from './ActionsClient'

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

export default async function ReviewActionsPage() {
  const backend = getBackendUrl()
  const { items } = await fetchJson<{ items: ActionItem[] }>(
    `${backend}/api/reviews/action-items?status=OPEN&limit=200`,
    { items: [] },
  )

  return (
    <div className="px-4 py-4">
      <div className="flex items-start gap-3 mb-3">
        <Wrench className="h-6 w-6 text-blue-500 dark:text-blue-400 mt-0.5" />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Review Actions
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            When a review spike is detected, AI drafts the fix — improved listing bullets, an A+
            module, or a recall assessment. Apply or dismiss each one here. Generate fixes from the
            Spikes tab.
          </p>
        </div>
      </div>

      <ReviewsNav />
      <ActionsClient initial={items} />
    </div>
  )
}
