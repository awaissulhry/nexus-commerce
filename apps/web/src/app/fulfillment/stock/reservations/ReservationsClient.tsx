'use client'

/**
 * S.13 — Reservations list. Reads /api/stock/reservations and shows
 * the full lifecycle: active / consumed / released / expired. Active
 * rows display a TTL countdown so operators see how long until
 * auto-release; settled rows show the resolution timestamp.
 *
 * Status filter chips switch the API filter (active/consumed/released/all).
 * The release button on each active row hits POST /api/stock/release/:id
 * — same endpoint the per-product drawer uses (S.4 wired the confirm
 * primitive there; here we wire it the same way).
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Lock as LockIcon, ArrowLeft, Package, RefreshCw, AlertCircle, X,
  Clock, CheckCircle2, Ban,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

type ReservationStatus = 'active' | 'consumed' | 'released' | 'expired'

interface Reservation {
  id: string
  quantity: number
  reason: string
  orderId: string | null
  createdAt: string
  expiresAt: string
  releasedAt: string | null
  consumedAt: string | null
  status: ReservationStatus
  ttlMs: number | null
  location: { id: string; code: string; name: string; type: string }
  stockLevel: { quantity: number; reserved: number; available: number }
  product: {
    id: string
    sku: string
    name: string
    amazonAsin: string | null
    thumbnailUrl: string | null
  } | null
}

const FILTER_OPTIONS = [
  { key: 'all',      labelKey: 'stock.reservations.filter.all' },
  { key: 'active',   labelKey: 'stock.reservations.filter.active' },
  { key: 'consumed', labelKey: 'stock.reservations.filter.consumed' },
  { key: 'released', labelKey: 'stock.reservations.filter.released' },
] as const

function formatTtl(ms: number, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (ms <= 0) return t('stock.reservations.expiring')
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

export default function ReservationsClient() {
  const { t } = useTranslations()
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [reservations, setReservations] = useState<Reservation[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'active' | 'consumed' | 'released'>('active')
  const [actingId, setActingId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/stock/reservations?status=${filter}&limit=200`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setReservations(json.reservations ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { fetchData() }, [fetchData])

  // Re-render the TTL clocks every 30s so the countdown stays live.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30000)
    return () => window.clearInterval(id)
  }, [])

  const handleRelease = useCallback(async (r: Reservation) => {
    if (!(await askConfirm({
      title: t('stock.drawer.releaseConfirm', { n: r.quantity }),
      confirmLabel: t('stock.drawer.release'),
      tone: 'warning',
    }))) return
    setActingId(r.id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/release/${r.id}`, { method: 'POST' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      toast.success(t('stock.reservations.releasedToast'))
      await fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setActingId(null)
    }
  }, [askConfirm, t, toast, fetchData])

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('stock.reservations.title')}
        description={t('stock.reservations.description')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('stock.reservations.title') },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/fulfillment/stock"
              className="inline-flex items-center gap-1.5 h-11 sm:h-8 px-3 text-base text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:text-slate-100"
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

      {/* Status filter chips */}
      <div className="flex items-center gap-1 flex-wrap">
        {FILTER_OPTIONS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              'min-h-[44px] sm:min-h-0 px-3 py-1 text-sm font-medium rounded border transition-colors',
              filter === f.key
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
            )}
          >
            {t(f.labelKey)}
          </button>
        ))}
      </div>

      {error && (
        <div className="text-base text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {loading && reservations === null && (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {reservations !== null && reservations.length === 0 && !loading && (
        <EmptyState
          icon={LockIcon}
          title={t('stock.reservations.empty.title')}
          description={t('stock.reservations.empty.description')}
          action={{ label: t('stock.title'), href: '/fulfillment/stock' }}
        />
      )}

      {reservations && reservations.length > 0 && (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-md">
              <thead className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
                <tr>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.reservations.col.product')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.reservations.col.location')}</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.reservations.col.quantity')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.reservations.col.reason')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.reservations.col.status')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.reservations.col.when')}</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300"></th>
                </tr>
              </thead>
              <tbody>
                {reservations.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {r.product?.thumbnailUrl ? (
                          <img src={r.product.thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover bg-slate-100 dark:bg-slate-800" />
                        ) : (
                          <div className="w-8 h-8 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500">
                            <Package size={14} />
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="text-md font-medium text-slate-900 dark:text-slate-100 truncate max-w-md">{r.product?.name ?? '—'}</div>
                          <div className="text-sm text-slate-500 dark:text-slate-400 font-mono">
                            {r.product?.sku ?? ''}
                            {r.orderId && <span className="ml-1.5 text-slate-400 dark:text-slate-500">· order {r.orderId.slice(0, 8)}</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700" title={r.location.name}>
                        {r.location.code}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">{r.quantity}</td>
                    <td className="px-3 py-2 text-slate-700 dark:text-slate-300 text-sm">{r.reason}</td>
                    <td className="px-3 py-2">
                      <Badge
                        variant={
                          r.status === 'consumed' ? 'success' :
                          r.status === 'released' ? 'default' :
                          r.status === 'expired' ? 'danger' :
                          'info'
                        }
                        size="sm"
                      >
                        {r.status === 'consumed' && <CheckCircle2 size={10} className="mr-1" />}
                        {r.status === 'released' && <Ban size={10} className="mr-1" />}
                        {r.status === 'active' && <Clock size={10} className="mr-1" />}
                        {t(`stock.reservations.status.${r.status}`)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
                      {r.consumedAt && <span title={new Date(r.consumedAt).toLocaleString()}>{formatRelative(r.consumedAt)}</span>}
                      {!r.consumedAt && r.releasedAt && <span title={new Date(r.releasedAt).toLocaleString()}>{formatRelative(r.releasedAt)}</span>}
                      {!r.consumedAt && !r.releasedAt && r.ttlMs != null && (
                        <span className={cn('inline-flex items-center gap-1', r.ttlMs <= 60 * 60 * 1000 && 'text-amber-700 font-semibold')}>
                          <Clock size={11} className="opacity-60" />
                          {formatTtl(r.ttlMs, t)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.status === 'active' && (
                        <button
                          type="button"
                          onClick={() => handleRelease(r)}
                          disabled={actingId === r.id}
                          className="inline-flex items-center gap-1 min-h-[44px] sm:min-h-0 px-2 py-1 text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                        >
                          <X size={11} /> {t('stock.drawer.release')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
