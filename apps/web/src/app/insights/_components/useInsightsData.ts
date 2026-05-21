'use client'

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import type { InsightsFilterState } from '@/components/insights'

export interface MarketplaceMetric {
  current: number
  previous: number
  deltaPct: number | null
}

export interface MarketplaceMetricsRow {
  channel: string
  marketplace: string
  currency: string
  revenue: MarketplaceMetric
  refunds: MarketplaceMetric
  netRevenue: MarketplaceMetric
  orders: MarketplaceMetric
  units: MarketplaceMetric
  aov: MarketplaceMetric
}

export interface InsightsSummary {
  window: { from: string; to: string }
  compare: { from: string; to: string } | null
  currency: string
  totals: {
    revenue: MarketplaceMetric
    refunds?: MarketplaceMetric
    netRevenue?: MarketplaceMetric
    orders: MarketplaceMetric
    units: MarketplaceMetric
    aov: MarketplaceMetric
  }
  byMarketplace: MarketplaceMetricsRow[]
  spark: Array<{ date: string; revenue: number; orders: number }>
}

export interface BreakdownBucket {
  key: string
  label: string
  revenue: number
  orders: number
  units: number
  deltaPct: number | null
}

export interface InsightsBreakdown {
  byChannel: BreakdownBucket[]
  byMarket: BreakdownBucket[]
  matrix: Array<{ channel: string; market: string; revenue: number; orders: number }>
  currency: string
}

export interface TopSKURow {
  sku: string
  productName: string | null
  brand: string | null
  revenue: number
  units: number
  orders: number
  deltaPct: number | null
  series: number[]
}

export interface InsightChange {
  id: string
  severity: 'positive' | 'attention' | 'critical' | 'info'
  headline: string
  detail?: string
  category: string
}

export interface InsightsHubData {
  summary: InsightsSummary | null
  breakdown: InsightsBreakdown | null
  topSkus: TopSKURow[]
  whatChanged: InsightChange[]
}

function filterParams(state: InsightsFilterState): URLSearchParams {
  const params = new URLSearchParams()
  if (state.window) params.set('window', state.window)
  if (state.from) params.set('from', state.from)
  if (state.to) params.set('to', state.to)
  if (state.compare) params.set('compare', state.compare)
  if (state.channels.length) params.set('channels', state.channels.join(','))
  if (state.markets.length) params.set('markets', state.markets.join(','))
  if (state.brands.length) params.set('brands', state.brands.join(','))
  return params
}

export function useInsightsHubData(
  filterState: InsightsFilterState,
  nonce: number,
): {
  data: InsightsHubData
  loading: boolean
  refreshing: boolean
  error: string | null
} {
  const [data, setData] = useState<InsightsHubData>({
    summary: null,
    breakdown: null,
    topSkus: [],
    whatChanged: [],
  })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const hadData = data.summary !== null
      if (hadData) setRefreshing(true)
      const params = filterParams(filterState).toString()
      const base = getBackendUrl()
      const endpoints = ['summary', 'breakdown', 'top-skus', 'what-changed'] as const
      try {
        const results = await Promise.all(
          endpoints.map(async (ep) => {
            const res = await fetch(`${base}/api/insights/${ep}?${params}`, {
              credentials: 'include',
            })
            if (!res.ok) throw new Error(`${ep}: HTTP ${res.status}`)
            return res.json()
          }),
        )
        if (cancelled) return
        setData({
          summary: results[0] as InsightsSummary,
          breakdown: results[1] as InsightsBreakdown,
          topSkus: (results[2] as { rows: TopSKURow[] }).rows ?? [],
          whatChanged: (results[3] as { items: InsightChange[] }).items ?? [],
        })
        setError(null)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filterState.window,
    filterState.from,
    filterState.to,
    filterState.compare,
    filterState.channels.join(','),
    filterState.markets.join(','),
    filterState.brands.join(','),
    nonce,
  ])

  return { data, loading, refreshing, error }
}
