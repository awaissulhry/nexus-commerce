'use client'

/**
 * RX.4 — AI Review Spotlight (Voice-of-Customer brief).
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so data MUST load client-side where the
 * fetch patch adds credentials. Server-side this page 401'd into an empty
 * "no spotlight" state.
 */

import { useEffect, useState } from 'react'
import { Lightbulb } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsNav } from '../_shared/ReviewsNav'
import { SpotlightClient, type Spotlight } from './SpotlightClient'

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

export default function SpotlightPage() {
  const [data, setData] = useState<{ spotlight: Spotlight | null } | null>(null)

  useEffect(() => {
    let alive = true
    fetchJson<{ spotlight: Spotlight | null }>(
      `${getBackendUrl()}/api/reviews/spotlight`,
      { spotlight: null },
    ).then((d) => {
      if (alive) setData(d)
    })
    return () => { alive = false }
  }, [])

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
      {data ? (
        <SpotlightClient initial={data.spotlight} />
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
