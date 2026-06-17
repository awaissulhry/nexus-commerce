'use client'

import Link from 'next/link'
import { useCallback, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useInsightsLiveRefresh } from './useInsightsLiveRefresh'
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Bookmark,
  Calculator,
  Database,
  Download,
  LineChart,
  Megaphone,
  MonitorPlay,
  Package,
  Receipt,
  ShoppingCart,
  Sparkles,
  TableProperties,
  Truck,
  Users,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import {
  InsightsHeader,
  KPICard,
  TrendChart,
  formatCurrency,
  formatNum,
  readFilterState,
  trendColor,
} from '@/components/insights'
import type { InsightsFilterState } from '@/components/insights'
import { useInsightsHubData } from './useInsightsData'
import { ChannelSplitWidget } from './ChannelSplitWidget'
import { MarketSplitWidget } from './MarketSplitWidget'
import { MarketplaceMatrixWidget } from './MarketplaceMatrixWidget'
import { TopSKUsWidget } from './TopSKUsWidget'
import { WhatChangedWidget } from './WhatChangedWidget'
import { MarketIngestHealth } from '@/components/dashboard/MarketIngestHealth'

const HUB_LINKS: Array<{
  href: string
  title: string
  blurb: string
  icon: typeof BarChart3
  phase: string
}> = [
  {
    href: '/insights/sales',
    title: 'Sales reports',
    blurb: 'Revenue trends, channel/market splits, Pareto SKUs',
    icon: ShoppingCart,
    phase: 'IH.2',
  },
  {
    href: '/insights/profit',
    title: 'Profit & cost',
    blurb: 'P&L waterfall, COGS, margin, fee detail',
    icon: Receipt,
    phase: 'IH.3',
  },
  {
    href: '/insights/advertising',
    title: 'Advertising',
    blurb: 'Impressions, ACoS, TACoS, search terms',
    icon: Megaphone,
    phase: 'IH.4',
  },
  {
    href: '/insights/products',
    title: 'Product performance',
    blurb: 'Best/worst sellers, lifecycle, buy box',
    icon: Package,
    phase: 'IH.5',
  },
  {
    href: '/insights/customers',
    title: 'Customer insights',
    blurb: 'RFM segments, LTV, cohort retention',
    icon: Users,
    phase: 'IH.6',
  },
  {
    href: '/insights/inventory',
    title: 'Inventory & fulfillment',
    blurb: 'Value, turnover, dead stock, stockout cost',
    icon: Truck,
    phase: 'IH.7',
  },
  {
    href: '/insights/fiscal',
    title: 'Italian fiscal',
    blurb: 'IVA, OSS, intrastat, settlement reconciliation',
    icon: Receipt,
    phase: 'IH.8',
  },
  {
    href: '/insights/brief',
    title: 'AI executive brief',
    blurb: 'Daily narrative, anomalies, recommended actions',
    icon: Sparkles,
    phase: 'IH.11',
  },
  {
    href: '/insights/forecast',
    title: 'Forecast & projections',
    blurb: '90-day demand forecast, projected stockouts, accuracy MAPE',
    icon: LineChart,
    phase: 'IH.17',
  },
  {
    href: '/insights/anomalies',
    title: 'Anomalies',
    blurb: 'Z-score deviations vs 90-day reference',
    icon: AlertTriangle,
    phase: 'IH.9',
  },
  {
    href: '/insights/scenarios',
    title: 'What-if scenarios',
    blurb: 'Project revenue / profit under pricing + ad changes',
    icon: Calculator,
    phase: 'IH.10',
  },
  {
    href: '/insights/builder',
    title: 'Report builder',
    blurb: 'Pivot any metric × dimension; save + export',
    icon: TableProperties,
    phase: 'IH.12',
  },
  {
    href: '/insights/exports',
    title: 'Export hub',
    blurb: 'CSV downloads for every report + bundle all',
    icon: Download,
    phase: 'IH.13',
  },
  {
    href: '/insights/live',
    title: 'Live monitor (TV mode)',
    blurb: 'Today vs yesterday, auto-refreshing',
    icon: MonitorPlay,
    phase: 'IH.14',
  },
  {
    href: '/insights/notebook',
    title: 'Notebook',
    blurb: 'Annotate dates with operator notes — context layer',
    icon: Bookmark,
    phase: 'IH.15',
  },
  {
    href: '/insights/amazon-reports',
    title: 'Amazon Reports',
    blurb: 'Every Amazon feed mirrored in Nexus — source + freshness',
    icon: Database,
    phase: 'R0.3',
  },
]

