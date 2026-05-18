'use client'

/**
 * S.13 — Reservations list. Shows active / consumed / released / expired
 * reservation lifecycle. Active rows display a live TTL countdown.
 *
 * S.2 — table replaced with SharedVirtualizedGrid.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Lock as LockIcon, ArrowLeft, Package, RefreshCw, AlertCircle, X,
  Clock, CheckCircle2, Ban, AlignJustify, Menu as MenuIcon, Equal,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { formatRelative } from '@/components/inventory/formatRelative'
import { cn } from '@/lib/utils'
import { VirtualizedGrid } from '@/app/_shared/grid-lens'
import type { GridLensColumn, GridLensRow } from '@/app/_shared/grid-lens'
import { type Density, DENSITY_CELL_CLASS } from '@/lib/products/theme'

// ── Types ─────────────────────────────────────────────────────────────

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
    id: string; sku: string; name: string
    amazonAsin: string | null; thumbnailUrl: string | null
  } | null
}

type ReservationRow = Reservation & GridLensRow

// ── Constants ─────────────────────────────────────────────────────────

const RESERVATION_COLUMNS: GridLensColumn[] = [
  { key: 'product',  label: 'Product',   subLabel: 'SKU · Name',        width: 280 },
  { key: 'location', label: 'Location',  subLabel: 'Code',              width: 100 },
  { key: 'quantity', label: 'Qty',       subLabel: 'Units held',        width: 80  },
  { key: 'reason',   label: 'Reason',    subLabel: 'Hold type',         width: 150 },
  { key: 'status',   label: 'Status',    subLabel: 'Lifecycle',         width: 110 },
  { key: 'when',     label: 'TTL / When',subLabel: 'Expires / resolved',width: 140 },
  { key: 'actions',  label: '',                                          width: 90  },
]

const FILTER_OPTIONS = [
  { key: 'all',      labelKey: 'stock.reservations.filter.all' },
  { key: 'active',   labelKey: 'stock.reservations.filter.active' },
  { key: 'consumed', labelKey: 'stock.reservations.filter.consumed' },
  { key: 'released', labelKey: 'stock.reservations.filter.released' },
] as const

const STORAGE_KEY = 'stock-reservations'
const _EMPTY_SET = new Set<string>()
const _EMPTY_MAP = {}
const _NOOP = () => {}

function formatTtl(ms: number, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (ms <= 0) return t('stock.reservations.expiring')
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

// ── Component ─────────────────────────────────────────────────────────

export default function ReservationsClient() {
  const { t } = useTranslations()
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [reservations, setReservations] = useState<Reservation[] | null>(null)
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState<string | null>(null)
  const [filter, setFilter]             = useState<'all' | 'active' | 'consumed' | 'released'>('active')
  const [actingId, setActingId]         = useState<string | null>(null)
  const [density, setDensity]           = useState<Density>(() => {
    try { return (localStorage.getItem(`${STORAGE_KEY}.density`) as Density) ?? 'comfortable' } catch { return 'comfortable' }
  })

  useEffect(() => {
    try { localStorage.setItem(`${STORAGE_KEY}.density`, density) } catch {}
  }, [density])

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/reservations?status=${filter}&limit=200`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setReservations(json.reservations ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setLoading(false) }
  }, [filter])

  useEffect(() => { fetchData() }, [fetchData])

  // Re-render TTL clocks every 30s so the countdown stays live.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick(n => n + 1), 30_000)
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
    } finally { setActingId(null) }
  }, [askConfirm, t, toast, fetchData])

  const rows = useMemo((): ReservationRow[] =>
    (reservations ?? []).map(r => ({ ...r, isParent: false as const, childCount: 0, parentId: null })),
  [reservations])

  const cellPad = DENSITY_CELL_CLASS[density] ?? DENSITY_CELL_CLASS.comfortable

  const renderCell = useCallback((row: ReservationRow, colKey: string) => {
    switch (colKey) {
      case 'product':
        return (
          <div className="flex items-center gap-2 min-w-0">
            {row.product?.thumbnailUrl ? (
              <img src={row.product.thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover bg-slate-100 dark:bg-slate-800 flex-shrink-0" />
            ) : (
              <div className="w-8 h-8 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 flex-shrink-0">
                <Package size={14} />
              </div>
            )}
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{row.product?.name ?? '—'}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
                {row.product?.sku ?? ''}
                {row.orderId && <span className="ml-1.5 text-slate-400">· {t('stock.reservations.orderRef', { id: row.orderId.slice(0, 8) })}</span>}
              </div>
            </div>
          </div>
        )
      case 'location':
        return (
          <span className="inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700" title={row.location.name}>
            {row.location.code}
          </span>
        )
      case 'quantity':
        return <span className="tabular-nums font-semibold text-sm text-slate-900 dark:text-slate-100">{row.quantity}</span>
      case 'reason':
        return <span className="text-sm text-slate-700 dark:text-slate-300">{row.reason}</span>
      case 'status':
        return (
          <Badge
            variant={row.status === 'consumed' ? 'success' : row.status === 'released' ? 'default' : row.status === 'expired' ? 'danger' : 'info'}
            size="sm"
          >
            {row.status === 'consumed' && <CheckCircle2 size={10} className="mr-1" />}
            {row.status === 'released' && <Ban size={10} className="mr-1" />}
            {row.status === 'active' && <Clock size={10} className="mr-1" />}
            {t(`stock.reservations.status.${row.status}`)}
          </Badge>
        )
      case 'when':
        return (
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {row.consumedAt && <span title={new Date(row.consumedAt).toLocaleString()}>{formatRelative(row.consumedAt, t)}</span>}
            {!row.consumedAt && row.releasedAt && <span title={new Date(row.releasedAt).toLocaleString()}>{formatRelative(row.releasedAt, t)}</span>}
            {!row.consumedAt && !row.releasedAt && row.ttlMs != null && (
              <span className={cn('inline-flex items-center gap-1', row.ttlMs <= 60 * 60 * 1000 && 'text-amber-700 dark:text-amber-400 font-semibold')}>
                <Clock size={11} className="opacity-60" />
                {formatTtl(row.ttlMs, t)}
              </span>
            )}
          </span>
        )
      case 'actions':
        return row.status === 'active' ? (
          <button
            type="button"
            onClick={() => handleRelease(row)}
            disabled={actingId === row.id}
            className="inline-flex items-center gap-1 px-2 py-1 text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            <X size={11} /> {t('stock.drawer.release')}
          </button>
        ) : null
      default:
        return null
    }
  }, [t, actingId, handleRelease])

  const DENSITY_OPTIONS: { d: Density; icon: React.ReactNode; label: string }[] = [
    { d: 'compact',     icon: <AlignJustify size={13} />, label: 'Compact' },
    { d: 'comfortable', icon: <MenuIcon size={13} />,     label: 'Comfortable' },
    { d: 'spacious',    icon: <Equal size={13} />,        label: 'Spacious' },
  ]

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
            <Link href="/fulfillment/stock"
              className="inline-flex items-center gap-1.5 h-11 sm:h-8 px-3 text-base text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100">
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

      {/* Status filter + density */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          {FILTER_OPTIONS.map(f => (
            <button key={f.key} type="button" onClick={() => setFilter(f.key)}
              className={cn('min-h-[44px] sm:min-h-0 px-3 py-1 text-sm font-medium rounded border transition-colors',
                filter === f.key
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600')}>
              {t(f.labelKey)}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-0.5 border border-slate-200 dark:border-slate-700 rounded p-0.5">
          {DENSITY_OPTIONS.map(({ d, icon, label }) => (
            <button key={d} onClick={() => setDensity(d)} title={label} aria-pressed={density === d}
              className={`h-6 w-6 inline-flex items-center justify-center rounded transition-colors ${density === d ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
              {icon}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="text-base text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {loading && !reservations && (
        <div className="space-y-2">
          {[0,1,2,3].map(i => <div key={i} className="h-16 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg animate-pulse" />)}
        </div>
      )}

      {reservations !== null && rows.length === 0 && !loading && (
        <EmptyState icon={LockIcon} title={t('stock.reservations.empty.title')} description={t('stock.reservations.empty.description')}
          action={{ label: t('stock.title'), href: '/fulfillment/stock' }} />
      )}

      {rows.length > 0 && (
        <VirtualizedGrid
          rows={rows}
          visible={RESERVATION_COLUMNS}
          density={density}
          cellPad={cellPad}
          selected={_EMPTY_SET}
          toggleSelect={_NOOP as any}
          toggleSelectAll={_NOOP}
          allSelected={false}
          sortBy=""
          onSort={_NOOP as any}
          expandedParents={_EMPTY_SET}
          childrenByParent={_EMPTY_MAP}
          loadingChildren={_EMPTY_SET}
          onToggleExpand={_NOOP}
          focusedRowId={null}
          searchTerm=""
          riskFlaggedSkus={_EMPTY_SET}
          storageKey={STORAGE_KEY}
          showExpandColumn={false}
          renderCell={renderCell}
        />
      )}
    </div>
  )
}
