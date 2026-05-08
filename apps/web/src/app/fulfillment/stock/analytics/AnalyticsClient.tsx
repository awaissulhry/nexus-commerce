'use client'

/**
 * S.14 — Stock turnover + Days-of-Inventory analytics.
 *
 * Reads /api/stock/analytics/turnover. Surfaces:
 *   - Overall KPI strip (turnover ratio, DoH, COGS, inventory value)
 *   - Per-channel breakdown (sales by channel × marketplace)
 *   - Per-product table with sortable columns + colour-coded DoH
 *
 * Period selector: 7 / 30 / 90 / 180 / 365 days. The server caps the
 * request at 365 to keep the DailySalesAggregate scan bounded.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  TrendingDown, ArrowLeft, Package, RefreshCw, AlertCircle,
  TrendingUp, Boxes, Activity, AlertTriangle, Snowflake,
  BarChart3,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

type SortKey = 'turnover' | 'doh' | 'units' | 'value'

interface ProductRow {
  productId: string
  sku: string
  name: string
  amazonAsin: string | null
  thumbnailUrl: string | null
  unitsSold: number
  revenueCents: number
  costPriceCents: number
  totalStock: number
  currentInventoryValueCents: number
  cogsCents: number
  turnoverRatio: number | null
  daysOfInventory: number | null
}

interface ChannelRow {
  channel: string
  marketplace: string
  units: number
  revenueCents: number
  orders: number
}

interface TurnoverResponse {
  windowDays: number
  windowStart: string
  overall: {
    unitsSold: number
    cogsCents: number
    currentInventoryValueCents: number
    turnoverRatio: number | null
    daysOfInventory: number | null
    productsTracked: number
  }
  byProduct: ProductRow[]
  byChannel: ChannelRow[]
}

// S.15 — dead-stock + slow-moving rows.
interface DeadStockRow {
  productId: string
  sku: string
  name: string
  amazonAsin: string | null
  thumbnailUrl: string | null
  totalStock: number
  costPriceCents: number
  valueAtRiskCents: number
  unitsSoldInWindow: number
  dailyVelocity: number
  daysSinceLastMovement: number | null
  lastMovementReason: string | null
}
interface DeadStockResponse {
  windowDays: number
  slowVelocityThreshold: number
  dead: DeadStockRow[]
  slow: DeadStockRow[]
}

// S.16 — ABC snapshot.
interface AbcSample {
  productId: string
  sku: string
  name: string
  thumbnailUrl: string | null
  totalStock: number
  inventoryValueCents: number
}
interface AbcResponse {
  snapshotAt: string | null
  productsClassified: number
  counts: { A: number; B: number; C: number; D: number }
  samples: { A: AbcSample[]; B: AbcSample[]; C: AbcSample[]; D: AbcSample[] }
}

const PERIOD_OPTIONS = [7, 30, 90, 180, 365] as const

function formatCents(cents: number): string {
  const euros = cents / 100
  return `€${euros.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function dohTone(doh: number | null): string {
  if (doh == null) return 'text-slate-400'
  if (doh < 30) return 'text-emerald-700'      // healthy turnover
  if (doh < 90) return 'text-blue-700'         // acceptable
  if (doh < 180) return 'text-amber-700'       // slow
  return 'text-rose-700'                       // dead-stock candidate
}

export default function AnalyticsClient() {
  const { t } = useTranslations()
  const [data, setData] = useState<TurnoverResponse | null>(null)
  const [deadStock, setDeadStock] = useState<DeadStockResponse | null>(null)
  const [abc, setAbc] = useState<AbcResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState<number>(30)
  const [sortKey, setSortKey] = useState<SortKey>('turnover')
  // S.15 — dead-stock threshold defaults to 90 days (operator standard).
  const [deadDays, setDeadDays] = useState<number>(90)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Fire all analytics endpoints in parallel — turnover, dead-
      // stock, and ABC are independent and render on the same page.
      const [turnoverRes, deadRes, abcRes] = await Promise.all([
        fetch(`${getBackendUrl()}/api/stock/analytics/turnover?days=${days}`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/stock/analytics/dead-stock?days=${deadDays}`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/stock/analytics/abc`, { cache: 'no-store' }),
      ])
      if (!turnoverRes.ok) throw new Error(`turnover HTTP ${turnoverRes.status}`)
      setData(await turnoverRes.json())
      if (deadRes.ok) {
        setDeadStock(await deadRes.json())
      }
      if (abcRes.ok) {
        setAbc(await abcRes.json())
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [days, deadDays])

  useEffect(() => { fetchData() }, [fetchData])

  // Sort the per-product list according to the active column. We
  // always show products with sales first; products with zero sales
  // are sorted to the bottom (their DoH is null/Infinity).
  const sortedProducts = useMemo(() => {
    if (!data) return []
    const rows = [...data.byProduct]
    rows.sort((a, b) => {
      switch (sortKey) {
        case 'turnover':
          return (b.turnoverRatio ?? -1) - (a.turnoverRatio ?? -1)
        case 'doh': {
          // Lower DoH first (faster turnover); nulls last.
          const av = a.daysOfInventory ?? Number.POSITIVE_INFINITY
          const bv = b.daysOfInventory ?? Number.POSITIVE_INFINITY
          return av - bv
        }
        case 'units':
          return b.unitsSold - a.unitsSold
        case 'value':
          return b.currentInventoryValueCents - a.currentInventoryValueCents
      }
    })
    return rows
  }, [data, sortKey])

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('stock.analytics.title')}
        description={t('stock.analytics.description')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('stock.analytics.title') },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/fulfillment/stock"
              className="inline-flex items-center gap-1.5 h-11 sm:h-8 px-3 text-base text-slate-600 hover:text-slate-900"
            >
              <ArrowLeft size={14} /> {t('stock.title')}
            </Link>
            <Button variant="secondary" size="sm" onClick={fetchData} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              {t('stock.action.refresh')}
            </Button>
          </div>
        }
      />

      {/* Period selector */}
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-sm uppercase tracking-wider text-slate-500 font-semibold mr-2">
          {t('stock.analytics.period')}
        </span>
        {PERIOD_OPTIONS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDays(d)}
            className={cn(
              'min-h-[44px] sm:min-h-0 px-3 py-1 text-sm font-medium rounded border transition-colors',
              days === d
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300',
            )}
          >
            {d}d
          </button>
        ))}
      </div>

      {error && (
        <div className="text-base text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {loading && data === null && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i}>
              <div className="h-[68px] flex items-center justify-center text-base text-slate-400">…</div>
            </Card>
          ))}
        </div>
      )}

      {data && (
        <>
          {/* Overall KPI strip */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <Card>
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-md inline-flex items-center justify-center flex-shrink-0 bg-emerald-50 text-emerald-600">
                  <TrendingUp size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
                    {t('stock.analytics.kpi.turnover')}
                  </div>
                  <div className="text-[20px] font-semibold tabular-nums text-slate-900 mt-0.5">
                    {data.overall.turnoverRatio == null ? '—' : data.overall.turnoverRatio.toFixed(2)}×
                  </div>
                  <div className="text-sm text-slate-500 mt-0.5">
                    {t('stock.analytics.kpi.turnoverDetail', { days })}
                  </div>
                </div>
              </div>
            </Card>
            <Card>
              <div className="flex items-start gap-3">
                <div className={`w-9 h-9 rounded-md inline-flex items-center justify-center flex-shrink-0 bg-blue-50 ${dohTone(data.overall.daysOfInventory)}`}>
                  <Activity size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
                    {t('stock.analytics.kpi.doh')}
                  </div>
                  <div className={`text-[20px] font-semibold tabular-nums mt-0.5 ${dohTone(data.overall.daysOfInventory)}`}>
                    {data.overall.daysOfInventory == null ? '—' : `${data.overall.daysOfInventory}d`}
                  </div>
                  <div className="text-sm text-slate-500 mt-0.5">
                    {t('stock.analytics.kpi.dohDetail')}
                  </div>
                </div>
              </div>
            </Card>
            <Card>
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-md inline-flex items-center justify-center flex-shrink-0 bg-violet-50 text-violet-600">
                  <TrendingDown size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
                    {t('stock.analytics.kpi.cogs')}
                  </div>
                  <div className="text-[20px] font-semibold tabular-nums text-slate-900 mt-0.5">
                    {formatCents(data.overall.cogsCents)}
                  </div>
                  <div className="text-sm text-slate-500 mt-0.5">
                    {t('stock.analytics.kpi.cogsDetail', { units: data.overall.unitsSold.toLocaleString() })}
                  </div>
                </div>
              </div>
            </Card>
            <Card>
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-md inline-flex items-center justify-center flex-shrink-0 bg-slate-100 text-slate-600">
                  <Boxes size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
                    {t('stock.analytics.kpi.inventoryValue')}
                  </div>
                  <div className="text-[20px] font-semibold tabular-nums text-slate-900 mt-0.5">
                    {formatCents(data.overall.currentInventoryValueCents)}
                  </div>
                  <div className="text-sm text-slate-500 mt-0.5">
                    {t('stock.analytics.kpi.inventoryValueDetail', { n: data.overall.productsTracked.toLocaleString() })}
                  </div>
                </div>
              </div>
            </Card>
          </div>

          {/* Per-channel sales breakdown */}
          {data.byChannel.length > 0 && (
            <Card>
              <div className="text-md font-semibold text-slate-900 mb-3">{t('stock.analytics.byChannel.title')}</div>
              <ul className="divide-y divide-slate-100">
                {data.byChannel.map((ch) => (
                  <li key={`${ch.channel}_${ch.marketplace}`} className="flex items-center justify-between py-2">
                    <div className="inline-flex items-center gap-2">
                      <Badge variant="default" size="sm">{ch.channel}</Badge>
                      <span className="text-sm text-slate-500">{ch.marketplace}</span>
                    </div>
                    <div className="text-right text-sm">
                      <div className="font-semibold tabular-nums text-slate-900">
                        {ch.units.toLocaleString()} {t('stock.analytics.byChannel.units')}
                      </div>
                      <div className="text-slate-500">
                        {formatCents(ch.revenueCents)} · {ch.orders.toLocaleString()} {t('stock.analytics.byChannel.orders')}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* S.16 — ABC classification card. Pareto bands materialized
              weekly via the abc-classification cron. Snapshot freshness
              shown via snapshotAt. Empty state when never run. */}
          {abc && (
            <Card>
              <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                <div className="text-md font-semibold text-slate-900 inline-flex items-center gap-2">
                  <BarChart3 size={14} className="text-violet-500" />
                  {t('stock.abc.title')}
                </div>
                <div className="text-xs text-slate-500">
                  {abc.snapshotAt
                    ? t('stock.abc.snapshotAt', { when: new Date(abc.snapshotAt).toLocaleString() })
                    : t('stock.abc.notRun')}
                </div>
              </div>

              {abc.productsClassified === 0 ? (
                <div className="text-sm text-slate-500 italic py-3">
                  {t('stock.abc.empty')}
                </div>
              ) : (
                <>
                  {/* Band counts as a row of cards */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {(['A', 'B', 'C', 'D'] as const).map((cls) => {
                      const tone =
                        cls === 'A' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                        cls === 'B' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                        cls === 'C' ? 'bg-slate-50 text-slate-600 border-slate-200' :
                        'bg-rose-50 text-rose-700 border-rose-200'
                      return (
                        <div key={cls} className={`border rounded-md p-3 ${tone}`}>
                          <div className="text-xs uppercase tracking-wider font-semibold">
                            {t(`stock.abc.band.${cls}.label`)}
                          </div>
                          <div className="text-2xl font-bold tabular-nums mt-1">
                            {(abc.counts[cls] ?? 0).toLocaleString()}
                          </div>
                          <div className="text-xs mt-0.5 opacity-80">
                            {t(`stock.abc.band.${cls}.description`)}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  {/* Top samples per band — collapsed by default to one
                      row per band; the full per-band drill-down lives
                      in S.18 saved-views (filter by abcClass). */}
                  <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-500">
                    {t('stock.abc.totalClassified', { n: abc.productsClassified })}
                  </div>
                </>
              )}
            </Card>
          )}

          {/* S.15 — Dead-stock + slow-moving section. Sits between
              the channel rollup and the per-product turnover table.
              Two columns on lg+: Dead (left, no movement >= deadDays)
              and Slow (right, daily velocity below threshold). */}
          {deadStock && (deadStock.dead.length > 0 || deadStock.slow.length > 0) && (
            <Card>
              <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                <div className="text-md font-semibold text-slate-900 inline-flex items-center gap-2">
                  <Snowflake size={14} className="text-blue-500" />
                  {t('stock.deadStock.title')}
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="text-sm uppercase tracking-wider text-slate-500 font-semibold mr-1">
                    {t('stock.deadStock.threshold')}
                  </span>
                  {[30, 60, 90, 180].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDeadDays(d)}
                      className={cn(
                        'min-h-[44px] sm:min-h-0 px-2.5 py-1 text-sm font-medium rounded border transition-colors',
                        deadDays === d
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300',
                      )}
                    >
                      {d}d
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Dead stock column */}
                <div>
                  <div className="text-sm uppercase tracking-wider font-semibold text-rose-700 inline-flex items-center gap-1.5 mb-2">
                    <AlertTriangle size={12} />
                    {t('stock.deadStock.dead.title', { days: deadDays })}
                    <span className="text-slate-500 font-normal">· {deadStock.dead.length}</span>
                  </div>
                  {deadStock.dead.length === 0 ? (
                    <div className="text-sm text-slate-400 italic py-2">
                      {t('stock.deadStock.dead.empty')}
                    </div>
                  ) : (
                    <ul className="space-y-1 max-h-[420px] overflow-y-auto pr-1">
                      {deadStock.dead.slice(0, 50).map((p) => (
                        <li key={p.productId} className="flex items-center gap-2 py-1.5 px-2 -mx-2 border-b border-slate-100 last:border-0">
                          {p.thumbnailUrl ? (
                            <img src={p.thumbnailUrl} alt="" className="w-7 h-7 rounded object-cover bg-slate-100 flex-shrink-0" />
                          ) : (
                            <div className="w-7 h-7 rounded bg-slate-100 flex items-center justify-center text-slate-400 flex-shrink-0">
                              <Package size={12} />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-slate-900 truncate">{p.name}</div>
                            <div className="text-xs text-slate-500 font-mono truncate">
                              {p.sku} · {p.totalStock} on hand
                              {p.daysSinceLastMovement != null && (
                                <span className="text-rose-600"> · {p.daysSinceLastMovement}d ago</span>
                              )}
                              {p.daysSinceLastMovement == null && (
                                <span className="text-rose-600"> · {t('stock.deadStock.neverMoved')}</span>
                              )}
                            </div>
                          </div>
                          <div className="text-right text-sm tabular-nums flex-shrink-0">
                            <div className="font-semibold text-rose-700">
                              {formatCents(p.valueAtRiskCents)}
                            </div>
                            <div className="text-xs text-slate-400">{t('stock.deadStock.atRisk')}</div>
                          </div>
                        </li>
                      ))}
                      {deadStock.dead.length > 50 && (
                        <li className="text-xs text-slate-400 italic pt-1">
                          +{deadStock.dead.length - 50} {t('stock.analytics.byChannel.units')}
                        </li>
                      )}
                    </ul>
                  )}
                </div>

                {/* Slow-moving column */}
                <div>
                  <div className="text-sm uppercase tracking-wider font-semibold text-amber-700 inline-flex items-center gap-1.5 mb-2">
                    <TrendingDown size={12} />
                    {t('stock.deadStock.slow.title', { v: deadStock.slowVelocityThreshold })}
                    <span className="text-slate-500 font-normal">· {deadStock.slow.length}</span>
                  </div>
                  {deadStock.slow.length === 0 ? (
                    <div className="text-sm text-slate-400 italic py-2">
                      {t('stock.deadStock.slow.empty')}
                    </div>
                  ) : (
                    <ul className="space-y-1 max-h-[420px] overflow-y-auto pr-1">
                      {deadStock.slow.slice(0, 50).map((p) => (
                        <li key={p.productId} className="flex items-center gap-2 py-1.5 px-2 -mx-2 border-b border-slate-100 last:border-0">
                          {p.thumbnailUrl ? (
                            <img src={p.thumbnailUrl} alt="" className="w-7 h-7 rounded object-cover bg-slate-100 flex-shrink-0" />
                          ) : (
                            <div className="w-7 h-7 rounded bg-slate-100 flex items-center justify-center text-slate-400 flex-shrink-0">
                              <Package size={12} />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-slate-900 truncate">{p.name}</div>
                            <div className="text-xs text-slate-500 font-mono truncate">
                              {p.sku} · {p.totalStock} on hand · {p.dailyVelocity}/day
                            </div>
                          </div>
                          <div className="text-right text-sm tabular-nums flex-shrink-0">
                            <div className="font-semibold text-amber-700">
                              {formatCents(p.valueAtRiskCents)}
                            </div>
                            <div className="text-xs text-slate-400">{t('stock.deadStock.atRisk')}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {/* Recommended actions footer */}
              <div className="mt-4 pt-3 border-t border-slate-100 text-xs text-slate-500 leading-relaxed">
                <span className="font-semibold text-slate-700">{t('stock.deadStock.recommended.title')}: </span>
                {t('stock.deadStock.recommended.body')}
              </div>
            </Card>
          )}

          {/* Per-product breakdown */}
          {sortedProducts.length === 0 ? (
            <EmptyState
              icon={Activity}
              title={t('stock.analytics.empty.title')}
              description={t('stock.analytics.empty.description')}
              action={{ label: t('stock.title'), href: '/fulfillment/stock' }}
            />
          ) : (
            <Card noPadding>
              <div className="overflow-x-auto">
                <table className="w-full text-md">
                  <thead className="border-b border-slate-200 bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                        {t('stock.analytics.col.product')}
                      </th>
                      <th
                        className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 cursor-pointer hover:text-slate-900"
                        onClick={() => setSortKey('units')}
                      >
                        {t('stock.analytics.col.units')}{sortKey === 'units' && ' ↓'}
                      </th>
                      <th
                        className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 cursor-pointer hover:text-slate-900"
                        onClick={() => setSortKey('value')}
                      >
                        {t('stock.analytics.col.invValue')}{sortKey === 'value' && ' ↓'}
                      </th>
                      <th
                        className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 cursor-pointer hover:text-slate-900"
                        onClick={() => setSortKey('turnover')}
                      >
                        {t('stock.analytics.col.turnover')}{sortKey === 'turnover' && ' ↓'}
                      </th>
                      <th
                        className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 cursor-pointer hover:text-slate-900"
                        onClick={() => setSortKey('doh')}
                      >
                        {t('stock.analytics.col.doh')}{sortKey === 'doh' && ' ↑'}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedProducts.map((p) => (
                      <tr key={p.productId} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            {p.thumbnailUrl ? (
                              <img src={p.thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover bg-slate-100" />
                            ) : (
                              <div className="w-8 h-8 rounded bg-slate-100 flex items-center justify-center text-slate-400">
                                <Package size={14} />
                              </div>
                            )}
                            <div className="min-w-0">
                              <div className="text-md font-medium text-slate-900 truncate max-w-md">{p.name}</div>
                              <div className="text-sm text-slate-500 font-mono">
                                {p.sku}
                                {p.amazonAsin && <span> · {p.amazonAsin}</span>}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                          {p.unitsSold.toLocaleString()}
                          <div className="text-xs text-slate-400">{p.totalStock} on hand</div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                          {p.costPriceCents === 0 ? <span className="text-slate-300">—</span> : formatCents(p.currentInventoryValueCents)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                          {p.turnoverRatio == null ? <span className="text-slate-300">—</span> : `${p.turnoverRatio.toFixed(2)}×`}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums font-semibold ${dohTone(p.daysOfInventory)}`}>
                          {p.daysOfInventory == null ? '—' : `${p.daysOfInventory}d`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
