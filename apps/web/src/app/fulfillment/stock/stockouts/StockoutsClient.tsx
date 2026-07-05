'use client'

/**
 * S.29 — Stockout history report.
 *
 * KPI strip + filter card are separate from the grid (unchanged).
 * S.2 — event table replaced with SharedVirtualizedGrid.
 * Open (unresolved) rows are highlighted via stagedIds.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'
import { Listbox } from '@/design-system/components/Listbox'
import Link from 'next/link'
import {
  AlertTriangle, ArrowLeft, Search, X, AlertCircle,
  Clock, Package, MapPin,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { useListingEvents } from '@/lib/sync/use-listing-events'
import { useInboundEvents } from '@/lib/sync/use-inbound-events'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'
import { AutoRefreshSelect, DensityToggle, GridToolbar, VirtualizedGrid, GridFooter } from '@/app/_shared/grid-lens'
import type { GridLensColumn, GridLensRow } from '@/app/_shared/grid-lens'
import { type Density, DENSITY_CELL_CLASS } from '@/lib/products/theme'

// ── Types ─────────────────────────────────────────────────────────────

interface StockoutSummary {
  windowDays: number
  openCount: number
  eventsInWindow: number
  totalDurationDays: number
  totalLostUnits: number
  totalLostRevenueCents: number
  totalLostMarginCents: number
  worstSku: { sku: string; durationDays: number | string; estimatedLostMargin: number | null; locationId: string | null } | null
}

interface StockoutEvent {
  id: string
  productId: string
  sku: string
  locationId: string | null
  channel: string | null
  marketplace: string | null
  startedAt: string
  endedAt: string | null
  detectedBy: string
  closedBy: string | null
  velocityAtStart: number | string
  marginCentsPerUnit: number | null
  unitCostCents: number | null
  sellingPriceCents: number | null
  durationDays: number | string | null
  estimatedLostUnits: number | null
  estimatedLostRevenue: number | null
  estimatedLostMargin: number | null
  notes: string | null
  location: { code: string; name: string } | null
}

interface Location { id: string; code: string; name: string }

type StockoutRow = StockoutEvent & GridLensRow

// ── Constants ─────────────────────────────────────────────────────────

const STOCKOUT_COLUMNS: GridLensColumn[] = [
  { key: 'sku',         label: 'SKU',          subLabel: 'Product',     width: 140 },
  { key: 'location',    label: 'Location',     subLabel: 'Code',        width: 100 },
  { key: 'started',     label: 'Started',      subLabel: 'Date',        width: 100 },
  { key: 'duration',    label: 'Duration',     subLabel: 'Days',        width: 100 },
  { key: 'velocity',    label: 'Velocity',     subLabel: 'Units/day',   width: 90  },
  { key: 'lostUnits',   label: 'Lost Units',   subLabel: 'Est.',        width: 90  },
  { key: 'lostRevenue', label: 'Lost Rev.',    subLabel: 'Est. €',      width: 100 },
  { key: 'lostMargin',  label: 'Lost Margin',  subLabel: 'Est. €',      width: 100 },
  { key: 'detectedBy',  label: 'Detected By',  subLabel: 'Source',      width: 110 },
  { key: 'notes',       label: 'Notes',                                  width: 200 },
]

const STOCKOUT_SORT_KEYS: Record<string, string> = {
  sku: 'sku', started: 'started', duration: 'duration',
  velocity: 'velocity', lostRevenue: 'lostRevenue', lostMargin: 'lostMargin',
}

const WINDOW_OPTIONS = [7, 30, 90, 180, 365] as const
const STORAGE_KEY = 'stock-stockouts'
const _EMPTY_SET = new Set<string>()
const _EMPTY_MAP = {}
const _NOOP = () => {}

// ── Helpers ───────────────────────────────────────────────────────────

function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return `${(cents / 100).toFixed(0)}€`
}

function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10)
}

function formatDuration(
  days: number | string | null,
  endedAt: string | null,
  startedAt: string,
  t: (k: string, vars?: Record<string, string | number>) => string,
): string {
  if (days != null) {
    const n = typeof days === 'string' ? parseFloat(days) : days
    if (Number.isFinite(n)) return `${n.toFixed(1)}d`
  }
  if (!endedAt) {
    const ms = Date.now() - new Date(startedAt).getTime()
    return t('stock.stockouts.durationOpen', { days: (ms / 86400_000).toFixed(1) })
  }
  return '—'
}

// ── Component ─────────────────────────────────────────────────────────

export default function StockoutsClient() {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [summary, setSummary]           = useState<StockoutSummary | null>(null)
  const [events, setEvents]             = useState<StockoutEvent[] | null>(null)
  const [locations, setLocations]       = useState<Location[]>([])
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState<string | null>(null)
  const [windowDays, setWindowDays]     = useState<number>(30)
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>('all')
  const [locationFilter, setLocationFilter] = useState<string>('')
  const [skuQuery, setSkuQuery]         = useState('')
  const [skuQueryDebounced, setSkuQueryDebounced] = useState('')
  const [sortBy, setSortBy]             = useState('started')
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const [autoRefreshMin, setAutoRefreshMin] = useState<0 | 5 | 15>(0)
  const [density, setDensity]           = useState<Density>(() => {
    try { return (localStorage.getItem(`${STORAGE_KEY}.density`) as Density) ?? 'comfortable' } catch { return 'comfortable' }
  })

  useEffect(() => {
    try { localStorage.setItem(`${STORAGE_KEY}.density`, density) } catch {}
  }, [density])

  useEffect(() => {
    const h = setTimeout(() => setSkuQueryDebounced(skuQuery), 250)
    return () => clearTimeout(h)
  }, [skuQuery])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const sumUrl = `${getBackendUrl()}/api/fulfillment/replenishment/stockouts/summary?windowDays=${windowDays}`
      const evUrl = new URL(`${getBackendUrl()}/api/fulfillment/replenishment/stockouts/events`)
      evUrl.searchParams.set('status', statusFilter)
      evUrl.searchParams.set('limit', '200')
      evUrl.searchParams.set('sinceDays', String(windowDays))
      if (locationFilter) evUrl.searchParams.set('locationId', locationFilter)
      if (skuQueryDebounced.trim()) evUrl.searchParams.set('sku', skuQueryDebounced.trim())

      const [sumRes, evRes, locRes] = await Promise.all([
        fetch(sumUrl, { cache: 'no-store' }),
        fetch(evUrl.toString(), { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/stock/locations`, { cache: 'no-store' }),
      ])
      if (!sumRes.ok) throw new Error(`summary HTTP ${sumRes.status}`)
      if (!evRes.ok) throw new Error(`events HTTP ${evRes.status}`)
      const sum: StockoutSummary = await sumRes.json()
      const ev: { items: StockoutEvent[] } = await evRes.json()
      setSummary(sum)
      setEvents(ev.items ?? [])
      if (locRes.ok) {
        const locJson = await locRes.json()
        const arr = Array.isArray(locJson) ? locJson : locJson.locations ?? []
        setLocations(arr.filter((l: any) => l?.id && l?.code).map((l: any) => ({ id: l.id, code: l.code, name: l.name ?? l.code })))
      }
      setError(null)
      setLastFetchedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setLoading(false) }
  }, [windowDays, statusFilter, locationFilter, skuQueryDebounced])

  useEffect(() => { fetchAll() }, [fetchAll])

  // SD-RT.2 — refresh stockouts list when upstream signals change.
  // inbound.received drops rows from the out-of-stock list as units
  // physically arrive; stock.adjusted is direct operator edits;
  // product.updated catches threshold changes that re-classify a SKU.
  useListingEvents()
  useInboundEvents()
  useInvalidationChannel(
    [
      'stock.adjusted', 'stock.transferred',
      'inbound.received', 'inbound.discrepancy', 'inbound.updated',
      'product.updated',
    ],
    fetchAll,
  )

  const triggerSweep = async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/replenishment/stockouts/sweep`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      toast.success(t('stock.stockouts.toast.sweepDone', { opened: body.opened, closed: body.closed }))
      await fetchAll()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const kpis = useMemo(() => {
    if (!summary) return null
    return [
      { key: 'eventsInWindow',       label: t('stock.stockouts.kpi.events'),      value: summary.eventsInWindow,       fmt: (v: number) => String(v) },
      { key: 'openCount',            label: t('stock.stockouts.kpi.open'),        value: summary.openCount,            fmt: (v: number) => String(v), tone: summary.openCount > 0 ? 'warning' : 'neutral' as const },
      { key: 'totalDurationDays',    label: t('stock.stockouts.kpi.totalDays'),   value: summary.totalDurationDays,    fmt: (v: number) => `${v.toFixed(1)}d` },
      { key: 'totalLostUnits',       label: t('stock.stockouts.kpi.lostUnits'),   value: summary.totalLostUnits,       fmt: (v: number) => String(v) },
      { key: 'totalLostRevenueCents',label: t('stock.stockouts.kpi.lostRevenue'), value: summary.totalLostRevenueCents,fmt: formatCents },
      { key: 'totalLostMarginCents', label: t('stock.stockouts.kpi.lostMargin'),  value: summary.totalLostMarginCents, fmt: formatCents, tone: 'danger' as const },
    ]
  }, [summary, t])

  // Build sorted rows + stagedIds (open events get the teal row tint).
  const { rows, openIds } = useMemo(() => {
    if (!events) return { rows: [] as StockoutRow[], openIds: _EMPTY_SET }
    const base = events.map(e => ({ ...e, isParent: false as const, childCount: 0, parentId: null }))
    const [key, dir] = sortBy.endsWith('-asc') ? [sortBy.slice(0, -4), 'asc'] : [sortBy, 'desc']
    const sorted = [...base].sort((a, b) => {
      let av: any, bv: any
      switch (key) {
        case 'sku':         av = a.sku;                    bv = b.sku;                    break
        case 'started':     av = a.startedAt;              bv = b.startedAt;              break
        case 'duration':    av = typeof a.durationDays === 'string' ? parseFloat(a.durationDays) : (a.durationDays ?? 0); bv = typeof b.durationDays === 'string' ? parseFloat(b.durationDays) : (b.durationDays ?? 0); break
        case 'velocity':    av = typeof a.velocityAtStart === 'string' ? parseFloat(a.velocityAtStart) : a.velocityAtStart; bv = typeof b.velocityAtStart === 'string' ? parseFloat(b.velocityAtStart) : b.velocityAtStart; break
        case 'lostRevenue': av = a.estimatedLostRevenue ?? 0; bv = b.estimatedLostRevenue ?? 0; break
        case 'lostMargin':  av = a.estimatedLostMargin ?? 0;  bv = b.estimatedLostMargin ?? 0;  break
        default: return 0
      }
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : ((av ?? 0) - (bv ?? 0))
      return dir === 'asc' ? cmp : -cmp
    })
    const openSet = new Set(sorted.filter(r => !r.endedAt).map(r => r.id))
    return { rows: sorted, openIds: openSet }
  }, [events, sortBy])

  const cellPad = DENSITY_CELL_CLASS[density] ?? DENSITY_CELL_CLASS.comfortable

  const onSort = useCallback((key: string) => {
    setSortBy(prev => {
      const base = key.replace(/-asc$/, '')
      if (prev === base) return `${base}-asc`
      if (prev === `${base}-asc`) return base
      return base
    })
  }, [])

  const renderCell = useCallback((row: StockoutRow, colKey: string) => {
    const velocity = typeof row.velocityAtStart === 'string' ? parseFloat(row.velocityAtStart) : row.velocityAtStart
    const isOpen = !row.endedAt

    switch (colKey) {
      case 'sku':
        return (
          <Link href={`/products?sku=${encodeURIComponent(row.sku)}`}
            className="font-mono text-sm text-blue-700 dark:text-blue-400 hover:underline">
            {row.sku}
          </Link>
        )
      case 'location':
        return row.location ? (
          <span className="inline-flex items-center gap-1 text-sm text-slate-700 dark:text-slate-300">
            <MapPin size={11} className="text-tertiary dark:text-slate-500" />
            {row.location.code}
          </span>
        ) : <span className="text-slate-300 dark:text-slate-600">—</span>
      case 'started':
        return <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300">{formatDate(row.startedAt)}</span>
      case 'duration':
        return (
          <span className={cn('inline-flex items-center gap-1 text-sm tabular-nums',
            isOpen ? 'text-amber-700 dark:text-amber-400 font-semibold' : 'text-slate-700 dark:text-slate-300')}>
            <Clock size={11} />
            {formatDuration(row.durationDays, row.endedAt, row.startedAt, t)}
          </span>
        )
      case 'velocity':
        return <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300">{Number.isFinite(velocity) ? `${velocity.toFixed(2)}/d` : '—'}</span>
      case 'lostUnits':
        return <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300">{row.estimatedLostUnits ?? '—'}</span>
      case 'lostRevenue':
        return <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300">{formatCents(row.estimatedLostRevenue)}</span>
      case 'lostMargin':
        return <span className="text-sm tabular-nums font-semibold text-rose-700 dark:text-rose-400">{formatCents(row.estimatedLostMargin)}</span>
      case 'detectedBy':
        return (
          <Badge variant={row.detectedBy === 'cron' ? 'default' : row.detectedBy === 'movement' ? 'info' : 'warning'} size="sm">
            {row.detectedBy}
          </Badge>
        )
      case 'notes':
        return row.notes
          ? <span className="text-sm text-slate-500 dark:text-slate-400 truncate" title={row.notes}>{row.notes}</span>
          : <span className="text-slate-300 dark:text-slate-600">—</span>
      default:
        return null
    }
  }, [t])

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('stock.stockouts.title')}
        description={t('stock.stockouts.description')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('stock.stockouts.title') },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Link href="/fulfillment/stock"
              className="inline-flex items-center gap-1.5 h-11 sm:h-8 px-3 text-base text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100">
              <ArrowLeft size={14} /> {t('stock.title')}
            </Link>
            <Button variant="secondary" size="sm" onClick={triggerSweep} disabled={loading}>
              <AlertTriangle className="w-3.5 h-3.5" />
              {t('stock.stockouts.sweep')}
            </Button>
          </div>
        }
      />
      <StockSubNav />

      {/* KPI strip — unchanged */}
      {kpis && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          {kpis.map(k => (
            <Card key={k.key} className="!p-3">
              <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{k.label}</div>
              <div className={cn('text-xl font-semibold tabular-nums mt-1',
                k.tone === 'danger' && 'text-rose-700 dark:text-rose-400',
                k.tone === 'warning' && 'text-amber-700 dark:text-amber-400',
                (!k.tone || k.tone === 'neutral') && 'text-slate-900 dark:text-slate-100')}>
                {k.fmt(k.value as any)}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Filter card — unchanged */}
      <Card className="!p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            {(['all', 'open', 'closed'] as const).map(s => (
              <button key={s} type="button" onClick={() => setStatusFilter(s)}
                className={cn('px-3 py-1 text-sm font-medium rounded border transition-colors',
                  statusFilter === s
                    ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100'
                    : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-default dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600')}>
                {t(`stock.stockouts.status.${s}`)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <label htmlFor="stockouts-window" className="text-sm text-slate-500 dark:text-slate-400">{t('stock.stockouts.windowLabel')}</label>
            <Listbox value={String(windowDays)} onChange={v => setWindowDays(Number(v))} ariaLabel={t('stock.stockouts.windowLabel')} className="w-20"
              options={WINDOW_OPTIONS.map(d => ({ value: String(d), label: `${d}d` }))} />
          </div>
          <div className="flex items-center gap-1.5">
            <label htmlFor="stockouts-location" className="text-sm text-slate-500 dark:text-slate-400">{t('stock.stockouts.locationLabel')}</label>
            <Listbox value={locationFilter} onChange={setLocationFilter} ariaLabel={t('stock.stockouts.locationLabel')} className="min-w-[180px]"
              options={[{ value: '', label: t('stock.stockouts.locationAny') }, ...locations.map(l => ({ value: l.id, label: `${l.code} — ${l.name}` }))]} />
          </div>
          <div className="flex items-center gap-1 flex-1 min-w-[200px]">
            <Search className="w-3.5 h-3.5 text-tertiary" />
            <input type="text" value={skuQuery} onChange={e => setSkuQuery(e.target.value)}
              placeholder={t('stock.stockouts.skuPlaceholder')}
              className="flex-1 h-8 px-2 text-sm border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900" />
            {skuQuery && (
              <button type="button" onClick={() => setSkuQuery('')} aria-label={t('common.close')}
                className="h-8 w-8 inline-flex items-center justify-center rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      </Card>

      {error && (
        <Card className="!p-3 border-rose-200 dark:border-rose-700/50 bg-rose-50 dark:bg-rose-950/30">
          <div className="flex items-center gap-2 text-sm text-rose-700 dark:text-rose-300">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        </Card>
      )}

      <GridToolbar
        quickFilterSlot={
          events && events.length > 0 ? (
            <span className="text-sm text-slate-500 dark:text-slate-400">
              {rows.length} event{rows.length === 1 ? '' : 's'}
              {openIds.size > 0 && <span className="ml-1.5 text-amber-700 dark:text-amber-400">· {openIds.size} open</span>}
            </span>
          ) : undefined
        }
        density={<DensityToggle density={density} onChange={setDensity} />}
        autoRefresh={
          <AutoRefreshSelect
            value={autoRefreshMin}
            onChange={setAutoRefreshMin}
            onTick={fetchAll}
          />
        }
        freshness={
          <FreshnessIndicator
            lastFetchedAt={lastFetchedAt}
            onRefresh={fetchAll}
            loading={loading}
          />
        }
      />

      {events !== null && rows.length === 0 ? (
        <EmptyState icon={Package} title={t('stock.stockouts.empty.title')} description={t('stock.stockouts.empty.description')} />
      ) : rows.length > 0 ? (
        <>
          <VirtualizedGrid
            rows={rows}
            visible={STOCKOUT_COLUMNS}
            density={density}
            cellPad={cellPad}
            selected={_EMPTY_SET}
            toggleSelect={_NOOP as any}
            toggleSelectAll={_NOOP}
            allSelected={false}
            sortBy={sortBy}
            onSort={onSort}
            sortKeys={STOCKOUT_SORT_KEYS}
            expandedParents={_EMPTY_SET}
            childrenByParent={_EMPTY_MAP}
            loadingChildren={_EMPTY_SET}
            onToggleExpand={_NOOP}
            focusedRowId={null}
            searchTerm={skuQueryDebounced}
            riskFlaggedSkus={_EMPTY_SET}
            storageKey={STORAGE_KEY}
            showExpandColumn={false}
            stagedIds={openIds}
            renderCell={renderCell}
          />
          <GridFooter count={rows.length} label="events" />
          {rows.length >= 200 && (
            <p className="text-xs text-slate-500 dark:text-slate-400 px-1">{t('stock.stockouts.limitNote')}</p>
          )}
        </>
      ) : null}
    </div>
  )
}
