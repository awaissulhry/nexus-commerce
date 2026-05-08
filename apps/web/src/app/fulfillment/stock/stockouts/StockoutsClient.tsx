'use client'

/**
 * S.29 — Stockout history report.
 *
 * Reads R.12's StockoutEvent ledger:
 *   /api/fulfillment/replenishment/stockouts/summary?windowDays=N
 *   /api/fulfillment/replenishment/stockouts/events?status=…&sinceDays=…&locationId=…&sku=…
 *
 * Surfaces:
 *   - KPI strip across the window (events, currently-open, total
 *     duration, lost units, lost revenue, lost margin)
 *   - Filter row (status pill, window, location <select>, SKU search)
 *   - Dense event table with per-event lifecycle, lost-margin/units,
 *     and a per-SKU drilldown badge that links into /products/[id].
 *
 * Density follows the operator preference: every column visible, no
 * "More" dropdowns hiding anything, dark-mode parity baked in.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowLeft, RefreshCw, Search, X, AlertCircle,
  Clock, Package, MapPin,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

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

const WINDOW_OPTIONS = [7, 30, 90, 180, 365] as const

function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return `${(cents / 100).toFixed(0)}€`
}

function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10)
}

function formatDuration(days: number | string | null, endedAt: string | null, startedAt: string): string {
  if (days != null) {
    const n = typeof days === 'string' ? parseFloat(days) : days
    if (Number.isFinite(n)) return `${n.toFixed(1)}d`
  }
  if (!endedAt) {
    const ms = Date.now() - new Date(startedAt).getTime()
    return `${(ms / 86400_000).toFixed(1)}d (open)`
  }
  return '—'
}

export default function StockoutsClient() {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [summary, setSummary] = useState<StockoutSummary | null>(null)
  const [events, setEvents] = useState<StockoutEvent[] | null>(null)
  const [locations, setLocations] = useState<Location[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [windowDays, setWindowDays] = useState<number>(30)
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>('all')
  const [locationFilter, setLocationFilter] = useState<string>('')
  const [skuQuery, setSkuQuery] = useState('')
  const [skuQueryDebounced, setSkuQueryDebounced] = useState('')

  // Debounce the SKU search so each keystroke doesn't hammer the API.
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
        setLocations(
          arr
            .filter((l: any) => l && l.id && l.code)
            .map((l: any) => ({ id: l.id, code: l.code, name: l.name ?? l.code })),
        )
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [windowDays, statusFilter, locationFilter, skuQueryDebounced])

  useEffect(() => { fetchAll() }, [fetchAll])

  const triggerSweep = async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/replenishment/stockouts/sweep`, {
        method: 'POST',
      })
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
      { key: 'eventsInWindow', label: t('stock.stockouts.kpi.events'), value: summary.eventsInWindow, fmt: (v: number) => String(v) },
      { key: 'openCount', label: t('stock.stockouts.kpi.open'), value: summary.openCount, fmt: (v: number) => String(v), tone: summary.openCount > 0 ? 'warning' : 'neutral' as const },
      { key: 'totalDurationDays', label: t('stock.stockouts.kpi.totalDays'), value: summary.totalDurationDays, fmt: (v: number) => `${v.toFixed(1)}d` },
      { key: 'totalLostUnits', label: t('stock.stockouts.kpi.lostUnits'), value: summary.totalLostUnits, fmt: (v: number) => String(v) },
      { key: 'totalLostRevenueCents', label: t('stock.stockouts.kpi.lostRevenue'), value: summary.totalLostRevenueCents, fmt: formatCents },
      { key: 'totalLostMarginCents', label: t('stock.stockouts.kpi.lostMargin'), value: summary.totalLostMarginCents, fmt: formatCents, tone: 'danger' as const },
    ]
  }, [summary, t])

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
            <Link
              href="/fulfillment/stock"
              className="inline-flex items-center gap-1.5 h-11 sm:h-8 px-3 text-base text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:text-slate-100"
            >
              <ArrowLeft size={14} aria-hidden="true" /> {t('stock.title')}
            </Link>
            <Button variant="secondary" size="sm" onClick={fetchAll} disabled={loading}>
              <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} aria-hidden="true" />
              {t('stock.stockouts.refresh')}
            </Button>
            <Button variant="secondary" size="sm" onClick={triggerSweep} disabled={loading}>
              <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
              {t('stock.stockouts.sweep')}
            </Button>
          </div>
        }
      />
      <StockSubNav />

      {/* KPI strip */}
      {kpis && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          {kpis.map((k) => (
            <Card key={k.key} className="!p-3">
              <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
                {k.label}
              </div>
              <div
                className={cn(
                  'text-xl font-semibold tabular-nums mt-1',
                  k.tone === 'danger' && 'text-rose-700 dark:text-rose-400',
                  k.tone === 'warning' && 'text-amber-700 dark:text-amber-400',
                  (!k.tone || k.tone === 'neutral') && 'text-slate-900 dark:text-slate-100',
                )}
              >
                {k.fmt(k.value as any)}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Filter row */}
      <Card className="!p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            {(['all', 'open', 'closed'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={cn(
                  'px-3 py-1 text-sm font-medium rounded border transition-colors',
                  statusFilter === s
                    ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100'
                    : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                )}
              >
                {t(`stock.stockouts.status.${s}`)}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <label htmlFor="stockouts-window" className="text-sm text-slate-500 dark:text-slate-400">
              {t('stock.stockouts.windowLabel')}
            </label>
            <select
              id="stockouts-window"
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value))}
              className="h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
            >
              {WINDOW_OPTIONS.map((d) => (
                <option key={d} value={d}>{d}d</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <label htmlFor="stockouts-location" className="text-sm text-slate-500 dark:text-slate-400">
              {t('stock.stockouts.locationLabel')}
            </label>
            <select
              id="stockouts-location"
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
              className="h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
            >
              <option value="">{t('stock.stockouts.locationAny')}</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.code} — {l.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1 flex-1 min-w-[200px]">
            <Search className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" aria-hidden="true" />
            <input
              type="text"
              value={skuQuery}
              onChange={(e) => setSkuQuery(e.target.value)}
              placeholder={t('stock.stockouts.skuPlaceholder')}
              className="flex-1 h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
            />
            {skuQuery && (
              <button
                type="button"
                onClick={() => setSkuQuery('')}
                aria-label={t('common.close')}
                className="h-8 w-8 inline-flex items-center justify-center rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </Card>

      {error && (
        <Card className="!p-3 border-rose-200 dark:border-rose-700/50 bg-rose-50 dark:bg-rose-950/30">
          <div className="flex items-center gap-2 text-sm text-rose-700 dark:text-rose-300">
            <AlertCircle className="w-4 h-4" aria-hidden="true" />
            {error}
          </div>
        </Card>
      )}

      {/* Event table */}
      {events && events.length === 0 ? (
        <EmptyState
          icon={Package}
          title={t('stock.stockouts.empty.title')}
          description={t('stock.stockouts.empty.description')}
        />
      ) : (
        <Card className="!p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
                <tr className="text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="px-3 py-2 font-semibold">{t('stock.stockouts.col.sku')}</th>
                  <th className="px-3 py-2 font-semibold">{t('stock.stockouts.col.location')}</th>
                  <th className="px-3 py-2 font-semibold">{t('stock.stockouts.col.started')}</th>
                  <th className="px-3 py-2 font-semibold">{t('stock.stockouts.col.duration')}</th>
                  <th className="px-3 py-2 font-semibold text-right">{t('stock.stockouts.col.velocity')}</th>
                  <th className="px-3 py-2 font-semibold text-right">{t('stock.stockouts.col.lostUnits')}</th>
                  <th className="px-3 py-2 font-semibold text-right">{t('stock.stockouts.col.lostRevenue')}</th>
                  <th className="px-3 py-2 font-semibold text-right">{t('stock.stockouts.col.lostMargin')}</th>
                  <th className="px-3 py-2 font-semibold">{t('stock.stockouts.col.detectedBy')}</th>
                  <th className="px-3 py-2 font-semibold">{t('stock.stockouts.col.notes')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {(events ?? []).map((e) => {
                  const isOpen = !e.endedAt
                  const velocity = typeof e.velocityAtStart === 'string' ? parseFloat(e.velocityAtStart) : e.velocityAtStart
                  return (
                    <tr key={e.id} className={cn(
                      'hover:bg-slate-50 dark:hover:bg-slate-800',
                      isOpen && 'bg-amber-50/50 dark:bg-amber-950/20',
                    )}>
                      <td className="px-3 py-2 font-mono">
                        <Link
                          href={`/products?sku=${encodeURIComponent(e.sku)}`}
                          className="text-blue-700 dark:text-blue-400 hover:underline"
                        >
                          {e.sku}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                        {e.location ? (
                          <span className="inline-flex items-center gap-1">
                            <MapPin size={11} className="text-slate-400 dark:text-slate-500" aria-hidden="true" />
                            {e.location.code}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300 tabular-nums">
                        {formatDate(e.startedAt)}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        <span className={cn(
                          'inline-flex items-center gap-1',
                          isOpen ? 'text-amber-700 dark:text-amber-400 font-semibold' : 'text-slate-700 dark:text-slate-300',
                        )}>
                          <Clock size={11} aria-hidden="true" />
                          {formatDuration(e.durationDays, e.endedAt, e.startedAt)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                        {Number.isFinite(velocity) ? `${velocity.toFixed(2)}/d` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                        {e.estimatedLostUnits ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                        {formatCents(e.estimatedLostRevenue)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-rose-700 dark:text-rose-400 font-semibold">
                        {formatCents(e.estimatedLostMargin)}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={e.detectedBy === 'cron' ? 'default' : e.detectedBy === 'movement' ? 'info' : 'warning'}>
                          {e.detectedBy}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-slate-500 dark:text-slate-400 max-w-[200px] truncate" title={e.notes ?? ''}>
                        {e.notes ?? '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {events && events.length >= 200 && (
            <div className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400 border-t border-slate-100 dark:border-slate-800">
              {t('stock.stockouts.limitNote')}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
