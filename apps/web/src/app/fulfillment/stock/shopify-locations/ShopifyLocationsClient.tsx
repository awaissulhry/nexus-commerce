'use client'

/**
 * S.23 — Shopify Locations settings UI.
 *
 * Reads /api/stock/shopify-locations (mapped rows + per-location
 * stock summary). Operator can:
 *   - Click "Discover" to refresh the mapping from Shopify
 *     (POST /api/stock/shopify-locations/discover)
 *   - Toggle a location's active flag
 *     (PATCH /api/stock/shopify-locations/:id)
 *
 * S.22 ships the schema; this commit adds the operator-facing
 * surface so multi-location stock binding is usable end-to-end.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Store, ArrowLeft, RefreshCw, AlertCircle, Search,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'

interface ShopifyLocationRow {
  id: string
  code: string
  name: string
  externalLocationId: string | null
  isActive: boolean
  skuCount: number
  totalQuantity: number
}

export default function ShopifyLocationsClient() {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [locations, setLocations] = useState<ShopifyLocationRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/shopify-locations`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setLocations(json.locations ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const runDiscover = useCallback(async () => {
    setDiscovering(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/stock/shopify-locations/discover`,
        { method: 'POST' },
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      toast.success(t('stock.shopifyLocations.toast.discovered', {
        created: body.created ?? 0,
        updated: body.updated ?? 0,
        unchanged: body.unchanged ?? 0,
      }))
      await fetchData()
    } catch (err) {
      toast.error(t('stock.shopifyLocations.toast.discoverFailed', {
        error: err instanceof Error ? err.message : String(err),
      }))
    } finally {
      setDiscovering(false)
    }
  }, [fetchData, t, toast])

  const toggleActive = useCallback(async (loc: ShopifyLocationRow) => {
    setTogglingId(loc.id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/stock/shopify-locations/${loc.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: !loc.isActive }),
        },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await fetchData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setTogglingId(null)
    }
  }, [fetchData, toast])

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('stock.shopifyLocations.title')}
        description={t('stock.shopifyLocations.description')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('stock.shopifyLocations.title') },
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
            <Button variant="primary" size="sm" onClick={runDiscover} disabled={discovering}>
              {discovering
                ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                : <Search className="w-3.5 h-3.5" />}
              {t('stock.shopifyLocations.discover')}
            </Button>
          </div>
        }
      />

      {error && (
        <div className="text-base text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {loading && locations === null && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {locations !== null && locations.length === 0 && !loading && (
        <EmptyState
          icon={Store}
          title={t('stock.shopifyLocations.empty.title')}
          description={t('stock.shopifyLocations.empty.description')}
          action={{ label: t('stock.shopifyLocations.discover'), onClick: runDiscover }}
        />
      )}

      {locations && locations.length > 0 && (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-md">
              <thead className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
                <tr>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.shopifyLocations.col.code')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.shopifyLocations.col.name')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.shopifyLocations.col.shopifyId')}</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.shopifyLocations.col.skus')}</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.shopifyLocations.col.units')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.shopifyLocations.col.status')}</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300"></th>
                </tr>
              </thead>
              <tbody>
                {locations.map((l) => (
                  <tr key={l.id} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800">
                    <td className="px-3 py-2 font-mono text-sm text-slate-700 dark:text-slate-300">{l.code}</td>
                    <td className="px-3 py-2 text-slate-900 dark:text-slate-100">{l.name}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                      {l.externalLocationId ?? <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{l.skuCount}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">{l.totalQuantity}</td>
                    <td className="px-3 py-2">
                      <Badge variant={l.isActive ? 'success' : 'default'} size="sm">
                        {l.isActive ? t('stock.shopifyLocations.active') : t('stock.shopifyLocations.inactive')}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => toggleActive(l)}
                        disabled={togglingId === l.id}
                        className="min-h-[44px] sm:min-h-0 px-2 py-1 text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                      >
                        {l.isActive
                          ? t('stock.shopifyLocations.disable')
                          : t('stock.shopifyLocations.enable')}
                      </button>
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
