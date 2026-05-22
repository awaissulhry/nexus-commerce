'use client'

/**
 * S.14 — Stock turnover + Days-of-Inventory analytics.
 *
 * S.A — per-product turnover table and EOQ table migrated to
 * SharedVirtualizedGrid, matching the density/sort UX of the rest of
 * the /fulfillment/stock section.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  TrendingDown, ArrowLeft, Package, RefreshCw, AlertCircle,
  TrendingUp, Boxes, Activity, AlertTriangle, Snowflake,
  BarChart3, Calculator, Check,
} from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import PageHeader from '@/components/layout/PageHeader'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { AbcBadge } from '@/components/inventory/AbcBadge'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { useOrderEventsRefresh } from '@/hooks/use-order-events-refresh'
import { useListingEvents } from '@/lib/sync/use-listing-events'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'
import { DensityToggle, GridToolbar, VirtualizedGrid, GridFooter } from '@/app/_shared/grid-lens'
import type { GridLensColumn, GridLensRow } from '@/app/_shared/grid-lens'
import { type Density, DENSITY_CELL_CLASS } from '@/lib/products/theme'

// ── Types ─────────────────────────────────────────────────────────────

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

interface EoqRecommendation {
  stockLevelId: string
  productId: string
  sku: string
  name: string
  amazonAsin: string | null
  thumbnailUrl: string | null
  location: { id: string; code: string; name: string; type: string }
  currentQuantity: number
  currentReorderThreshold: number | null
  currentReorderQuantity: number | null
  inputs: {
    unitsSoldInWindow: number
    annualDemand: number
    dailyDemand: number
    costCents: number
    orderCostCents: number
    carryingPct: number
    annualHoldingCostCents: number
    leadTimeDays: number
    serviceLevel: number
    z: number
    stddev: number
  }
  recommendation: {
    eoq: number | null
    rop: number | null
    safetyStock: number
  }
}
interface EoqResponse {
  windowDays: number
  generatedAt: string
  recommendations: EoqRecommendation[]
}

// ── GridLens row types ─────────────────────────────────────────────────

type AnalyticsGridRow = ProductRow & GridLensRow
type EoqGridRow = EoqRecommendation & GridLensRow

// ── GridLens column definitions ────────────────────────────────────────

const ANALYTICS_COLUMNS: GridLensColumn[] = [
  { key: 'thumb',    label: '',            width: 60,  locked: true },
  { key: 'product',  label: 'Product',     subLabel: 'SKU · ASIN', width: 300, locked: true },
  { key: 'units',    label: 'Units Sold',  subLabel: 'In period',  width: 100 },
  { key: 'onHand',   label: 'On Hand',     subLabel: 'Current',    width: 90  },
  { key: 'invValue', label: 'Inv. Value',  subLabel: '€ cost×qty', width: 110 },
  { key: 'turnover', label: 'Turnover',    subLabel: 'Ratio',      width: 100 },
  { key: 'doh',      label: 'DoH',         subLabel: 'Days of inv',width: 90  },
]

const ANALYTICS_SORT_KEYS: Record<string, string> = {
  units: 'units', onHand: 'onHand', invValue: 'invValue', turnover: 'turnover', doh: 'doh',
}

const EOQ_COLUMNS: GridLensColumn[] = [
  { key: 'product',    label: 'Product',      subLabel: 'SKU',       width: 280, locked: true },
  { key: 'location',   label: 'Location',     subLabel: 'Code',      width: 90  },
  { key: 'demand',     label: 'Demand',        subLabel: 'Units·/day',width: 110 },
  { key: 'currentRop', label: 'Current ROP',  subLabel: 'Threshold', width: 110 },
  { key: 'recRop',     label: 'Rec. ROP',     subLabel: 'Suggested', width: 110 },
  { key: 'recEoq',     label: 'Rec. EOQ',     subLabel: 'Order qty', width: 110 },
  { key: 'apply',      label: '',                                     width: 90  },
]

// ── Constants ──────────────────────────────────────────────────────────

const PERIOD_OPTIONS = [7, 30, 90, 180, 365] as const
const STORAGE_KEY_ANALYTICS = 'stock-analytics'
const STORAGE_KEY_EOQ = 'stock-analytics-eoq'
const _EMPTY_SET = new Set<string>()
const _NOOP = () => {}

// ── Helpers ────────────────────────────────────────────────────────────

function formatCents(cents: number): string {
  return `€${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function dohTone(doh: number | null): string {
  if (doh == null) return 'text-slate-400'
  if (doh < 30)  return 'text-emerald-700'
  if (doh < 90)  return 'text-blue-700'
  if (doh < 180) return 'text-amber-700'
  return 'text-rose-700'
}

// ── Component ──────────────────────────────────────────────────────────

export default function AnalyticsClient() {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [data, setData]         = useState<TurnoverResponse | null>(null)
  const [deadStock, setDeadStock] = useState<DeadStockResponse | null>(null)
  const [abc, setAbc]           = useState<AbcResponse | null>(null)
  const [eoq, setEoq]           = useState<EoqResponse | null>(null)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [days, setDays]         = useState<number>(30)
  const [deadDays, setDeadDays] = useState<number>(90)

  // Shared density for both grids on this page.
  const [density, setDensity] = useState<Density>(() => {
    try { return (localStorage.getItem(`${STORAGE_KEY_ANALYTICS}.density`) as Density) ?? 'comfortable' } catch { return 'comfortable' }
  })
  useEffect(() => {
    try { localStorage.setItem(`${STORAGE_KEY_ANALYTICS}.density`, density) } catch {}
  }, [density])

  // Per-product sort state (VirtualizedGrid format: key or key-asc).
  const [sortBy, setSortBy] = useState('turnover')
  const onSort = useCallback((key: string) => {
    setSortBy(prev => {
      const base = key.replace(/-asc$/, '')
      if (prev === base) return `${base}-asc`
      if (prev === `${base}-asc`) return base
      return base
    })
  }, [])

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [turnoverRes, deadRes, abcRes, eoqRes] = await Promise.all([
        fetch(`${getBackendUrl()}/api/stock/analytics/turnover?days=${days}`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/stock/analytics/dead-stock?days=${deadDays}`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/stock/analytics/abc`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/stock/analytics/eoq?days=${days}`, { cache: 'no-store' }),
      ])
      if (!turnoverRes.ok) throw new Error(`turnover HTTP ${turnoverRes.status}`)
      setData(await turnoverRes.json())
      if (deadRes.ok)   setDeadStock(await deadRes.json())
      if (abcRes.ok)    setAbc(await abcRes.json())
      if (eoqRes.ok)    setEoq(await eoqRes.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [days, deadDays])

  useEffect(() => { fetchData() }, [fetchData])

  // SD-RT.3 — stock analytics (turnover, dead-stock, ABC class, EOQ
  // recommendations) is sales-driven. order.created changes velocity
  // → recomputed turnover + ABC class boundaries; stock.adjusted +
  // inbound.received affect dead-stock window calculations. AL-series
  // proved the salesReport.refreshed flow at ~03:00 UTC; that arrives
  // via the order-events bus too.
  useListingEvents()
  useOrderEventsRefresh(fetchData, {
    eventTypes: ['order.created', 'order.updated'],
    // Analytics tolerates a wider debounce; recomputing aggregate
    // queries on every order ingest would be wasteful.
    debounceMs: 5_000,
  })
  useInvalidationChannel(
    ['stock.adjusted', 'stock.transferred', 'product.updated'],
    fetchData,
  )

  const applyRecommendation = useCallback(async (rec: EoqRecommendation) => {
    if (rec.recommendation.rop == null && rec.recommendation.eoq == null) return
    setApplyingId(rec.stockLevelId)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/analytics/eoq/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ stockLevelId: rec.stockLevelId, reorderThreshold: rec.recommendation.rop, reorderQuantity: rec.recommendation.eoq }],
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success(t('stock.eoq.appliedToast', { sku: rec.sku }))
      await fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setApplyingId(null)
    }
  }, [fetchData, toast, t])

  // Sorted + shaped analytics rows for VirtualizedGrid.
  const analyticsRows = useMemo((): AnalyticsGridRow[] => {
    if (!data) return []
    const [key, dir] = sortBy.endsWith('-asc') ? [sortBy.slice(0, -4), 'asc'] : [sortBy, 'desc']
    const sorted = [...data.byProduct].sort((a, b) => {
      let av: number, bv: number
      switch (key) {
        case 'units':    av = a.unitsSold;                      bv = b.unitsSold;                      break
        case 'onHand':   av = a.totalStock;                     bv = b.totalStock;                     break
        case 'invValue': av = a.currentInventoryValueCents;     bv = b.currentInventoryValueCents;     break
        case 'turnover': av = a.turnoverRatio ?? -1;            bv = b.turnoverRatio ?? -1;            break
        case 'doh':      av = a.daysOfInventory ?? Infinity;    bv = b.daysOfInventory ?? Infinity;    break
        default: return 0
      }
      return dir === 'asc' ? av - bv : bv - av
    })
    return sorted.map(p => ({ ...p, id: p.productId, isParent: false, childCount: 0, parentId: null }))
  }, [data, sortBy])

  // EOQ rows for VirtualizedGrid.
  const eoqRows = useMemo((): EoqGridRow[] => {
    if (!eoq) return []
    return eoq.recommendations
      .filter(r => r.recommendation.rop != null)
      .slice(0, 50)
      .map(r => ({ ...r, id: r.stockLevelId, isParent: false, childCount: 0, parentId: null }))
  }, [eoq])

  const cellPad = DENSITY_CELL_CLASS[density] ?? DENSITY_CELL_CLASS.comfortable

  // Cell renderer — analytics turnover grid.
  const renderAnalyticsCell = useCallback((row: AnalyticsGridRow, colKey: string) => {
    switch (colKey) {
      case 'thumb':
        return row.thumbnailUrl
          ? <img src={row.thumbnailUrl} alt="" className={`${density === 'compact' ? 'w-6 h-6' : 'w-8 h-8'} rounded object-cover bg-slate-100`} />
          : <div className={`${density === 'compact' ? 'w-6 h-6' : 'w-8 h-8'} rounded bg-slate-100 flex items-center justify-center text-slate-400`}><Package size={density === 'compact' ? 12 : 14} /></div>
      case 'product':
        return (
          <div className="min-w-0 overflow-hidden">
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{row.name}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
              {row.sku}{row.amazonAsin && <span> · {row.amazonAsin}</span>}
            </div>
          </div>
        )
      case 'units':
        return <span className="tabular-nums text-slate-700 dark:text-slate-300">{row.unitsSold.toLocaleString()}</span>
      case 'onHand':
        return <span className="tabular-nums text-slate-700 dark:text-slate-300">{row.totalStock.toLocaleString()}</span>
      case 'invValue':
        return row.costPriceCents === 0
          ? <span className="text-slate-300 dark:text-slate-600">—</span>
          : <span className="tabular-nums text-slate-700 dark:text-slate-300">{formatCents(row.currentInventoryValueCents)}</span>
      case 'turnover':
        return row.turnoverRatio == null
          ? <span className="text-slate-300 dark:text-slate-600">—</span>
          : <span className="tabular-nums text-slate-700 dark:text-slate-300 font-semibold">{row.turnoverRatio.toFixed(2)}×</span>
      case 'doh':
        return row.daysOfInventory == null
          ? <span className="text-slate-300 dark:text-slate-600">—</span>
          : <span className={`tabular-nums font-semibold ${dohTone(row.daysOfInventory)}`}>{row.daysOfInventory}d</span>
      default:
        return null
    }
  }, [density])

  // Cell renderer — EOQ recommendations grid.
  const renderEoqCell = useCallback((row: EoqGridRow, colKey: string) => {
    const ropChanged = row.recommendation.rop != null && row.recommendation.rop !== row.currentReorderThreshold
    switch (colKey) {
      case 'product':
        return (
          <div className="flex items-center gap-2 min-w-0">
            {row.thumbnailUrl
              ? <img src={row.thumbnailUrl} alt="" className="w-7 h-7 rounded object-cover bg-slate-100 flex-shrink-0" />
              : <div className="w-7 h-7 rounded bg-slate-100 flex items-center justify-center text-slate-400 flex-shrink-0"><Package size={12} /></div>}
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{row.name}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">{row.sku}</div>
            </div>
          </div>
        )
      case 'location':
        return (
          <span className="inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700" title={row.location.name}>
            {row.location.code}
          </span>
        )
      case 'demand':
        return (
          <div className="text-right">
            <div className="tabular-nums text-slate-700 dark:text-slate-300">
              {row.inputs.unitsSoldInWindow > 0 ? row.inputs.unitsSoldInWindow : <span className="text-slate-300">0</span>}
            </div>
            <div className="text-xs text-slate-400">{row.inputs.dailyDemand.toFixed(2)}/day</div>
          </div>
        )
      case 'currentRop':
        return <span className="tabular-nums text-slate-500 dark:text-slate-400">{row.currentReorderThreshold ?? <span className="text-slate-300">—</span>}</span>
      case 'recRop':
        return (
          <span className={`tabular-nums font-semibold ${ropChanged ? 'text-blue-700' : 'text-slate-400'}`}>
            {row.recommendation.rop ?? <span className="text-slate-300 font-normal">—</span>}
          </span>
        )
      case 'recEoq':
        return <span className="tabular-nums text-slate-700 dark:text-slate-300">{row.recommendation.eoq ?? <span className="text-slate-300">—</span>}</span>
      case 'apply':
        return (row.recommendation.rop != null || row.recommendation.eoq != null) ? (
          <button
            type="button"
            onClick={() => applyRecommendation(row)}
            disabled={applyingId === row.stockLevelId}
            className="inline-flex items-center gap-1 min-h-[44px] sm:min-h-0 px-2.5 py-1 text-sm font-medium text-white bg-blue-600 border border-blue-600 rounded hover:bg-blue-700 disabled:opacity-50"
          >
            <Check size={11} />
            {t('stock.eoq.apply')}
          </button>
        ) : null
      default:
        return null
    }
  }, [applyingId, applyRecommendation, t])

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
              className="inline-flex items-center gap-1.5 h-11 sm:h-8 px-3 text-base text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
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
      <StockSubNav />

      <GridToolbar
        quickFilterSlot={
          <>
            <span className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mr-1">
              {t('stock.analytics.period')}
            </span>
            <div className="flex items-center gap-1">
              {PERIOD_OPTIONS.map((d) => (
                <button key={d} type="button" onClick={() => setDays(d)}
                  className={cn('min-h-[44px] sm:min-h-0 px-3 py-1 text-sm font-medium rounded border transition-colors',
                    days === d
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-300')}>
                  {d}d
                </button>
              ))}
            </div>
          </>
        }
        density={<DensityToggle density={density} onChange={setDensity} />}
      />

      {error && (
        <div className="text-base text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {loading && data === null && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i}><div className="h-[68px] flex items-center justify-center text-base text-slate-400">…</div></Card>
          ))}
        </div>
      )}

      {data && (
        <>
          {/* Overall KPI strip */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <Card>
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-md inline-flex items-center justify-center flex-shrink-0 bg-emerald-50 text-emerald-600"><TrendingUp size={16} /></div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('stock.analytics.kpi.turnover')}</div>
                  <div className="text-[20px] font-semibold tabular-nums text-slate-900 dark:text-slate-100 mt-0.5">
                    {data.overall.turnoverRatio == null ? '—' : `${data.overall.turnoverRatio.toFixed(2)}×`}
                  </div>
                  <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{t('stock.analytics.kpi.turnoverDetail', { days })}</div>
                </div>
              </div>
            </Card>
            <Card>
              <div className="flex items-start gap-3">
                <div className={`w-9 h-9 rounded-md inline-flex items-center justify-center flex-shrink-0 bg-blue-50 ${dohTone(data.overall.daysOfInventory)}`}><Activity size={16} /></div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('stock.analytics.kpi.doh')}</div>
                  <div className={`text-[20px] font-semibold tabular-nums mt-0.5 ${dohTone(data.overall.daysOfInventory)}`}>
                    {data.overall.daysOfInventory == null ? '—' : `${data.overall.daysOfInventory}d`}
                  </div>
                  <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{t('stock.analytics.kpi.dohDetail')}</div>
                </div>
              </div>
            </Card>
            <Card>
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-md inline-flex items-center justify-center flex-shrink-0 bg-violet-50 text-violet-600"><TrendingDown size={16} /></div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('stock.analytics.kpi.cogs')}</div>
                  <div className="text-[20px] font-semibold tabular-nums text-slate-900 dark:text-slate-100 mt-0.5">{formatCents(data.overall.cogsCents)}</div>
                  <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{t('stock.analytics.kpi.cogsDetail', { units: data.overall.unitsSold.toLocaleString() })}</div>
                </div>
              </div>
            </Card>
            <Card>
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-md inline-flex items-center justify-center flex-shrink-0 bg-slate-100 text-slate-600"><Boxes size={16} /></div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('stock.analytics.kpi.inventoryValue')}</div>
                  <div className="text-[20px] font-semibold tabular-nums text-slate-900 dark:text-slate-100 mt-0.5">{formatCents(data.overall.currentInventoryValueCents)}</div>
                  <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{t('stock.analytics.kpi.inventoryValueDetail', { n: data.overall.productsTracked.toLocaleString() })}</div>
                </div>
              </div>
            </Card>
          </div>

          {/* Per-channel breakdown */}
          {data.byChannel.length > 0 && (
            <Card>
              <div className="text-md font-semibold text-slate-900 dark:text-slate-100 mb-3">{t('stock.analytics.byChannel.title')}</div>
              <ul className="divide-y divide-slate-100">
                {data.byChannel.map((ch) => (
                  <li key={`${ch.channel}_${ch.marketplace}`} className="flex items-center justify-between py-2">
                    <div className="inline-flex items-center gap-2">
                      <Badge variant="default" size="sm">{ch.channel}</Badge>
                      <span className="text-sm text-slate-500 dark:text-slate-400">{ch.marketplace}</span>
                    </div>
                    <div className="text-right text-sm">
                      <div className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                        {ch.units.toLocaleString()} {t('stock.analytics.byChannel.units')}
                      </div>
                      <div className="text-slate-500 dark:text-slate-400">
                        {formatCents(ch.revenueCents)} · {ch.orders.toLocaleString()} {t('stock.analytics.byChannel.orders')}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* EOQ recommendations — VirtualizedGrid */}
          {eoqRows.length > 0 && (
            <Card noPadding>
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
                <div className="text-md font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-2">
                  <Calculator size={14} className="text-blue-500" />
                  {t('stock.eoq.title')}
                </div>
                {eoq && (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {t('stock.eoq.windowSummary', { days: eoq.windowDays })}
                  </div>
                )}
              </div>
              <VirtualizedGrid
                rows={eoqRows}
                visible={EOQ_COLUMNS}
                density={density}
                cellPad={cellPad}
                selected={_EMPTY_SET}
                toggleSelect={_NOOP as any}
                toggleSelectAll={_NOOP}
                allSelected={false}
                sortBy=""
                onSort={_NOOP}
                expandedParents={_EMPTY_SET}
                childrenByParent={{}}
                loadingChildren={_EMPTY_SET}
                onToggleExpand={_NOOP}
                focusedRowId={null}
                searchTerm=""
                riskFlaggedSkus={_EMPTY_SET}
                storageKey={STORAGE_KEY_EOQ}
                showExpandColumn={false}
                renderCell={renderEoqCell}
              />
              <div className="px-4 pb-1">
                <GridFooter count={eoqRows.length} label="recommendations" />
              </div>
              <div className="px-4 py-2.5 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                <span className="font-semibold text-slate-700 dark:text-slate-300">{t('stock.eoq.formula.title')}: </span>
                {t('stock.eoq.formula.body')}
              </div>
            </Card>
          )}

          {/* ABC classification card */}
          {abc && (
            <Card>
              <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                <div className="text-md font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-2">
                  <BarChart3 size={14} className="text-violet-500" />
                  {t('stock.abc.title')}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {abc.snapshotAt
                    ? t('stock.abc.snapshotAt', { when: new Date(abc.snapshotAt).toLocaleString() })
                    : t('stock.abc.notRun')}
                </div>
              </div>
              {abc.productsClassified === 0 ? (
                <div className="text-sm text-slate-500 dark:text-slate-400 italic py-3">{t('stock.abc.empty')}</div>
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {(['A', 'B', 'C', 'D'] as const).map((cls) => {
                      const tone =
                        cls === 'A' ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800' :
                        cls === 'B' ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800' :
                        cls === 'C' ? 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700' :
                        'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800'
                      const count = abc.counts[cls] ?? 0
                      const sharePct = abc.productsClassified > 0 ? (count / abc.productsClassified) * 100 : 0
                      return (
                        <div key={cls} className={`border rounded-md p-3 ${tone}`}>
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="text-xs uppercase tracking-wider font-semibold">{t(`stock.abc.band.${cls}.label`)}</span>
                            <AbcBadge cls={cls} size="sm" />
                          </div>
                          <div className="text-2xl font-bold tabular-nums mt-1">{count.toLocaleString()}</div>
                          <div className="text-xs mt-0.5 opacity-80 flex items-baseline gap-1.5">
                            <span className="font-semibold tabular-nums">{sharePct.toFixed(1)}%</span>
                            <span className="opacity-80">{t(`stock.abc.band.${cls}.description`)}</span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                    {(['A', 'B', 'C', 'D'] as const).map((cls) => {
                      const list = abc.samples[cls]?.slice(0, 3) ?? []
                      if (list.length === 0) return null
                      return (
                        <div key={cls} className="border border-slate-200 dark:border-slate-700 rounded-md p-2.5 bg-slate-50/40 dark:bg-slate-800/40">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <AbcBadge cls={cls} size="sm" />
                            <span className="text-xs uppercase tracking-wider font-semibold text-slate-700 dark:text-slate-300">{t('stock.abc.topSamples')}</span>
                          </div>
                          <ul className="space-y-1">
                            {list.map((s) => (
                              <li key={s.productId} className="flex items-center justify-between gap-2 text-xs">
                                <span className="font-mono truncate text-slate-700 dark:text-slate-300" title={`${s.sku} — ${s.name}`}>{s.sku}</span>
                                <span className="tabular-nums text-slate-500 dark:text-slate-400 shrink-0">{(s.inventoryValueCents / 100).toFixed(0)}€</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )
                    })}
                  </div>
                  <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                    {t('stock.abc.totalClassified', { n: abc.productsClassified })}
                  </div>
                </>
              )}
            </Card>
          )}

          {/* Dead-stock + slow-moving */}
          {deadStock && (deadStock.dead.length > 0 || deadStock.slow.length > 0) && (
            <Card>
              <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                <div className="text-md font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-2">
                  <Snowflake size={14} className="text-blue-500" />
                  {t('stock.deadStock.title')}
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mr-1">{t('stock.deadStock.threshold')}</span>
                  {[30, 60, 90, 180].map((d) => (
                    <button key={d} type="button" onClick={() => setDeadDays(d)}
                      className={cn('min-h-[44px] sm:min-h-0 px-2.5 py-1 text-sm font-medium rounded border transition-colors',
                        deadDays === d ? 'bg-slate-900 text-white border-slate-900' : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-300')}>
                      {d}d
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div>
                  <div className="text-sm uppercase tracking-wider font-semibold text-rose-700 inline-flex items-center gap-1.5 mb-2">
                    <AlertTriangle size={12} />
                    {t('stock.deadStock.dead.title', { days: deadDays })}
                    <span className="text-slate-500 dark:text-slate-400 font-normal">· {deadStock.dead.length}</span>
                  </div>
                  {deadStock.dead.length === 0 ? (
                    <div className="text-sm text-slate-400 italic py-2">{t('stock.deadStock.dead.empty')}</div>
                  ) : (
                    <ul className="space-y-1 max-h-[420px] overflow-y-auto pr-1">
                      {deadStock.dead.slice(0, 50).map((p) => (
                        <li key={p.productId} className="flex items-center gap-2 py-1.5 px-2 -mx-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
                          {p.thumbnailUrl
                            ? <img src={p.thumbnailUrl} alt="" className="w-7 h-7 rounded object-cover bg-slate-100 flex-shrink-0" />
                            : <div className="w-7 h-7 rounded bg-slate-100 flex items-center justify-center text-slate-400 flex-shrink-0"><Package size={12} /></div>}
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{p.name}</div>
                            <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
                              {p.sku} · {t('stock.analytics.onHand', { n: p.totalStock })}
                              {p.daysSinceLastMovement != null
                                ? <span className="text-rose-600"> · {p.daysSinceLastMovement}d ago</span>
                                : <span className="text-rose-600"> · {t('stock.deadStock.neverMoved')}</span>}
                            </div>
                          </div>
                          <div className="text-right text-sm tabular-nums flex-shrink-0">
                            <div className="font-semibold text-rose-700">{formatCents(p.valueAtRiskCents)}</div>
                            <div className="text-xs text-slate-400">{t('stock.deadStock.atRisk')}</div>
                          </div>
                        </li>
                      ))}
                      {deadStock.dead.length > 50 && (
                        <li className="text-xs text-slate-400 italic pt-1">+{deadStock.dead.length - 50} {t('stock.analytics.byChannel.units')}</li>
                      )}
                    </ul>
                  )}
                </div>
                <div>
                  <div className="text-sm uppercase tracking-wider font-semibold text-amber-700 inline-flex items-center gap-1.5 mb-2">
                    <TrendingDown size={12} />
                    {t('stock.deadStock.slow.title', { v: deadStock.slowVelocityThreshold })}
                    <span className="text-slate-500 dark:text-slate-400 font-normal">· {deadStock.slow.length}</span>
                  </div>
                  {deadStock.slow.length === 0 ? (
                    <div className="text-sm text-slate-400 italic py-2">{t('stock.deadStock.slow.empty')}</div>
                  ) : (
                    <ul className="space-y-1 max-h-[420px] overflow-y-auto pr-1">
                      {deadStock.slow.slice(0, 50).map((p) => (
                        <li key={p.productId} className="flex items-center gap-2 py-1.5 px-2 -mx-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
                          {p.thumbnailUrl
                            ? <img src={p.thumbnailUrl} alt="" className="w-7 h-7 rounded object-cover bg-slate-100 flex-shrink-0" />
                            : <div className="w-7 h-7 rounded bg-slate-100 flex items-center justify-center text-slate-400 flex-shrink-0"><Package size={12} /></div>}
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{p.name}</div>
                            <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
                              {p.sku} · {t('stock.analytics.onHand', { n: p.totalStock })} · {t('stock.analytics.dailyVelocity', { v: p.dailyVelocity })}
                            </div>
                          </div>
                          <div className="text-right text-sm tabular-nums flex-shrink-0">
                            <div className="font-semibold text-amber-700">{formatCents(p.valueAtRiskCents)}</div>
                            <div className="text-xs text-slate-400">{t('stock.deadStock.atRisk')}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                <span className="font-semibold text-slate-700 dark:text-slate-300">{t('stock.deadStock.recommended.title')}: </span>
                {t('stock.deadStock.recommended.body')}
              </div>
            </Card>
          )}

          {/* Per-product turnover — VirtualizedGrid */}
          {analyticsRows.length === 0 ? (
            <EmptyState
              icon={Activity}
              title={t('stock.analytics.empty.title')}
              description={t('stock.analytics.empty.description')}
              action={{ label: t('stock.title'), href: '/fulfillment/stock' }}
            />
          ) : (<>
            <VirtualizedGrid
              rows={analyticsRows}
              visible={ANALYTICS_COLUMNS}
              density={density}
              cellPad={cellPad}
              selected={_EMPTY_SET}
              toggleSelect={_NOOP as any}
              toggleSelectAll={_NOOP}
              allSelected={false}
              sortBy={sortBy}
              onSort={onSort}
              sortKeys={ANALYTICS_SORT_KEYS}
              expandedParents={_EMPTY_SET}
              childrenByParent={{}}
              loadingChildren={_EMPTY_SET}
              onToggleExpand={_NOOP}
              focusedRowId={null}
              searchTerm=""
              riskFlaggedSkus={_EMPTY_SET}
              storageKey={STORAGE_KEY_ANALYTICS}
              showExpandColumn={false}
              renderCell={renderAnalyticsCell}
            />
            <GridFooter count={analyticsRows.length} label="products" />
          </>)}

          {/* Year-end valuation */}
          <YearEndValuationCard t={t} />
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// T.8 — Year-end valuation (rimanenze finali) card
// ─────────────────────────────────────────────────────────────────────
type YearEndValuation = {
  year: number
  asOf: string
  total: { units: number; valueEurCents: number }
  byLocation: Array<{ locationCode: string; locationName: string; units: number; valueEurCents: number }>
  byMethod: Record<'FIFO' | 'LIFO' | 'WAC', { units: number; valueEurCents: number }>
  byCurrency: Array<{ currency: string; units: number; originalValueCents: number; valueEurCents: number }>
  vatTreatment: {
    netCapitalised: { units: number; valueEurCents: number }
    grossCapitalised: { units: number; valueEurCents: number }
    unknownVat: { units: number; valueEurCents: number }
  }
  layerCount: number
  source?: 'live' | 'snapshot'
  notes?: string | null
}

function YearEndValuationCard({ t }: { t: (k: string, v?: Record<string, string | number>) => string }) {
  const { toast } = useToast()
  const [data, setData]     = useState<YearEndValuation | null>(null)
  const [loading, setLoading] = useState(false)
  const [snapping, setSnapping] = useState(false)
  const [err, setErr]       = useState<string | null>(null)
  const currentYear = new Date().getUTCFullYear()
  const [year, setYear]     = useState<number>(currentYear)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/year-end-valuation?year=${year}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [year])

  useEffect(() => { fetchData() }, [fetchData])

  const triggerSnapshot = useCallback(async () => {
    setSnapping(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/year-end-valuation/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      toast.success(t('stock.analytics.yearEnd.snapshotSaved', { year }))
      await fetchData()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSnapping(false)
    }
  }, [year, fetchData, toast, t])

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-md font-semibold text-slate-900 dark:text-slate-100">{t('stock.analytics.yearEnd.title')}</div>
          <div className="text-sm text-slate-500 dark:text-slate-400">{t('stock.analytics.yearEnd.subtitle')}</div>
        </div>
        <div className="flex items-center gap-2">
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}
            className="h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300"
            aria-label={t('stock.analytics.yearEnd.yearSelect')}>
            {[currentYear, currentYear - 1, currentYear - 2].map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <Button variant="secondary" size="sm" onClick={fetchData} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          </Button>
          {data?.source === 'live' && year < currentYear && (
            <Button variant="secondary" size="sm" onClick={triggerSnapshot} disabled={snapping}>
              {snapping ? t('stock.analytics.yearEnd.snapping') : t('stock.analytics.yearEnd.saveSnapshot')}
            </Button>
          )}
        </div>
      </div>
      {data && (
        <div className="text-xs text-slate-500 dark:text-slate-400 -mt-2 mb-2 inline-flex items-center gap-2 flex-wrap">
          <span className={
            data.source === 'snapshot'
              ? 'inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 font-medium uppercase tracking-wider'
              : 'inline-flex items-center px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 font-medium uppercase tracking-wider'
          }>
            {data.source === 'snapshot' ? t('stock.analytics.yearEnd.sourceSnapshot') : t('stock.analytics.yearEnd.sourceLive')}
          </span>
          {data.notes && <span className="text-slate-400">{data.notes}</span>}
        </div>
      )}
      {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
      {data && (
        <div className="space-y-3">
          <div className="flex items-baseline gap-3 border-b border-slate-100 dark:border-slate-800 pb-2">
            <div className="text-3xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">{formatCents(data.total.valueEurCents)}</div>
            <div className="text-sm text-slate-500 dark:text-slate-400">{t('stock.analytics.yearEnd.totalUnits', { units: data.total.units.toLocaleString(), layers: data.layerCount })}</div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">{t('stock.analytics.yearEnd.byLocation')}</div>
              <ul className="space-y-1">
                {data.byLocation.map((l) => (
                  <li key={l.locationCode} className="flex justify-between gap-2 text-sm">
                    <span className="text-slate-700 dark:text-slate-300 truncate">{l.locationCode}</span>
                    <span className="tabular-nums text-slate-900 dark:text-slate-100 font-medium">{formatCents(l.valueEurCents)}</span>
                  </li>
                ))}
                {data.byLocation.length === 0 && <li className="text-sm text-slate-400">—</li>}
              </ul>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">{t('stock.analytics.yearEnd.byMethod')}</div>
              <ul className="space-y-1">
                {(['FIFO', 'LIFO', 'WAC'] as const).map((m) => (
                  <li key={m} className="flex justify-between gap-2 text-sm">
                    <span className="text-slate-700 dark:text-slate-300">{m}</span>
                    <span className="tabular-nums text-slate-900 dark:text-slate-100 font-medium">
                      {data.byMethod[m].units > 0 ? formatCents(data.byMethod[m].valueEurCents) : <span className="text-slate-400">—</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">{t('stock.analytics.yearEnd.vat')}</div>
              <ul className="space-y-1 text-sm">
                <li className="flex justify-between gap-2">
                  <span className="text-emerald-700">{t('stock.analytics.yearEnd.netCapitalised')}</span>
                  <span className="tabular-nums">{formatCents(data.vatTreatment.netCapitalised.valueEurCents)}</span>
                </li>
                {data.vatTreatment.grossCapitalised.units > 0 && (
                  <li className="flex justify-between gap-2">
                    <span className="text-rose-700">{t('stock.analytics.yearEnd.grossCapitalised')}</span>
                    <span className="tabular-nums">{formatCents(data.vatTreatment.grossCapitalised.valueEurCents)}</span>
                  </li>
                )}
                {data.vatTreatment.unknownVat.units > 0 && (
                  <li className="flex justify-between gap-2">
                    <span className="text-amber-700">{t('stock.analytics.yearEnd.unknownVat')}</span>
                    <span className="tabular-nums">{formatCents(data.vatTreatment.unknownVat.valueEurCents)}</span>
                  </li>
                )}
              </ul>
            </div>
          </div>
          {data.byCurrency.length > 1 && (
            <div className="border-t border-slate-100 dark:border-slate-800 pt-2">
              <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">{t('stock.analytics.yearEnd.byCurrency')}</div>
              <ul className="flex flex-wrap gap-3 text-sm">
                {data.byCurrency.map((c) => (
                  <li key={c.currency}>
                    <span className="font-mono text-slate-700 dark:text-slate-300">{c.currency}</span>{' '}
                    <span className="tabular-nums text-slate-500 dark:text-slate-400">{c.units.toLocaleString()}u</span>
                    {c.currency !== 'EUR' && <span className="text-slate-400"> · {formatCents(c.valueEurCents)} EUR</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="text-xs text-slate-400 pt-1 border-t border-slate-100 dark:border-slate-800">
            {t('stock.analytics.yearEnd.asOfDisclosure', { date: new Date(data.asOf).toLocaleDateString() })}
          </div>
        </div>
      )}
    </Card>
  )
}
