'use client'

/**
 * UM-series (P14) — client-side data loader for cross-channel analytics.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so the server-side fetch 401'd and the
 * page rendered all-zero rollups. Data MUST load client-side where the
 * fetch patch adds credentials.
 */

import { useEffect, useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { AnalyticsClient, type AnalyticsData } from './AnalyticsClient'
import { getBackendUrl } from '@/lib/backend-url'

const EMPTY: AnalyticsData = {
  from: '', to: '', attributionNote: '',
  totals: { spendEurCents: 0, salesCents: 0, impressions: 0, clicks: 0, orders7d: 0 },
  byChannel: [], byMarketplace: [], daily: [],
}

export function AnalyticsLoader() {
  const [data, setData] = useState<AnalyticsData | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      let next = EMPTY
      try {
        const res = await fetch(`${getBackendUrl()}/api/marketing/os/analytics`, { cache: 'no-store' })
        if (res.ok) next = await res.json()
      } catch {
        // empty
      }
      if (alive) setData(next)
    }
    void load()
    return () => { alive = false }
  }, [])

  if (!data) {
    return (
      <div className="p-4 sm:p-6 max-w-[1400px] mx-auto" aria-busy="true">
        <header className="mb-4">
          <div className="flex items-center gap-2"><BarChart3 size={20} className="text-blue-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Cross-channel analytics</h1></div>
        </header>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 rounded-lg border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
          ))}
        </div>
      </div>
    )
  }
  return <AnalyticsClient initial={data} />
}
