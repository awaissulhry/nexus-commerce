'use client'

/**
 * FCF.6 — Pool-drift triage surface.
 *
 * Portfolio view of active channel listings that publish MORE units than their
 * bound stock pool can actually back (drift > 0 = oversell risk):
 *   • FBM → own-warehouse available
 *   • FBA/MCF → FBA SELLABLE minus in-flight MCF reservations
 *
 * Read + drill: each row links to the product editor to fix (adjust qty /
 * restock / switch method). This is proactive — it warns BEFORE the marketplace
 * reports back, unlike the reactive channel-drift queue (CS series).
 *
 * Backed by GET /api/stock/pool-drift.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, AlertTriangle, ExternalLink, Truck, Warehouse } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { cn } from '@/lib/utils'

interface PoolDriftRow {
  productId: string
  sku: string
  name: string | null
  channel: string
  marketplace: string
  fulfillmentMethod: 'FBA' | 'FBM'
  pool: 'FBA' | 'FBM_WAREHOUSE'
  isMcf: boolean
  publishedQty: number
  availableToPublish: number
  drift: number
}
interface PoolDriftResponse {
  rows: PoolDriftRow[]
  scanned: number
  oversold: number
  truncated: boolean
}

export default function PoolDriftClient() {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [data, setData] = useState<PoolDriftResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [channelFilter, setChannelFilter] = useState('')
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)

  const fetchDrift = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/pool-drift`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as PoolDriftResponse
      setData(json)
      setLastFetchedAt(Date.now())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    fetchDrift()
  }, [fetchDrift])

  // A pool re-balance (stock move, order, MCF create/complete, listing push)
  // can open or close drift — refresh on the same events the stock app uses.
  useInvalidationChannel(
    ['stock.adjusted', 'stock.transferred', 'channel-pricing.updated', 'product.updated', 'inbound.received'],
    fetchDrift,
  )

  const channels = useMemo(
    () => Array.from(new Set((data?.rows ?? []).map((r) => r.channel))).sort(),
    [data],
  )
  const rows = useMemo(
    () => (data?.rows ?? []).filter((r) => !channelFilter || r.channel === channelFilter),
    [data, channelFilter],
  )

  function editHref(r: PoolDriftRow) {
    return r.channel === 'EBAY'
      ? `/products/${r.productId}/edit?tab=EBAY`
      : `/products/${r.productId}/matrix`
  }

  return (
    <div className="p-3 sm:p-6 space-y-3 sm:space-y-6">
      <PageHeader
        title={t('poolDrift.pageTitle')}
        description={t('poolDrift.pageDescription')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('poolDrift.pageTitle') },
        ]}
      />
      <StockSubNav />

      {/* Channel filter + summary + freshness */}
      <div className="flex items-center gap-2 flex-wrap">
        {channels.length > 1 && (
          <>
            <button
              onClick={() => setChannelFilter('')}
              aria-pressed={channelFilter === ''}
              className={cn(
                'h-7 px-3 text-sm rounded-full font-medium border',
                channelFilter === ''
                  ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900 dark:text-slate-900'
                  : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700',
              )}
            >
              {t('poolDrift.allChannels')}
            </button>
            {channels.map((c) => (
              <button
                key={c}
                onClick={() => setChannelFilter(c)}
                aria-pressed={channelFilter === c}
                className={cn(
                  'h-7 px-3 text-sm rounded-full font-medium border',
                  channelFilter === c
                    ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900 dark:text-slate-900'
                    : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700',
                )}
              >
                {c}
              </button>
            ))}
          </>
        )}
        <div className="ml-auto flex items-center gap-3">
          {data && (
            <span className="text-sm text-slate-500 dark:text-slate-400">
              {t('poolDrift.summary', { n: data.oversold })}
            </span>
          )}
          <FreshnessIndicator lastFetchedAt={lastFetchedAt} onRefresh={fetchDrift} loading={loading} />
        </div>
      </div>

      {data?.truncated && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle size={14} aria-hidden /> {t('poolDrift.truncated', { n: data.scanned })}
        </div>
      )}

      {!loading && rows.length === 0 && (
        <EmptyState
          icon={CheckCircle2}
          title={t('poolDrift.empty.title')}
          description={t('poolDrift.empty.description')}
        />
      )}

      {rows.length > 0 && (
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <th className="px-3 py-2">{t('poolDrift.col.product')}</th>
                <th className="px-3 py-2">{t('poolDrift.col.channel')}</th>
                <th className="px-3 py-2">{t('poolDrift.col.pool')}</th>
                <th className="px-3 py-2 text-right">{t('poolDrift.col.published')}</th>
                <th className="px-3 py-2 text-right">{t('poolDrift.col.available')}</th>
                <th className="px-3 py-2 text-right">{t('poolDrift.col.drift')}</th>
                <th className="px-3 py-2 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((r) => (
                <tr
                  key={`${r.productId}:${r.channel}:${r.marketplace}`}
                  className="hover:bg-slate-50 dark:hover:bg-slate-800/30"
                >
                  <td className="px-3 py-2">
                    <div className="text-sm text-slate-900 dark:text-slate-100 truncate max-w-[280px]">
                      {r.name ?? r.sku}
                    </div>
                    <div className="font-mono text-xs text-slate-500 dark:text-slate-400">{r.sku}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs text-slate-700 dark:text-slate-300">{r.channel}</span>
                    <span className="ml-1 text-xs text-slate-400">· {r.marketplace}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300">
                      {r.pool === 'FBA' ? <Truck size={12} aria-hidden /> : <Warehouse size={12} aria-hidden />}
                      {r.pool === 'FBA' ? t('poolDrift.poolFba') : t('poolDrift.poolWarehouse')}
                      {r.isMcf && (
                        <span className="ml-1 px-1 py-0.5 text-[10px] font-semibold rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                          MCF
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                    {r.publishedQty.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                    {r.availableToPublish.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-rose-600 dark:text-rose-400">
                    +{r.drift.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={editHref(r)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                      title={t('poolDrift.col.fix')}
                    >
                      {t('poolDrift.col.fix')}
                      <ExternalLink size={11} aria-hidden />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
