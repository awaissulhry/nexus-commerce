'use client'

/**
 * RX.5 — Review action items (closed SR.3 loop).
 *
 * Spike-driven AI fixes (improved bullets, A+ modules, recall flags)
 * surfaced as an apply/dismiss workqueue.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so data MUST load client-side where the
 * fetch patch adds credentials. Server-side this page 401'd into an empty
 * workqueue (ActionsClient deliberately skips its initial load).
 */

import { useEffect, useState } from 'react'
import { Wrench } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsNav } from '../_shared/ReviewsNav'
import { ActionsClient, type ActionItem } from './ActionsClient'

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

export default function ReviewActionsPage() {
  const [items, setItems] = useState<ActionItem[] | null>(null)

  useEffect(() => {
    let alive = true
    fetchJson<{ items: ActionItem[] }>(
      `${getBackendUrl()}/api/reviews/action-items?status=OPEN&limit=200`,
      { items: [] },
    ).then((d) => {
      if (alive) setItems(d.items)
    })
    return () => { alive = false }
  }, [])

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
      {items ? (
        <ActionsClient initial={items} />
      ) : (
        <div aria-busy="true" className="mt-4 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
          ))}
        </div>
      )}
    </div>
  )
}
