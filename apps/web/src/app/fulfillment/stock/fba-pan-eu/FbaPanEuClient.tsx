'use client'

/**
 * S.25 — Pan-EU FBA distribution dashboard.
 *
 * Three sections render from a single /api/stock/fba-pan-eu fetch:
 *   - Per-FC summary cards (one per marketplace × FC combo)
 *   - Aged inventory list (sellable units sitting > 180 days)
 *   - Unfulfillable list (damaged/disposal candidates)
 *
 * Cross-link to /fulfillment/inbound?status=IN_TRANSIT&channel=AMAZON
 * lets operators drill from "I have N inbound" to the actual
 * inbound-shipment surface.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Globe, ArrowLeft, RefreshCw, AlertCircle, AlertTriangle,
  Package, Clock, ExternalLink,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { AbcBadge } from '@/components/inventory/AbcBadge'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

interface PerFcRow {
  marketplaceId: string
  fulfillmentCenterId: string
  skuCount: number
  sellable: number
  unfulfillable: number
  inbound: number
  reserved: number
  researching: number
}

interface AgedRow {
  id: string
  productId: string | null
  sku: string
  asin: string | null
  marketplaceId: string
  fulfillmentCenterId: string
  condition: string
  quantity: number
  firstReceivedAt: string | null
  ageDays: number | null
  productName: string | null
  thumbnailUrl: string | null
  abcClass: 'A' | 'B' | 'C' | 'D' | null
}

interface UnfulfillableRow {
  id: string
  productId: string | null
  sku: string
  asin: string | null
  marketplaceId: string
  fulfillmentCenterId: string
  quantity: number
  firstReceivedAt: string | null
  productName: string | null
  thumbnailUrl: string | null
  abcClass: 'A' | 'B' | 'C' | 'D' | null
}

interface SnapshotResponse {
  perFc: PerFcRow[]
  aged: AgedRow[]
  unfulfillable: UnfulfillableRow[]
  generatedAt: string
}

// Map Amazon marketplace IDs to operator-friendly country codes.
const MARKETPLACE_LABEL: Record<string, string> = {
  'APJ6JRA9NG5V4': 'IT',
  'A1PA6795UKMFR9': 'DE',
  'A13V1IB3VIYZZH': 'FR',
  'A1RKKUPIHCS9HS': 'ES',
  'A1F83G8C2ARO7P': 'UK',
  'A1805IZSGTT6HS': 'NL',
  'A2NODRKZP88ZB9': 'SE',
  'A1C3SOZRARQ6R3': 'PL',
  'A1AT7YVPFBWXBL': 'CZ',
  'A2VIGQ35RCS4UG': 'AE',
  'A21TJRUUN4KGV': 'IN',
  'ATVPDKIKX0DER': 'US',
  'A2EUQ1WTGCTBG2': 'CA',
  'A1AM78C64UM0Y8': 'MX',
}

function ageTone(days: number | null): string {
  if (days == null) return 'text-slate-400 dark:text-slate-500'
  if (days < 90) return 'text-emerald-700'
  if (days < 180) return 'text-blue-700'
  if (days < 365) return 'text-amber-700'
  return 'text-rose-700'
}

export default function FbaPanEuClient() {
  const { t } = useTranslations()
  const [data, setData] = useState<SnapshotResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/fba-pan-eu`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
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
        title={t('stock.fbaPanEu.title')}
        description={t('stock.fbaPanEu.description')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('stock.fbaPanEu.title') },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/fulfillment/stock"
              className="inline-flex items-center gap-1.5 h-11 sm:h-8 px-3 text-base text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:text-slate-100"
            >
              <ArrowLeft size={14} /> {t('stock.title')}
            </Link>
            <Link
              href="/fulfillment/inbound?status=IN_TRANSIT&channel=AMAZON"
              className="inline-flex items-center gap-1.5 h-11 sm:h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              title={t('stock.fbaPanEu.inboundLink')}
            >
              <ExternalLink size={12} /> {t('stock.fbaPanEu.inboundLink')}
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

      {loading && data === null && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i}>
              <div className="h-24 flex items-center justify-center text-base text-slate-400 dark:text-slate-500">…</div>
            </Card>
          ))}
        </div>
      )}

      {data && data.perFc.length === 0 && !loading && (
        <EmptyState
          icon={Globe}
          title={t('stock.fbaPanEu.empty.title')}
          description={t('stock.fbaPanEu.empty.description')}
          action={{ label: t('stock.title'), href: '/fulfillment/stock' }}
        />
      )}

      {data && data.perFc.length > 0 && (
        <>
          {/* Per-FC summary grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.perFc.map((fc) => {
              const country = MARKETPLACE_LABEL[fc.marketplaceId] ?? fc.marketplaceId.slice(-4)
              return (
                <Card key={`${fc.marketplaceId}_${fc.fulfillmentCenterId}`}>
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="text-sm uppercase tracking-wider font-semibold text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5">
                        <Globe size={12} className="text-slate-400 dark:text-slate-500" />
                        {country} · {fc.fulfillmentCenterId}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        {fc.skuCount} {t('stock.fbaPanEu.skuCount')}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-y-1 gap-x-3 text-sm">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-emerald-700">{t('stock.fbaPanEu.cond.sellable')}</span>
                      <span className="font-semibold tabular-nums">{fc.sellable.toLocaleString()}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-blue-700">{t('stock.fbaPanEu.cond.inbound')}</span>
                      <span className="font-semibold tabular-nums">{fc.inbound.toLocaleString()}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-violet-700">{t('stock.fbaPanEu.cond.reserved')}</span>
                      <span className="font-semibold tabular-nums">{fc.reserved.toLocaleString()}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-rose-700">{t('stock.fbaPanEu.cond.unfulfillable')}</span>
                      <span className={cn('font-semibold tabular-nums', fc.unfulfillable > 0 && 'text-rose-700')}>
                        {fc.unfulfillable.toLocaleString()}
                      </span>
                    </div>
                    {fc.researching > 0 && (
                      <div className="col-span-2 flex items-baseline justify-between gap-2 text-xs text-amber-700 mt-1">
                        <span>{t('stock.fbaPanEu.cond.researching')}</span>
                        <span className="font-semibold tabular-nums">{fc.researching.toLocaleString()}</span>
                      </div>
                    )}
                  </div>
                </Card>
              )
            })}
          </div>

          {/* Aged inventory section */}
          {data.aged.length > 0 && (
            <Card>
              <div className="flex items-center justify-between mb-3">
                <div className="text-md font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-2">
                  <Clock size={14} className="text-amber-500" />
                  {t('stock.fbaPanEu.aged.title')}
                </div>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {t('stock.fbaPanEu.aged.subtitle', { n: data.aged.length })}
                </span>
              </div>
              <ul className="space-y-1">
                {data.aged.slice(0, 25).map((r) => {
                  const country = MARKETPLACE_LABEL[r.marketplaceId] ?? r.marketplaceId.slice(-4)
                  return (
                    <li key={r.id} className="flex items-center gap-2 py-1.5 px-2 -mx-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
                      {r.thumbnailUrl ? (
                        <img src={r.thumbnailUrl} alt="" className="w-7 h-7 rounded object-cover bg-slate-100 dark:bg-slate-800 flex-shrink-0" />
                      ) : (
                        <div className="w-7 h-7 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 flex-shrink-0">
                          <Package size={12} />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate flex items-center gap-1.5">
                          {r.abcClass && <AbcBadge cls={r.abcClass} size="sm" />}
                          <span className="truncate">{r.productName ?? r.sku}</span>
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
                          {r.sku} · {country} · {r.fulfillmentCenterId}
                        </div>
                      </div>
                      <div className="text-right text-sm tabular-nums flex-shrink-0">
                        <div className={cn('font-semibold', ageTone(r.ageDays))}>
                          {r.ageDays != null ? `${r.ageDays}d` : '—'}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">{r.quantity}u</div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </Card>
          )}

          {/* Unfulfillable section */}
          {data.unfulfillable.length > 0 && (
            <Card>
              <div className="flex items-center justify-between mb-3">
                <div className="text-md font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-2">
                  <AlertTriangle size={14} className="text-rose-500" />
                  {t('stock.fbaPanEu.unfulfillable.title')}
                </div>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {t('stock.fbaPanEu.unfulfillable.subtitle', { n: data.unfulfillable.length })}
                </span>
              </div>
              <ul className="space-y-1">
                {data.unfulfillable.slice(0, 25).map((r) => {
                  const country = MARKETPLACE_LABEL[r.marketplaceId] ?? r.marketplaceId.slice(-4)
                  return (
                    <li key={r.id} className="flex items-center gap-2 py-1.5 px-2 -mx-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
                      {r.thumbnailUrl ? (
                        <img src={r.thumbnailUrl} alt="" className="w-7 h-7 rounded object-cover bg-slate-100 dark:bg-slate-800 flex-shrink-0" />
                      ) : (
                        <div className="w-7 h-7 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 flex-shrink-0">
                          <Package size={12} />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate flex items-center gap-1.5">
                          {r.abcClass && <AbcBadge cls={r.abcClass} size="sm" />}
                          <span className="truncate">{r.productName ?? r.sku}</span>
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
                          {r.sku} · {country} · {r.fulfillmentCenterId}
                        </div>
                      </div>
                      <Badge variant="danger" size="sm">{r.quantity.toLocaleString()}u</Badge>
                    </li>
                  )
                })}
              </ul>
              <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                {t('stock.fbaPanEu.unfulfillable.footer')}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