export default function InsightsLanding() {
  const params = useSearchParams()
  const filterState: InsightsFilterState = readFilterState(
    new URLSearchParams(params?.toString() ?? ''),
  )
  const [nonce, setNonce] = useState(0)
  // AL.1 — live refresh on order events (debounced 2s)
  const bumpNonce = useCallback(() => setNonce((n) => n + 1), [])
  useInsightsLiveRefresh(bumpNonce)
  const { data, loading, refreshing, error } = useInsightsHubData(
    filterState,
    nonce,
  )

  const summary = data.summary
  const currency = summary?.currency ?? 'EUR'

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <InsightsHeader
        title="Insights"
        description="Sales, profit, advertising, products, customers — unified across channels and markets."
        filterState={filterState}
        refreshing={refreshing}
        onRefresh={() => setNonce((n) => n + 1)}
      />

      {error && (
        <div className="mb-4 rounded-md border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <KPICard
          label="Revenue"
          value={
            summary
              ? formatCurrency(summary.totals.revenue.current, currency)
              : loading
                ? '…'
                : '—'
          }
          deltaPct={summary?.totals.revenue.deltaPct ?? null}
          series={summary?.spark.map((p) => p.revenue)}
          accent="emerald"
        />
        <KPICard
          label="Orders"
          value={
            summary ? formatNum(summary.totals.orders.current) : loading ? '…' : '—'
          }
          deltaPct={summary?.totals.orders.deltaPct ?? null}
          series={summary?.spark.map((p) => p.orders)}
          accent="blue"
        />
        <KPICard
          label="Units sold"
          value={
            summary ? formatNum(summary.totals.units.current) : loading ? '…' : '—'
          }
          deltaPct={summary?.totals.units.deltaPct ?? null}
          accent="violet"
        />
        <KPICard
          label="AOV"
          value={
            summary
              ? formatCurrency(summary.totals.aov.current, currency)
              : loading
                ? '…'
                : '—'
          }
          deltaPct={summary?.totals.aov.deltaPct ?? null}
          accent="amber"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-3">
        <div className="lg:col-span-2">
          <Card
            title="Revenue & orders trend"
            description={
              summary
                ? `${new Date(summary.window.from).toLocaleDateString('it-IT')} → ${new Date(summary.window.to).toLocaleDateString('it-IT')}`
                : undefined
            }
            noPadding
          >
            <div className="p-4">
              {summary && summary.spark.length > 0 ? (
                <TrendChart
                  data={summary.spark.map((p) => ({
                    date: p.date,
                    revenue: p.revenue,
                    orders: p.orders,
                  }))}
                  series={[
                    {
                      key: 'revenue',
                      label: 'Revenue',
                      color: trendColor(0),
                      format: 'currency',
                    },
                    {
                      key: 'orders',
                      label: 'Orders',
                      color: trendColor(1),
                      dashed: true,
                      format: 'number',
                      yAxisId: 'right',
                    },
                  ]}
                  currency={currency}
                  variant="area"
                  height={260}
                  rightAxisFormat="number"
                />
              ) : (
                <div className="h-[260px] flex items-center justify-center text-slate-400 text-sm">
                  {loading ? 'Loading…' : 'No data for this window'}
                </div>
              )}
            </div>
          </Card>
        </div>
        <WhatChangedWidget items={data.whatChanged} loading={loading} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
        <ChannelSplitWidget breakdown={data.breakdown} loading={loading} />
        <MarketSplitWidget breakdown={data.breakdown} loading={loading} />
      </div>

      {summary && summary.byMarketplace.length > 0 && (
        <div className="mb-3">
          <MarketplaceMatrixWidget
            rows={summary.byMarketplace}
            loading={loading}
          />
        </div>
      )}

      <div className="mb-5">
        <TopSKUsWidget rows={data.topSkus} currency={currency} loading={loading} />
      </div>

      <div>
        <h2 className="text-md font-semibold text-slate-900 dark:text-slate-100 mb-3">
          Reports
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {HUB_LINKS.map((link) => {
            const Icon = link.icon
            return (
              <Link
                key={link.href}
                href={link.href}
                className="group rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 hover:border-slate-300 dark:hover:border-slate-700 hover:shadow-sm transition flex flex-col gap-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                    <Icon className="w-4 h-4" />
                  </div>
                  <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 dark:text-slate-500">
                    {link.phase}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {link.title}
                  <ArrowRight className="w-3.5 h-3.5 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition" />
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {link.blurb}
                </div>
              </Link>
            )
          })}
        </div>
      </div>

      {/* MS.7 — operational health (per-marketplace ingest status).
          Lives below the hub navigation since it's infrastructure
          signal, not business insight. Collapsed by default. */}
      <div className="mt-6">
        <MarketIngestHealth />
      </div>
    </div>
  )
}
