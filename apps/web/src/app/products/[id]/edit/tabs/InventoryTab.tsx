'use client'

/**
 * W2.5 — Inventory tab on /products/[id]/edit.
 *
 * Surfaces the per-product stock + sales velocity + ATP + reservations
 * + recent movements that already power the /fulfillment/stock
 * drawer, but on the canonical edit page where Awa lives. Read-only
 * view; mutations stay in /fulfillment/stock so the audit trail for
 * stock changes has one canonical caller.
 *
 * Backed by GET /api/stock/product/:productId (one endpoint, every
 * fact in one round-trip).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ExternalLink,
  Loader2,
  Package,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import Link from 'next/link'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

interface StockLevelRow {
  id: string
  location: {
    id: string
    code: string
    name: string
    type: string
    isActive: boolean
  }
  quantity: number
  reserved: number
  available: number
  reorderThreshold: number | null
  lastUpdatedAt: string
  lastSyncedAt: string | null
  syncStatus: string | null
  activeReservations: number
}

interface ChannelListingRow {
  id: string
  channel: string
  marketplace: string
  listingStatus: string
  syncStatus: string | null
  lastSyncedAt: string | null
  lastSyncStatus: string | null
  lastSyncError: string | null
  quantity: number | null
  stockBuffer: number | null
  externalListingId: string | null
}

interface MovementRow {
  id: string
  movementType: string
  quantityChange: number
  newQuantity: number
  reason: string | null
  source: string | null
  createdAt: string
  location?: { id: string; code: string; name: string } | null
}

interface ReservationRow {
  id: string
  quantity: number
  expiresAt: string | null
  reason: string | null
  source: string | null
  createdAt: string
  location: { id: string; code: string }
}

interface StockProductSnapshot {
  product: {
    id: string
    sku: string
    name: string
    totalStock: number
    lowStockThreshold: number
    basePrice: number | null
    costPrice: number | null
    thumbnailUrl: string | null
  }
  stockLevels: StockLevelRow[]
  channelListings: ChannelListingRow[]
  movements: MovementRow[]
  reservations: ReservationRow[]
  salesVelocity: {
    last30Units: number
    last30Revenue: number
    avgDailyUnits: number
    daysOfStock: number | null
    totalAvailable: number
  }
  atpPerChannel?: Array<{
    channel: string
    marketplace: string
    atp: number
  }>
}

interface Props {
  product: any
  onDirtyChange: (count: number) => void
  discardSignal: number
}

export default function InventoryTab({
  product,
  onDirtyChange,
  discardSignal,
}: Props) {
  const { t } = useTranslations()
  const [snap, setSnap] = useState<StockProductSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Stable "tab is never dirty" signal.
  const reportedRef = useRef(false)
  useEffect(() => {
    if (reportedRef.current) return
    reportedRef.current = true
    onDirtyChange(0)
  }, [onDirtyChange])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/stock/product/${product.id}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as StockProductSnapshot
      setSnap(json)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setRefreshing(false)
    }
  }, [product.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Discard nudge: refetch so any concurrent stock movement shows up.
  const discardSeen = useRef(discardSignal)
  useEffect(() => {
    if (discardSignal === discardSeen.current) return
    discardSeen.current = discardSignal
    void refresh()
  }, [discardSignal, refresh])

  if (error) {
    return (
      <Card>
        <div className="text-sm text-rose-700 dark:text-rose-300 inline-flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      </Card>
    )
  }

  if (!snap) {
    return (
      <Card>
        <div className="text-sm italic text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {t('products.edit.inventory.loading')}
        </div>
      </Card>
    )
  }

  const stockBelowThreshold =
    snap.salesVelocity.totalAvailable < snap.product.lowStockThreshold
  const stockoutSoon =
    snap.salesVelocity.daysOfStock != null &&
    snap.salesVelocity.daysOfStock < 14

  return (
    <div className="space-y-4">
      {/* ── Hero / sales velocity ─────────────────────────────── */}
      <Card noPadding>
        <div className="px-4 py-4 grid grid-cols-2 md:grid-cols-5 gap-4">
          <Stat
            label={t('products.edit.inventory.totalAvailable')}
            value={snap.salesVelocity.totalAvailable.toLocaleString()}
            tone={
              stockBelowThreshold ? 'danger' : stockoutSoon ? 'warning' : 'default'
            }
            icon={
              stockBelowThreshold ? (
                <TrendingDown className="w-3.5 h-3.5" />
              ) : (
                <Package className="w-3.5 h-3.5" />
              )
            }
          />
          <Stat
            label={t('products.edit.inventory.totalStock')}
            value={snap.product.totalStock.toLocaleString()}
          />
          <Stat
            label={t('products.edit.inventory.daysOfStock')}
            value={
              snap.salesVelocity.daysOfStock != null
                ? `${snap.salesVelocity.daysOfStock}d`
                : '—'
            }
            tone={
              snap.salesVelocity.daysOfStock != null &&
              snap.salesVelocity.daysOfStock < 14
                ? 'warning'
                : 'default'
            }
          />
          <Stat
            label={t('products.edit.inventory.last30Units')}
            value={snap.salesVelocity.last30Units.toLocaleString()}
            icon={<TrendingUp className="w-3.5 h-3.5" />}
          />
          <Stat
            label={t('products.edit.inventory.last30Revenue')}
            value={`€${snap.salesVelocity.last30Revenue.toFixed(2)}`}
          />
        </div>
        <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {t('products.edit.inventory.thresholdHint', {
              threshold: snap.product.lowStockThreshold,
            })}
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/fulfillment/stock?productId=${product.id}`}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
            >
              {t('products.edit.inventory.openInStock')}
              <ExternalLink className="w-3 h-3" />
            </Link>
            <Button
              variant="ghost"
              size="sm"
              loading={refreshing}
              icon={<RefreshCw className="w-3.5 h-3.5" />}
              onClick={() => void refresh()}
            >
              {t('products.edit.inventory.refresh')}
            </Button>
          </div>
        </div>
      </Card>

      {/* ── Per-location stock ───────────────────────────────── */}
      <Card
        title={t('products.edit.inventory.byLocationTitle')}
        description={t('products.edit.inventory.byLocationDesc')}
      >
        {snap.stockLevels.length === 0 ? (
          <div className="text-sm italic text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded p-4 text-center">
            {t('products.edit.inventory.byLocationEmpty')}
          </div>
        ) : (
          <table className="w-full text-sm border border-slate-200 dark:border-slate-800 rounded overflow-hidden">
            <thead className="bg-slate-50 dark:bg-slate-900">
              <tr className="text-left">
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {t('products.edit.inventory.colLocation')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">
                  {t('products.edit.inventory.colOnHand')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">
                  {t('products.edit.inventory.colReserved')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">
                  {t('products.edit.inventory.colAvailable')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">
                  {t('products.edit.inventory.colReorder')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {t('products.edit.inventory.colSync')}
                </th>
              </tr>
            </thead>
            <tbody>
              {snap.stockLevels.map((sl) => {
                const lowAtThisLoc =
                  sl.reorderThreshold != null && sl.available < sl.reorderThreshold
                return (
                  <tr
                    key={sl.id}
                    className="border-t border-slate-200 dark:border-slate-800"
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Badge mono variant="default">
                          {sl.location.code}
                        </Badge>
                        <span className="text-slate-700 dark:text-slate-300">
                          {sl.location.name}
                        </span>
                        <span className="text-xs text-slate-500 dark:text-slate-400 lowercase">
                          {sl.location.type}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {sl.quantity.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">
                      {sl.reserved.toLocaleString()}
                    </td>
                    <td
                      className={cn(
                        'px-3 py-2 text-right tabular-nums font-medium',
                        lowAtThisLoc &&
                          'text-rose-700 dark:text-rose-300 bg-rose-50/40 dark:bg-rose-950/20',
                      )}
                    >
                      {sl.available.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                      {sl.reorderThreshold != null
                        ? sl.reorderThreshold.toLocaleString()
                        : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <SyncBadge status={sl.syncStatus} />
                      {sl.lastSyncedAt && (
                        <div
                          className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums"
                          title={sl.lastSyncedAt}
                        >
                          {formatRelative(sl.lastSyncedAt)}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>

      {/* ── Per-channel ATP ──────────────────────────────────── */}
      {snap.channelListings.length > 0 && (
        <Card
          title={t('products.edit.inventory.byChannelTitle')}
          description={t('products.edit.inventory.byChannelDesc')}
        >
          <table className="w-full text-sm border border-slate-200 dark:border-slate-800 rounded overflow-hidden">
            <thead className="bg-slate-50 dark:bg-slate-900">
              <tr className="text-left">
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {t('products.edit.inventory.colChannel')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {t('products.edit.inventory.colListingStatus')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">
                  {t('products.edit.inventory.colExposed')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">
                  {t('products.edit.inventory.colBuffer')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">
                  {t('products.edit.inventory.colAtp')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {t('products.edit.inventory.colSync')}
                </th>
              </tr>
            </thead>
            <tbody>
              {snap.channelListings.map((cl) => {
                const atpRow = snap.atpPerChannel?.find(
                  (r) =>
                    r.channel === cl.channel && r.marketplace === cl.marketplace,
                )
                return (
                  <tr
                    key={cl.id}
                    className="border-t border-slate-200 dark:border-slate-800"
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Badge mono variant="info">
                          {cl.channel}
                        </Badge>
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          {cl.marketplace}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <ListingStatus status={cl.listingStatus} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {cl.quantity != null ? cl.quantity.toLocaleString() : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                      {cl.stockBuffer != null
                        ? cl.stockBuffer.toLocaleString()
                        : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">
                      {atpRow ? atpRow.atp.toLocaleString() : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <SyncBadge status={cl.syncStatus} />
                      {cl.lastSyncError && (
                        <div
                          className="text-xs text-rose-700 dark:text-rose-300 mt-0.5 max-w-xs truncate"
                          title={cl.lastSyncError}
                        >
                          {cl.lastSyncError}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* ── Active reservations ──────────────────────────────── */}
      {snap.reservations.length > 0 && (
        <Card
          title={t('products.edit.inventory.reservationsTitle')}
          description={t('products.edit.inventory.reservationsDesc')}
        >
          <table className="w-full text-sm border border-slate-200 dark:border-slate-800 rounded overflow-hidden">
            <thead className="bg-slate-50 dark:bg-slate-900">
              <tr className="text-left">
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {t('products.edit.inventory.colLocation')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">
                  {t('products.edit.inventory.colQty')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {t('products.edit.inventory.colSource')}
                </th>
                <th className="px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {t('products.edit.inventory.colExpires')}
                </th>
              </tr>
            </thead>
            <tbody>
              {snap.reservations.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-slate-200 dark:border-slate-800"
                >
                  <td className="px-3 py-2">
                    <Badge mono variant="default">
                      {r.location.code}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.quantity}
                  </td>
                  <td className="px-3 py-2 text-slate-700 dark:text-slate-300 truncate max-w-xs">
                    {r.source ?? r.reason ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-slate-500 dark:text-slate-400 tabular-nums">
                    {r.expiresAt ? formatAbsolute(r.expiresAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* ── Recent movements ─────────────────────────────────── */}
      <Card
        title={t('products.edit.inventory.movementsTitle')}
        description={t('products.edit.inventory.movementsDesc')}
      >
        {snap.movements.length === 0 ? (
          <div className="text-sm italic text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded p-4 text-center">
            {t('products.edit.inventory.movementsEmpty')}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
            {snap.movements.slice(0, 50).map((m) => (
              <li
                key={m.id}
                className="px-3 py-2 flex items-center justify-between gap-3 bg-white dark:bg-slate-900"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className={cn(
                      'inline-flex items-center px-1.5 py-0.5 text-xs rounded font-mono font-medium',
                      m.quantityChange < 0
                        ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300'
                        : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300',
                    )}
                  >
                    {m.quantityChange > 0 ? '+' : ''}
                    {m.quantityChange}
                  </span>
                  <Badge mono variant="default">
                    {m.movementType}
                  </Badge>
                  {m.location && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      → {m.location.code}
                    </span>
                  )}
                  <span className="text-md text-slate-700 dark:text-slate-300 truncate">
                    {m.reason ?? m.source ?? '—'}
                  </span>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums flex-shrink-0">
                  {formatAbsolute(m.createdAt)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

// ── Components ─────────────────────────────────────────────────
function Stat({
  label,
  value,
  tone = 'default',
  icon,
}: {
  label: string
  value: string
  tone?: 'default' | 'warning' | 'danger'
  icon?: React.ReactNode
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div
        className={cn(
          'text-xl font-semibold tabular-nums mt-0.5',
          tone === 'default' && 'text-slate-900 dark:text-slate-100',
          tone === 'warning' && 'text-amber-700 dark:text-amber-300',
          tone === 'danger' && 'text-rose-700 dark:text-rose-300',
        )}
      >
        {value}
      </div>
    </div>
  )
}

function SyncBadge({
  status,
}: {
  status: string | null
}) {
  if (!status) {
    return (
      <span className="text-xs text-slate-500 dark:text-slate-400">—</span>
    )
  }
  const lower = status.toLowerCase()
  const variant: 'success' | 'warning' | 'danger' | 'default' =
    lower === 'success' || lower === 'synced'
      ? 'success'
      : lower === 'pending' || lower === 'queued'
        ? 'warning'
        : lower === 'error' || lower === 'failed'
          ? 'danger'
          : 'default'
  return <Badge variant={variant}>{status}</Badge>
}

function ListingStatus({
  status,
}: {
  status: string
}) {
  const variant: 'success' | 'info' | 'default' | 'warning' =
    status === 'ACTIVE'
      ? 'success'
      : status === 'PAUSED' || status === 'INACTIVE'
        ? 'warning'
        : status === 'DRAFT'
          ? 'default'
          : 'info'
  return <Badge variant={variant}>{status}</Badge>
}

// ── Helpers ────────────────────────────────────────────────────
function formatAbsolute(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return iso
  }
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime()
  if (Number.isNaN(ts)) return iso
  const diff = Date.now() - ts
  if (diff < 0) return 'just now'
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
