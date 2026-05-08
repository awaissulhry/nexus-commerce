'use client'

/**
 * S.13 — Transfers list. Reads /api/stock/transfers (paired
 * TRANSFER_OUT/TRANSFER_IN movements collapsed to a single row).
 * Status today is always COMPLETED — transferStock fires both halves
 * synchronously. A future TransferShipment table would add IN_TRANSIT;
 * the API already returns `status` so the UI is forward-compatible.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  ArrowRightLeft, ArrowLeft, Package, RefreshCw, AlertCircle,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'

interface Transfer {
  id: string
  siblingOutId: string | null
  quantity: number
  createdAt: string
  startedAt: string
  actor: string | null
  notes: string | null
  from: { id: string; code: string; name: string; type: string } | null
  to: { id: string; code: string; name: string; type: string } | null
  product: {
    id: string
    sku: string
    name: string
    amazonAsin: string | null
    thumbnailUrl: string | null
  } | null
  status: 'COMPLETED' | 'IN_TRANSIT'
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

export default function TransfersClient() {
  const { t } = useTranslations()
  const [transfers, setTransfers] = useState<Transfer[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/transfers?limit=100`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setTransfers(json.transfers ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('stock.transfers.title')}
        description={t('stock.transfers.description')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('stock.transfers.title') },
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

      {error && (
        <div className="text-base text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {loading && transfers === null && (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {transfers !== null && transfers.length === 0 && !loading && (
        <EmptyState
          icon={ArrowRightLeft}
          title={t('stock.transfers.empty.title')}
          description={t('stock.transfers.empty.description')}
          action={{ label: t('stock.title'), href: '/fulfillment/stock' }}
        />
      )}

      {transfers && transfers.length > 0 && (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-md">
              <thead className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
                <tr>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.transfers.col.product')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.transfers.col.from')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.transfers.col.to')}</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.transfers.col.quantity')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.transfers.col.status')}</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.transfers.col.when')}</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((tr) => (
                  <tr key={tr.id} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {tr.product?.thumbnailUrl ? (
                          <img src={tr.product.thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover bg-slate-100 dark:bg-slate-800" />
                        ) : (
                          <div className="w-8 h-8 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500">
                            <Package size={14} />
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="text-md font-medium text-slate-900 dark:text-slate-100 truncate max-w-md">
                            {tr.product?.name ?? '—'}
                          </div>
                          <div className="text-sm text-slate-500 dark:text-slate-400 font-mono">
                            {tr.product?.sku ?? ''}
                            {tr.product?.amazonAsin && <span> · {tr.product.amazonAsin}</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {tr.from ? (
                        <span className="inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700" title={tr.from.name}>
                          {tr.from.code}
                        </span>
                      ) : <span className="text-slate-400 dark:text-slate-500">—</span>}
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1">
                        <ArrowRightLeft size={12} className="text-slate-400 dark:text-slate-500" />
                        {tr.to ? (
                          <span className="inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700" title={tr.to.name}>
                            {tr.to.code}
                          </span>
                        ) : <span className="text-slate-400 dark:text-slate-500">—</span>}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                      {tr.quantity}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={tr.status === 'COMPLETED' ? 'success' : 'info'} size="sm">
                        {t(tr.status === 'COMPLETED' ? 'stock.transfers.status.completed' : 'stock.transfers.status.inTransit')}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400 text-sm" title={new Date(tr.createdAt).toLocaleString()}>
                      {formatRelative(tr.createdAt)}
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
