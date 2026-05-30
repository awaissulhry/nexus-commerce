/**
 * RX.4 — AI Review Spotlight (Voice-of-Customer brief).
 */

import { Lightbulb } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsNav } from '../_shared/ReviewsNav'
import { SpotlightClient, type Spotlight } from './SpotlightClient'

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

export default async function SpotlightPage() {
  const backend = getBackendUrl()
  const { spotlight } = await fetchJson<{ spotlight: Spotlight | null }>(
    `${backend}/api/reviews/spotlight`,
    { spotlight: null },
  )

  return (
    <div className="px-4 py-4">
      <div className="flex items-start gap-3 mb-3">
        <Lightbulb className="h-6 w-6 text-amber-500 dark:text-amber-400 mt-0.5" />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Review Spotlight
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            An AI Voice-of-Customer brief: what customers love, what they complain about, what&apos;s
            emerging, and concrete actions to take — synthesized across your recent reviews.
          </p>
        </div>
      </div>

      <ReviewsNav />
      <SpotlightClient initial={spotlight} />
    </div>
  )
}
