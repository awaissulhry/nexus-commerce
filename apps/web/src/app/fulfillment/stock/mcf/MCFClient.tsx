'use client'

/**
 * S.24 — MCF dashboard.
 *
 * Lists Amazon Multi-Channel Fulfillment shipments. Operators can:
 *   - Filter by status (All / Active / Complete / Cancelled)
 *   - Sync a row's status on-demand (cron does the same poll every 15 min)
 *   - Cancel an active shipment
 *
 * Order creation lives on the outbound shipment surface (out of
 * /fulfillment/stock scope) — that surface posts to /api/stock/mcf/create.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Truck, ArrowLeft, RefreshCw, AlertCircle, X,
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

type StatusFilter = 'all' | 'active' | 'COMPLETE' | 'CANCELLED'

interface MCFRow {
  id: string
  orderId: string
  channelOrderId: string
  channel: string
  amazonFulfillmentOrderId: string
  status: string
  trackingNumber: string | null
  carrier: string | null
  shippedAt: string | null
  deliveredAt: string | null
  requestedAt: string
  lastSyncedAt: string | null
  lastError: string | null
}

const FILTERS: { key: StatusFilter; labelKey: string }[] = [
  { key: 'all',       labelKey: 'stock.mcf.filter.all' },
  { key: 'active',    labelKey: 'stock.mcf.filter.active' },
  { key: 'COMPLETE',  labelKey: 'stock.mcf.filter.complete' },
  { key: 'CANCELLED', labelKey: 'stock.mcf.filter.cancelled' },
]

function statusVariant(status: string): 'success' | 'warning' | 'danger' | 'info' | 'default' {
  if (status === 'COMPLETE' || status === 'COMPLETE_PARTIALLED') return 'success'
  if (status === 'CANCELLED' || status === 'INVALID' || status === 'UNFULFILLABLE') return 'danger'
  if (status === 'PROCESSING' || status === 'PLANNING') return 'info'
  if (status === 'NEW' || status === 'RECEIVED') return 'warning'
  return 'default'
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'now'
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function MCFClient() {
  const { t } = useTranslations()
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [shipments, setShipments] = useState<MCFRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('active')
  const [actingId, setActingId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/stock/mcf?status=${filter}&limit=200`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setShipments(json.shipments ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { fetchData() }, [fetchData])

  const handleSync = useCallback(async (s: MCFRow) => {
    setActingId(s.id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/mcf/${s.id}/sync`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      if (body.changed) toast.success(t('stock.mcf.toast.synced', { status: body.status }))
      else toast.success(t('stock.mcf.toast.syncedNoChange'))
      await fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setActingId(null)
    }
  }, [t, toast, fetchData])

  const handleCancel = useCallback(async (s: MCFRow) => {
    if (!(await askConfirm({
      title: t('stock.mcf.cancelConfirmTitle'),
      description: t('stock.mcf.cancelConfirmDescription'),
      confirmLabel: t('stock.mcf.cancel'),
      tone: 'warning',
    }))) return
    setActingId(s.id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/mcf/${s.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      toast.success(t('stock.mcf.toast.cancelled'))
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
        title={t('stock.mcf.title')}
        description={t('stock.mcf.description')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('stock.mcf.title') },
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

      <div className="flex items-center gap-1 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              'min-h-[44px] sm:min-h-0 px-2.5 py-1 text-sm font-medium rounded border transition-colors',
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

      {loading && shipments === null && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {shipments !== null && shipments.length === 0 && !loading && (
        <EmptyState
          icon={Truck}
          title={t('stock.mcf.empty.title')}
          description={t('stock.mcf.empty.description')}
          action={{ label: t('stock.title'), href: '/fulfillment/stock' }}
        />
      )}

      {shipments && shipments.length > 0 && (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-md">
              <thead className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
                <tr>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.mcf.col.order')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.mcf.col.amazonId')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.mcf.col.status')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.mcf.col.tracking')}</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.mcf.col.requested')}</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300"></th>
                </tr>
              </thead>
              <tbody>
                {shipments.map((s) => (
                  <tr key={s.id} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800">
                    <td className="px-3 py-2">
                      <div className="text-md font-medium text-slate-900 dark:text-slate-100 inline-flex items-center gap-1.5">
                        <Badge variant="default" size="sm">{s.channel}</Badge>
                        <span className="font-mono text-sm">{s.channelOrderId}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500 dark:text-slate-400" title={s.amazonFulfillmentOrderId}>
                      {s.amazonFulfillmentOrderId.slice(-16)}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={statusVariant(s.status)} size="sm">{s.status}</Badge>
                      {s.lastError && (
                        <div className="text-xs text-rose-600 mt-0.5 truncate max-w-xs" title={s.lastError}>
                          {s.lastError.slice(0, 60)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-sm text-slate-700 dark:text-slate-300">
                      {s.trackingNumber ? (
                        <div>
                          <div className="font-mono">{s.trackingNumber}</div>
                          {s.carrier && <div className="text-xs text-slate-500 dark:text-slate-400">{s.carrier}</div>}
                        </div>
                      ) : (
                        <span className="text-slate-400 dark:text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-sm text-slate-500 dark:text-slate-400" title={new Date(s.requestedAt).toLocaleString()}>
                      {formatRelative(s.requestedAt)}
                      {s.lastSyncedAt && (
                        <div className="text-xs text-slate-400 dark:text-slate-500">
                          synced {formatRelative(s.lastSyncedAt)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleSync(s)}
                          disabled={actingId === s.id}
                          className="min-h-[44px] sm:min-h-0 px-2 py-1 text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                          title={t('stock.mcf.syncTitle')}
                          aria-label={t('stock.mcf.syncTitle')}
                        >
                          <RefreshCw size={11} aria-hidden="true" className={actingId === s.id ? 'animate-spin' : ''} />
                        </button>
                        {!['COMPLETE', 'COMPLETE_PARTIALLED', 'CANCELLED', 'UNFULFILLABLE', 'INVALID'].includes(s.status) && (
                          <button
                            type="button"
                            onClick={() => handleCancel(s)}
                            disabled={actingId === s.id}
                            aria-label={t('stock.mcf.cancel')}
                            className="min-h-[44px] sm:min-h-0 px-2 py-1 text-sm font-medium text-rose-700 bg-white dark:bg-slate-900 border border-rose-200 rounded hover:bg-rose-50 disabled:opacity-50"
                          >
                            <X size={11} aria-hidden="true" />
                          </button>
                        )}
                      </div>
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
