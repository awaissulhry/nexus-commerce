'use client'

import { useCallback, useEffect, useState } from 'react'
import { useInsightsLiveRefresh } from '../../_components/useInsightsLiveRefresh'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import {
  BreakdownBar,
  BreakdownPie,
  InsightsHeader,
  KPICard,
  TableWithSparkline,
  TrendChart,
  formatCurrency,
  formatNum,
  formatPct,
  readFilterState,
  trendColor,
  type InsightsFilterState,
  type TableColumn,
} from '@/components/insights'
import { getBackendUrl } from '@/lib/backend-url'

interface AdBucket {
  key: string
  label: string
  spend: number
  sales: number
  impressions: number
  clicks: number
  orders: number
  ctr: number | null
  cpc: number | null
  acos: number | null
  roas: number | null
  deltaSpendPct: number | null
}

interface AdCampaignRow {
  campaignId: string
  campaignName: string | null
  adProduct: string
  marketplace: string
  spend: number
  sales: number
  impressions: number
  clicks: number
  orders: number
  acos: number | null
  roas: number | null
  ctr: number | null
  cpc: number | null
}

interface AdTrendPoint {
  date: string
  spend: number
  sales: number
  impressions: number
  clicks: number
  acos: number | null
}

interface AdReport {
  window: { from: string; to: string }
  compare: { from: string; to: string } | null
  currency: string
  totals: {
    spend: number
    sales: number
    impressions: number
    clicks: number
    orders: number
    ctr: number | null
    cpc: number | null
    acos: number | null
    roas: number | null
    tacos: number | null
    ntbOrders: number
  }
  totalsPrev: {
    spend: number
    sales: number
    impressions: number
    clicks: number
    orders: number
    acos: number | null
    roas: number | null
  }
  deltas: {
    spend: number | null
    sales: number | null
    impressions: number | null
    clicks: number | null
    orders: number | null
  }
  trend: AdTrendPoint[]
  byAdProduct: AdBucket[]
  byMarketplace: AdBucket[]
  topCampaigns: AdCampaignRow[]
}

function buildQuery(state: InsightsFilterState): URLSearchParams {
  const p = new URLSearchParams()
  if (state.window) p.set('window', state.window)
  if (state.from) p.set('from', state.from)
  if (state.to) p.set('to', state.to)
  if (state.compare) p.set('compare', state.compare)
  if (state.channels.length) p.set('channels', state.channels.join(','))
  if (state.markets.length) p.set('markets', state.markets.join(','))
  if (state.brands.length) p.set('brands', state.brands.join(','))
  return p
}

