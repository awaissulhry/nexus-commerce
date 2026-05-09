'use client'

/**
 * LP.1 — Lots dashboard. Default sort by expiresAt ASC (FEFO order)
 * with quick filter chips for "expiring soon" / "active only".
 *
 * Per-row: lot number, product, units remaining/received, expires,
 * recall flag, supplier ref. Click row → /fulfillment/stock/recalls/X
 * if a recall exists (most operationally relevant), else expand
 * inline with full provenance.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Package, RefreshCw, AlertCircle } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { formatRelative } from '@/components/inventory/formatRelative'

interface Lot {
  id: string
  lotNumber: string
  receivedAt: string
  expiresAt: string | null
  unitsReceived: number
  unitsRemaining: number
  supplierLotRef: string | null
  product: { id: string; sku: string; name: string }
  variation: { id: string; sku: string } | null
}

type ExpiryFilter = 'all' | 'expiring30' | 'expiring90'

export default function LotsClient() {
  const { t } = useTranslations()
  const [lots, setLots] = useState<Lot[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeOnly, setActiveOnly] = useState(true)
  const [expiry, setExpiry] = useState<ExpiryFilter>('all')

  const fetchLots = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (!activeOnly) params.set('activeOnly', '0')
      if (expiry === 'expiring30') params.set('expiringWithinDays', '30')
      else if (expiry === 'expiring90') params.set('expiringWithinDays', '90')
      params.set('limit', '500')
      const res = await fetch(`${getBackendUrl()}/api/stock/lots?${params}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      setLots(body.items)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }, [activeOnly, expiry])

  useEffect(() => { fetchLots() }, [fetchLots])

  return (
    <div className="p-3 sm:p-6 space-y-3 sm:space-y-6">
      <PageHeader
        title={t('stock.lots.pageTitle')}
        description={t('stock.lots.pageDescription')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('stock.lots.pageTitle') },
        ]}
        actions={
          <Button variant="secondary" size="sm" onClick={fetchLots} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          </Button>
        }
      />
      <StockSubNav />

      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center gap-1 border border-slate-200 dark:border-slate-700 rounded-md p-0.5">
          {(['all', 'expiring30', 'expiring90'] as const).map((e) => (
            <button
              key={e}
              onClick={() => setExpiry(e)}
              aria-pressed={expiry === e}
              className={
                'h-8 px-3 text-sm rounded ' +
                (expiry === e ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800')
              }
            >
              {t(`stock.lots.filter.${e}` as any)}
            </button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
          />
          {t('stock.lots.activeOnly')}
        </label>
      </div>

      {error && (
        <Card>
          <div className="text-rose-700 inline-flex items-center gap-2">
            <AlertCircle size={14} aria-hidden="true" /> {error}
          </div>
        </Card>
      )}

      {!loading && lots?.length === 0 && (
        <EmptyState icon={Package} title={t('stock.lots.empty.title')} description={t('stock.lots.empty.description')} />
      )}

      {lots && lots.length > 0 && (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
                <tr>
                  <th className="px-3 py-2 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('stock.lots.col.lot')}</th>
                  <th className="px-3 py-2 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('stock.lots.col.product')}</th>
                  <th className="px-3 py-2 text-right text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('stock.lots.col.units')}</th>
                  <th className="px-3 py-2 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('stock.lots.col.expires')}</th>
                  <th className="px-3 py-2 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('stock.lots.col.received')}</th>
                  <th className="px-3 py-2 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('stock.lots.col.supplierRef')}</th>
                </tr>
              </thead>
              <tbody>
                {lots.map((lot) => {
                  const expiresInDays = lot.expiresAt
                    ? Math.ceil((new Date(lot.expiresAt).getTime() - Date.now()) / 86400_000)
                    : null
                  const expiringSoon = expiresInDays != null && expiresInDays <= 30
                  return (
                    <tr key={lot.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                      <td className="px-3 py-2 font-mono text-slate-900 dark:text-slate-100 whitespace-nowrap">{lot.lotNumber}</td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-300 truncate max-w-md">
                        <Link href={`/products/${lot.product.id}/edit`} className="hover:underline">
                          <span className="font-mono text-xs text-slate-500">{lot.product.sku}</span> · {lot.product.name}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                        <span className="font-semibold">{lot.unitsRemaining}</span>
                        <span className="text-slate-400">/{lot.unitsReceived}</span>
                      </td>
                      <td className="px-3 py-2 text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {lot.expiresAt
                          ? <span className={expiringSoon ? 'text-amber-700 dark:text-amber-400 font-medium' : ''}>
                              {new Date(lot.expiresAt).toLocaleDateString()}
                              {expiringSoon && <> · <span className="text-xs">{t('stock.lots.expiringInDays', { days: expiresInDays })}</span></>}
                            </span>
                          : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{formatRelative(lot.receivedAt, t)}</td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                        {lot.supplierLotRef ?? <span className="text-slate-300">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
