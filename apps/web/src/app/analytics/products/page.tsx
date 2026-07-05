'use client'

/**
 * PA.4 — Portfolio Intelligence.
 *
 * Cross-catalog health ranking: all active products sorted by composite
 * health score (worst first). Surfaces which SKUs need attention —
 * low quality, stockout risk, no recent sales.
 *
 * Inventory-to-ad-spend ROAS table shows SKUs where ad spend is close
 * to or exceeding revenue contribution.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so data MUST load client-side where the
 * fetch patch adds credentials. Server-side this page 401'd into zeros for
 * everyone. The AL.3 `?source=` toggle still works: PortfolioClient pushes
 * the new query and the fetch effect below is keyed on it.
 */

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { BarChart2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { PortfolioClient } from './PortfolioClient'

interface PortfolioRow {
  id: string
  sku: string
  name: string
  brand: string | null
  healthScore: number
  qualityScore: number | null
  totalUnits30d: number
  totalRevenue30d: number
  totalAvailable: number
  daysOfInventory: number | null
  stockoutRisk: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'
  channelCount: number
  actionTags: string[]
}

interface RoasRow {
  sku: string
  revenue30d: number
  adSpend30d: number
  roas: number | null
}

interface PortfolioPayload {
  products: PortfolioRow[]
  roasTable: RoasRow[]
  total: number
  dataFreshness?: {
    source: 'live' | 'official'
    requestedSource: 'auto' | 'live' | 'official'
    lastDataAt: string | null
    label: string
  }
}

async function fetchPortfolio(source: string): Promise<PortfolioPayload> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/analytics/portfolio?limit=200&source=${encodeURIComponent(source)}`, {
      cache: 'no-store',
    })
    if (!res.ok) return { products: [], roasTable: [], total: 0 }
    return (await res.json()) as PortfolioPayload
  } catch {
    return { products: [], roasTable: [], total: 0 }
  }
}

function PortfolioPageInner() {
  // AL.3 — `?source=live|official|auto` (default auto: prefer official
  // T+1 Amazon report, fall back to live Order/OrderItem if empty).
  const searchParams = useSearchParams()
  const sourceParam = searchParams?.get('source')
  const source = sourceParam === 'live' || sourceParam === 'official' ? sourceParam : 'auto'
  const [data, setData] = useState<PortfolioPayload | null>(null)

  useEffect(() => {
    let alive = true
    fetchPortfolio(source).then((d) => {
      if (alive) setData(d)
    })
    return () => { alive = false }
  }, [source])

  if (!data) {
    return (
      <div className="px-4 py-4 max-w-6xl" aria-busy="true">
        <div className="flex items-start gap-3 mb-5">
          <BarChart2 className="h-6 w-6 text-violet-600 dark:text-violet-400 mt-0.5 shrink-0" />
          <div>
            <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
              Portfolio Intelligence
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              All active SKUs ranked by composite health score (quality × sales × stock).
              Products below 60 need attention. Sorted worst-first.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
          ))}
        </div>
        <div className="h-64 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
      </div>
    )
  }

  const needsAttention = data.products.filter((p) => p.healthScore < 60).length
  const stockoutHigh = data.products.filter((p) => p.stockoutRisk === 'HIGH').length
  const lowQuality = data.products.filter((p) => p.qualityScore != null && p.qualityScore < 60).length

  return (
    <div className="px-4 py-4 max-w-6xl">
      <div className="flex items-start gap-3 mb-5">
        <BarChart2 className="h-6 w-6 text-violet-600 dark:text-violet-400 mt-0.5 shrink-0" />
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Portfolio Intelligence
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            All active SKUs ranked by composite health score (quality × sales × stock).
            Products below 60 need attention. Sorted worst-first.
          </p>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Total products" value={data.total} />
        <Stat label="Needs attention" value={needsAttention} warn={needsAttention > 0} />
        <Stat label="Stockout risk HIGH" value={stockoutHigh} warn={stockoutHigh > 0} />
        <Stat label="Low quality (<60)" value={lowQuality} warn={lowQuality > 0} />
      </div>

      <PortfolioClient
        initialProducts={data.products}
        initialRoas={data.roasTable}
        dataFreshness={data.dataFreshness}
      />
    </div>
  )
}

export default function PortfolioPage() {
  return (
    <Suspense
      fallback={
        <div className="px-4 py-4 max-w-6xl" aria-busy="true">
          <div className="flex items-start gap-3 mb-5">
            <BarChart2 className="h-6 w-6 text-violet-600 dark:text-violet-400 mt-0.5 shrink-0" />
            <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
              Portfolio Intelligence
            </h1>
          </div>
        </div>
      }
    >
      <PortfolioPageInner />
    </Suspense>
  )
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${warn ? 'text-rose-700 dark:text-rose-400' : 'text-slate-900 dark:text-slate-100'}`}>
        {value}
      </div>
    </div>
  )
}