export default function AdvertisingClient() {
  const params = useSearchParams()
  const filterState = readFilterState(
    new URLSearchParams(params?.toString() ?? ''),
  )
  const [report, setReport] = useState<AdReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  // AL.1 — live refresh on order events (debounced 2s)
  const bumpNonce = useCallback(() => setNonce((n) => n + 1), [])
  useInsightsLiveRefresh(bumpNonce)

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (report) setRefreshing(true)
      try {
        const qs = buildQuery(filterState).toString()
        const res = await fetch(
          `${getBackendUrl()}/api/insights/advertising?${qs}`,
          { credentials: 'include' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json: AdReport = await res.json()
        if (!cancelled) {
          setReport(json)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed')
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

  const currency = report?.currency ?? 'EUR'

  function downloadCsv() {
    const qs = buildQuery(filterState)
    qs.set('format', 'csv')
    window.open(
      `${getBackendUrl()}/api/insights/advertising?${qs.toString()}`,
      '_blank',
    )
  }

  const campaignColumns: TableColumn<AdCampaignRow>[] = [
    {
      key: 'name',
      label: 'Campaign',
      align: 'left',
      accessor: (r) => (
        <span
          className="block truncate max-w-[320px]"
          title={r.campaignName ?? r.campaignId}
        >
          {r.campaignName ?? r.campaignId}
        </span>
      ),
      format: 'text',
    },
    {
      key: 'adProduct',
      label: 'Type',
      align: 'left',
      accessor: (r) =>
        r.adProduct
          .replace('SPONSORED_', '')
          .toLowerCase()
          .replace(/^./, (s) => s.toUpperCase()),
      format: 'text',
      width: '90px',
    },
    {
      key: 'marketplace',
      label: 'Mkt',
      align: 'center',
      accessor: (r) => r.marketplace,
      format: 'text',
      width: '50px',
    },
    {
      key: 'impressions',
      label: 'Impr',
      align: 'right',
      accessor: (r) => r.impressions,
      format: 'number',
    },
    {
      key: 'clicks',
      label: 'Clicks',
      align: 'right',
      accessor: (r) => r.clicks,
      format: 'number',
    },
    {
      key: 'ctr',
      label: 'CTR',
      align: 'right',
      accessor: (r) => (r.ctr == null ? null : r.ctr * 100),
      format: 'percent',
      width: '70px',
    },
    {
      key: 'spend',
      label: 'Spend',
      align: 'right',
      accessor: (r) => r.spend,
      format: 'currency',
    },
    {
      key: 'sales',
      label: 'Sales',
      align: 'right',
      accessor: (r) => r.sales,
      format: 'currency',
    },
    {
      key: 'orders',
      label: 'Orders',
      align: 'right',
      accessor: (r) => r.orders,
      format: 'number',
      width: '70px',
    },
    {
      key: 'acos',
      label: 'ACoS',
      align: 'right',
      accessor: (r) => r.acos,
      format: 'percent',
      width: '70px',
    },
    {
      key: 'roas',
      label: 'ROAS',
      align: 'right',
      accessor: (r) =>
        r.roas == null ? '—' : (
          <span className="tabular-nums">{r.roas.toFixed(2)}x</span>
        ),
      format: 'text',
      width: '70px',
    },
  ]

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="mb-2">
        <Link
          href="/insights"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
        >
          <ChevronLeft className="w-3 h-3" />
          Insights
        </Link>
      </div>
      <InsightsHeader
        title="Advertising"
        description="Impressions, ACoS, TACoS and campaign performance across Sponsored Products/Brands/Display."
        filterState={filterState}
        refreshing={refreshing}
        onRefresh={() => setNonce((n) => n + 1)}
        onExport={downloadCsv}
        exportLabel="Export CSV"
      />

      {error && (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 mb-5">
        <KPICard
          label="Ad spend"
          value={
            report ? formatCurrency(report.totals.spend, currency) : loading ? '…' : '—'
          }
          deltaPct={report?.deltas.spend ?? null}
          invertDelta
          accent="violet"
        />
        <KPICard
          label="Attributed sales"
          value={
            report ? formatCurrency(report.totals.sales, currency) : loading ? '…' : '—'
          }
          deltaPct={report?.deltas.sales ?? null}
          accent="emerald"
        />
        <KPICard
          label="Impressions"
          value={report ? formatNum(report.totals.impressions) : loading ? '…' : '—'}
          deltaPct={report?.deltas.impressions ?? null}
          accent="blue"
        />
        <KPICard
          label="Clicks"
          value={report ? formatNum(report.totals.clicks) : loading ? '…' : '—'}
          deltaPct={report?.deltas.clicks ?? null}
          accent="blue"
        />
        <KPICard
          label="CTR"
          value={
            report?.totals.ctr != null
              ? formatPct(report.totals.ctr * 100)
              : loading
                ? '…'
                : '—'
          }
          accent="slate"
        />
        <KPICard
          label="ACoS"
          value={report?.totals.acos != null ? formatPct(report.totals.acos) : loading ? '…' : '—'}
          accent="amber"
          secondary={
            report?.totals.tacos != null
              ? `TACoS ${formatPct(report.totals.tacos)}`
              : undefined
          }
          invertDelta
        />
        <KPICard
          label="ROAS"
          value={
            report?.totals.roas != null
              ? `${report.totals.roas.toFixed(2)}x`
              : loading
                ? '…'
                : '—'
          }
          accent="emerald"
        />
        <KPICard
          label="Ad-driven orders"
          value={report ? formatNum(report.totals.orders) : loading ? '…' : '—'}
          deltaPct={report?.deltas.orders ?? null}
          accent="blue"
          secondary={
            report ? `${formatNum(report.totals.ntbOrders)} NTB` : undefined
          }
        />
      </div>

      <Card
        title="Spend vs attributed sales"
        description="Daily trend with ACoS overlay"
        className="mb-3"
        noPadding
      >
        <div className="p-4">
          {report && report.trend.length > 0 ? (
            <TrendChart
              data={report.trend.map((p) => ({
                date: p.date,
                spend: p.spend,
                sales: p.sales,
                acos: p.acos ?? 0,
              }))}
              series={[
                {
                  key: 'spend',
                  label: 'Spend',
                  color: trendColor(4),
                  format: 'currency',
                },
                {
                  key: 'sales',
                  label: 'Sales',
                  color: trendColor(0),
                  format: 'currency',
                },
                {
                  key: 'acos',
                  label: 'ACoS %',
                  color: trendColor(2),
                  dashed: true,
                  format: 'number',
                  yAxisId: 'right',
                },
              ]}
              variant="area"
              currency={currency}
              height={280}
              rightAxisFormat="percent"
            />
          ) : (
            <div className="h-[280px] flex items-center justify-center text-tertiary text-sm">
              {loading ? 'Loading…' : 'No advertising data in this window'}
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
        <Card title="By ad product" description="SP / SB / SD / STV mix">
          {report && report.byAdProduct.length > 0 ? (
            <BreakdownPie
              entries={report.byAdProduct.map((b) => ({
                key: b.key,
                label: b.label,
                value: b.spend,
              }))}
              variant="donut"
              currency={currency}
              height={220}
              centerLabel="Ad spend"
              centerValue={formatCurrency(report.totals.spend, currency)}
            />
          ) : (
            <div className="h-[220px] flex items-center justify-center text-tertiary text-sm">
              {loading ? 'Loading…' : 'No data'}
            </div>
          )}
        </Card>
        <Card title="By marketplace" description="Where the spend lands">
          {report && report.byMarketplace.length > 0 ? (
            <BreakdownBar
              entries={report.byMarketplace.map((b) => ({
                key: b.key,
                label: b.label,
                value: b.spend,
                delta: b.deltaSpendPct,
              }))}
              currency={currency}
              total={report.totals.spend}
            />
          ) : (
            <div className="h-[220px] flex items-center justify-center text-tertiary text-sm">
              {loading ? 'Loading…' : 'No data'}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Top campaigns"
        description="Sorted by spend, top 50"
      >
        {report ? (
          <TableWithSparkline
            rows={report.topCampaigns}
            columns={campaignColumns}
            currency={currency}
            rowKey={(r) => r.campaignId}
            dense
            emptyLabel="No campaign data in this window"
          />
        ) : (
          <div className="text-sm text-tertiary py-6 text-center">
            {loading ? 'Loading…' : 'No data'}
          </div>
        )}
      </Card>
    </div>
  )
}
