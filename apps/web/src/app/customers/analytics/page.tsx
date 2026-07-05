'use client'

/**
 * CI.3 — Customer Analytics Dashboard.
 *
 * Cross-customer aggregate KPIs: total, B2B/B2C split, LTV percentiles,
 * repeat rate, RFM distribution heatmap, channel concentration.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so data MUST load client-side where the
 * fetch patch adds credentials. Server-side this page 401'd into the
 * "Failed to load" state for everyone.
 */

import { useEffect, useState } from 'react'
import { Users } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { CustomerAnalyticsClient } from './CustomerAnalyticsClient'

interface Overview {
  totalCustomers: number
  b2bCount: number
  b2cCount: number
  unknownCount: number
  newLast30d: number
  atRiskCount: number
  lostCount: number
  championCount: number
  repeatRate: number
  avgOrderFrequency: number
  ltvPercentiles: { p10: number; p25: number; p50: number; p75: number; p90: number }
  rfmDistribution: Record<string, number>
  topChannels: Array<{ channel: string; customerCount: number }>
}

async function fetchOverview(): Promise<Overview | null> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/customers/analytics/overview`, {
      cache: 'no-store',
    })
    if (!res.ok) return null
    return (await res.json()) as Overview
  } catch {
    return null
  }
}

async function fetchRFM() {
  try {
    const res = await fetch(`${getBackendUrl()}/api/customers/analytics/rfm`, {
      cache: 'no-store',
    })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

function PageHeader() {
  return (
    <div className="flex items-start gap-3 mb-5">
      <Users className="h-6 w-6 text-violet-600 dark:text-violet-400 mt-0.5 shrink-0" />
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Customer Analytics
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
          Cross-customer intelligence: LTV distribution, RFM segmentation, repeat rate, and channel concentration.
        </p>
      </div>
    </div>
  )
}

export default function CustomerAnalyticsPage() {
  const [data, setData] = useState<{ overview: Overview | null } | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([fetchOverview(), fetchRFM()]).then(([overview]) => {
      if (alive) setData({ overview })
    })
    return () => { alive = false }
  }, [])

  if (!data) {
    return (
      <div className="px-4 py-4 max-w-5xl" aria-busy="true">
        <PageHeader />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
          ))}
        </div>
        <div className="h-64 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
      </div>
    )
  }

  const { overview } = data

  if (!overview) {
    return (
      <div className="px-4 py-8 text-center text-slate-500 text-sm">
        Failed to load customer analytics. Check API connection.
      </div>
    )
  }

  const b2bPct = overview.totalCustomers > 0
    ? Math.round(overview.b2bCount / overview.totalCustomers * 100)
    : 0

  return (
    <div className="px-4 py-4 max-w-5xl">
      <PageHeader />

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Total customers" value={overview.totalCustomers.toLocaleString()} />
        <Stat label="B2B" value={`${overview.b2bCount} (${b2bPct}%)`} />
        <Stat label="Repeat rate" value={`${Math.round(overview.repeatRate * 100)}%`} />
        <Stat label="New (30d)" value={overview.newLast30d.toString()} />
      </div>

      {/* Alert strip */}
      {(overview.atRiskCount > 0 || overview.lostCount > 0) && (
        <div className="grid grid-cols-2 gap-3 mb-5">
          {overview.atRiskCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900">
              <span className="text-xs text-amber-800 dark:text-amber-300">
                {overview.atRiskCount} customers at risk of churning
              </span>
            </div>
          )}
          {overview.lostCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900">
              <span className="text-xs text-rose-800 dark:text-rose-300">
                {overview.lostCount} customers likely lost
              </span>
            </div>
          )}
        </div>
      )}

      <CustomerAnalyticsClient overview={overview} />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">{value}</div>
    </div>
  )
}
