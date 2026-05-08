'use client'

// G.4.1 — Pricing matrix workspace.
//
// Reads PricingSnapshot rows for a flat table view: SKU + (channel,
// marketplace, fulfillment) per cell. Each cell shows resolved price +
// currency + source + warning chip. Click a row → drawer with full
// breakdown / history / explain / push.
//
// G.6 — Row checkboxes + floating bulk-override bar: select N rows,
// apply SET_FIXED / SET_PERCENT_DISCOUNT / CLEAR, snapshots refresh.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  AlertTriangle,
  Box,
  ChevronRight,
  Clock,
  Loader2,
  RefreshCw,
  Search,
  Send,
  Tag,
  TrendingDown,
  Trophy,
  X,
  Zap,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Modal, ModalBody } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import RepricerStatusBanner from './_components/RepricerStatusBanner'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface SnapshotRow {
  id: string
  sku: string
  channel: string
  marketplace: string
  fulfillmentMethod: string | null
  computedPrice: string
  currency: string
  source: string
  breakdown: any
  isClamped: boolean
  clampedFrom: string | null
  warnings: string[]
  computedAt: string
}

interface MatrixResponse {
  rows: SnapshotRow[]
  total: number
  page: number
  limit: number
}

interface KpiResponse {
  drift: number
  alerts: number
  salesActive: number
  snapshots: { total: number; oldestAgeHours: number | null }
  marginAtRisk: number
  buyBox: {
    winRatePct: number | null
    observations: number
    ourWins: number
  }
}

const SOURCE_TONE: Record<string, string> = {
  SCHEDULED_SALE: 'bg-pink-50 dark:bg-pink-950 text-pink-700 dark:text-pink-300 border-pink-200 dark:border-pink-900',
  OFFER_OVERRIDE: 'bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900',
  CHANNEL_OVERRIDE: 'bg-violet-50 dark:bg-violet-950 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900',
  CHANNEL_RULE: 'bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-900',
  PRICING_RULE: 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
  MASTER_INHERIT: 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800',
  FALLBACK: 'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900',
}

// E.1.b — concise display labels for pricing source chips. The raw
// enum keys are screamy and operator-hostile; SOURCE_LABEL maps each
// to a friendly form. Falls back to the raw key for any new source
// the engine adds before this map gets updated.
const SOURCE_LABEL: Record<string, string> = {
  SCHEDULED_SALE: 'Sale',
  OFFER_OVERRIDE: 'Offer',
  CHANNEL_OVERRIDE: 'Channel override',
  CHANNEL_RULE: 'Channel rule',
  PRICING_RULE: 'Rule',
  MASTER_INHERIT: 'Master',
  FALLBACK: 'Fallback',
}

export default function PricingMatrixClient() {
  const { t } = useTranslations()
  const [data, setData] = useState<MatrixResponse | null>(null)
  const [kpis, setKpis] = useState<KpiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [channel, setChannel] = useState('')
  const [marketplace, setMarketplace] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [clampedOnly, setClampedOnly] = useState(false)
  const [page, setPage] = useState(0)
  const [drawerKey, setDrawerKey] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // G.6 — bulk selection
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkMode, setBulkMode] = useState<'SET_FIXED' | 'SET_PERCENT_DISCOUNT' | 'CLEAR'>('SET_FIXED')
  const [bulkValue, setBulkValue] = useState('')
  const [bulkApplying, setBulkApplying] = useState(false)
  const { toast } = useToast()

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: '100' })
      if (search) qs.set('search', search)
      if (channel) qs.set('channel', channel)
      if (marketplace) qs.set('marketplace', marketplace)
      if (sourceFilter) qs.set('source', sourceFilter)
      if (clampedOnly) qs.set('isClamped', 'true')
      const res = await fetch(
        `${getBackendUrl()}/api/pricing/matrix?${qs.toString()}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as MatrixResponse
      setData(json)
      // Clear selection on page change / filter change
      setSelected(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [page, search, channel, marketplace, sourceFilter, clampedOnly])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // KPI strip — independent fetch so a slow KPI query doesn't block the
  // matrix table render. Refetched alongside the table on every refresh
  // so counts stay in step with whatever the user just did.
  const fetchKpis = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/pricing/kpis`, {
        cache: 'no-store',
      })
      if (res.ok) setKpis((await res.json()) as KpiResponse)
    } catch {
      // KPI strip is non-blocking. Render '—' if it fails.
    }
  }, [])

  useEffect(() => {
    fetchKpis()
  }, [fetchKpis])

  const refreshAll = async () => {
    setRefreshing(true)
    try {
      await fetch(`${getBackendUrl()}/api/pricing/refresh-snapshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      await Promise.all([fetchData(), fetchKpis()])
    } finally {
      setRefreshing(false)
    }
  }

  const drawerRow = useMemo(
    () => data?.rows.find((r) => r.id === drawerKey) ?? null,
    [data, drawerKey],
  )

  const totalPages = data ? Math.ceil(data.total / data.limit) : 0
  const allPageIds = useMemo(() => data?.rows.map((r) => r.id) ?? [], [data])
  const allPageSelected =
    allPageIds.length > 0 && allPageIds.every((id) => selected.has(id))
  const somePageSelected =
    !allPageSelected && allPageIds.some((id) => selected.has(id))

  const toggleAll = () => {
    if (allPageSelected) {
      setSelected((prev) => {
        const next = new Set(prev)
        allPageIds.forEach((id) => next.delete(id))
        return next
      })
    } else {
      setSelected((prev) => new Set([...prev, ...allPageIds]))
    }
  }

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const applyBulkOverride = async () => {
    if (selected.size === 0) return
    setBulkApplying(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/pricing/bulk-override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snapshotIds: [...selected],
          mode: bulkMode,
          value: bulkMode !== 'CLEAR' ? Number(bulkValue) : undefined,
        }),
      })
      const json = await res.json()
      if (json.ok) {
        toast.success(
          `Updated ${json.updated} listing${json.updated === 1 ? '' : 's'}, refreshed ${json.snapshotsRefreshed} snapshot${json.snapshotsRefreshed === 1 ? '' : 's'}.`,
        )
        setSelected(new Set())
        await Promise.all([fetchData(), fetchKpis()])
      } else {
        toast.error(`Bulk override failed: ${json.error ?? `HTTP ${res.status}`}`)
      }
    } catch (e) {
      toast.error(
        `Bulk override failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      setBulkApplying(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* B.1 — KPI strip */}
      <KpiStrip kpis={kpis} />

      {/* UI.7 — Repricer status banner */}
      <RepricerStatusBanner />

      {/* Filter bar */}
      <Card>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-sm">
            <Search
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
            />
            <Input
              placeholder={t('pricing.search.placeholder')}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
              className="pl-7"
            />
          </div>
          <select
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value)
              setPage(0)
            }}
            className="h-8 px-2 border border-slate-200 dark:border-slate-800 rounded-md text-base bg-white dark:bg-slate-900"
          >
            <option value="">{t('pricing.filter.allChannels')}</option>
            <option value="AMAZON">Amazon</option>
            <option value="EBAY">eBay</option>
            <option value="SHOPIFY">Shopify</option>
            <option value="WOOCOMMERCE">WooCommerce</option>
            <option value="ETSY">Etsy</option>
          </select>
          <select
            value={marketplace}
            onChange={(e) => {
              setMarketplace(e.target.value)
              setPage(0)
            }}
            className="h-8 px-2 border border-slate-200 dark:border-slate-800 rounded-md text-base bg-white dark:bg-slate-900"
          >
            <option value="">{t('pricing.filter.allMarketplaces')}</option>
            <option value="IT">IT</option>
            <option value="DE">DE</option>
            <option value="FR">FR</option>
            <option value="ES">ES</option>
            <option value="UK">UK</option>
            <option value="US">US</option>
            <option value="GLOBAL">GLOBAL</option>
          </select>
          <select
            value={sourceFilter}
            onChange={(e) => {
              setSourceFilter(e.target.value)
              setPage(0)
            }}
            className="h-8 px-2 border border-slate-200 dark:border-slate-800 rounded-md text-base bg-white dark:bg-slate-900"
          >
            <option value="">{t('pricing.filter.allSources')}</option>
            <option value="SCHEDULED_SALE">{t('pricing.source.SCHEDULED_SALE')}</option>
            <option value="OFFER_OVERRIDE">{t('pricing.source.OFFER_OVERRIDE')}</option>
            <option value="CHANNEL_OVERRIDE">{t('pricing.source.CHANNEL_OVERRIDE')}</option>
            <option value="CHANNEL_RULE">{t('pricing.source.CHANNEL_RULE')}</option>
            <option value="PRICING_RULE">{t('pricing.source.PRICING_RULE')}</option>
            <option value="MASTER_INHERIT">{t('pricing.source.MASTER_INHERIT')}</option>
            <option value="FALLBACK">{t('pricing.source.FALLBACK')}</option>
          </select>
          <label className="inline-flex items-center gap-1.5 text-base text-slate-700 dark:text-slate-300 ml-2">
            <input
              type="checkbox"
              checked={clampedOnly}
              onChange={(e) => {
                setClampedOnly(e.target.checked)
                setPage(0)
              }}
            />
            {t('pricing.filter.clampedOnly')}
          </label>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="secondary"
              size="md"
              onClick={fetchData}
              disabled={loading}
              icon={<RefreshCw size={12} />}
            >
              {t('pricing.action.refresh')}
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={refreshAll}
              loading={refreshing}
              disabled={refreshing}
              icon={refreshing ? null : <Zap size={12} />}
            >
              {refreshing
                ? t('pricing.action.recomputing')
                : t('pricing.action.recomputeAll')}
            </Button>
          </div>
        </div>
      </Card>

      {/* Bulk action bar — Toast handles success/error feedback so the bar
          stays minimal: count + mode + value + Apply + Deselect. */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-20 bg-slate-900 text-white rounded-lg px-4 py-3 flex items-center gap-3 flex-wrap shadow-lg">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelected(new Set())}
            icon={<X size={12} />}
            aria-label={t('pricing.bulk.deselect')}
            className="text-slate-300 hover:text-white hover:bg-slate-800 border-transparent"
          >
            {t('pricing.bulk.deselect')}
          </Button>
          <div className="h-4 w-px bg-slate-700" />
          <span className="text-base font-semibold tabular-nums">
            {t('pricing.bulk.selected', {
              n: selected.size,
              s: selected.size === 1 ? '' : 's',
            })}
          </span>
          <div className="h-4 w-px bg-slate-700" />
          <select
            value={bulkMode}
            onChange={(e) =>
              setBulkMode(e.target.value as typeof bulkMode)
            }
            className="h-7 px-2 rounded border border-slate-600 bg-slate-800 text-white text-base"
          >
            <option value="SET_FIXED">{t('pricing.bulk.setFixed')}</option>
            <option value="SET_PERCENT_DISCOUNT">{t('pricing.bulk.percentDiscount')}</option>
            <option value="CLEAR">{t('pricing.bulk.clearOverride')}</option>
          </select>
          {bulkMode !== 'CLEAR' && (
            <input
              type="number"
              step="0.01"
              min="0"
              placeholder={bulkMode === 'SET_FIXED' ? '0.00' : '0–99'}
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
              className="h-7 w-24 px-2 rounded border border-slate-600 bg-slate-800 text-white text-base tabular-nums"
            />
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={applyBulkOverride}
            loading={bulkApplying}
            disabled={bulkApplying || (bulkMode !== 'CLEAR' && !bulkValue)}
            className="ml-auto bg-white text-slate-900 hover:bg-slate-100 border-white"
          >
            {t('pricing.bulk.apply')}
          </Button>
        </div>
      )}

      {/* Table */}
      {loading && !data ? (
        <Card>
          <div className="text-md text-slate-500 dark:text-slate-400 py-8 text-center inline-flex items-center justify-center gap-2 w-full">
            <Loader2 className="w-4 h-4 animate-spin" /> {t('pricing.matrix.loading')}
          </div>
        </Card>
      ) : error ? (
        <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950 rounded px-3 py-2 text-base text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      ) : !data || data.rows.length === 0 ? (
        <EmptyState
          icon={Box}
          title={t('pricing.matrix.empty')}
          description={t('pricing.matrix.emptyHint')}
        />
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-md">
              <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800">
                <tr>
                  <th scope="col" className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={allPageSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = somePageSelected
                      }}
                      onChange={toggleAll}
                      className="rounded"
                    />
                  </th>
                  <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                    SKU
                  </th>
                  <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                    Channel · Marketplace
                  </th>
                  <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                    FM
                  </th>
                  <th scope="col" className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                    Price
                  </th>
                  <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                    Source
                  </th>
                  <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                    Warnings
                  </th>
                  <th scope="col" className="px-3 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const isSelected = selected.has(r.id)
                  return (
                    <tr
                      key={r.id}
                      className={cn(
                        'border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800',
                        isSelected && 'bg-blue-50 dark:bg-blue-950 hover:bg-blue-50 dark:hover:bg-blue-950',
                      )}
                    >
                      <td
                        className="px-3 py-2 w-8"
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleRow(r.id)
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleRow(r.id)}
                          className="rounded"
                        />
                      </td>
                      <td
                        className="px-3 py-2 font-mono text-base text-slate-800 dark:text-slate-200 cursor-pointer"
                        onClick={() => setDrawerKey(r.id)}
                      >
                        {r.sku}
                      </td>
                      <td
                        className="px-3 py-2 text-slate-700 dark:text-slate-300 cursor-pointer"
                        onClick={() => setDrawerKey(r.id)}
                      >
                        <span className="font-medium">{r.channel}</span>
                        <span className="text-slate-400 dark:text-slate-500"> · </span>
                        <span className="font-mono text-sm">{r.marketplace}</span>
                      </td>
                      <td
                        className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400 cursor-pointer"
                        onClick={() => setDrawerKey(r.id)}
                      >
                        {r.fulfillmentMethod ?? '—'}
                      </td>
                      <td
                        className={cn(
                          'px-3 py-2 text-right tabular-nums font-semibold cursor-pointer',
                          r.isClamped ? 'text-amber-700 dark:text-amber-300' : 'text-slate-900 dark:text-slate-100',
                        )}
                        title={
                          r.isClamped
                            ? `Clamped from ${r.clampedFrom} ${r.currency}`
                            : undefined
                        }
                        onClick={() => setDrawerKey(r.id)}
                      >
                        {Number(r.computedPrice).toFixed(2)}{' '}
                        <span className="text-sm text-slate-500 dark:text-slate-400 font-normal">
                          {r.currency}
                        </span>
                      </td>
                      <td
                        className="px-3 py-2 cursor-pointer"
                        onClick={() => setDrawerKey(r.id)}
                      >
                        <span
                          className={cn(
                            'inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded',
                            SOURCE_TONE[r.source] ?? SOURCE_TONE.FALLBACK,
                          )}
                        >
                          {SOURCE_LABEL[r.source] ?? r.source}
                        </span>
                      </td>
                      <td
                        className="px-3 py-2 cursor-pointer"
                        onClick={() => setDrawerKey(r.id)}
                      >
                        {r.warnings.length > 0 ? (
                          <span
                            className="text-sm text-amber-700 dark:text-amber-300 inline-flex items-center gap-1"
                            title={r.warnings.join('; ')}
                          >
                            <AlertCircle size={11} /> {r.warnings.length}
                          </span>
                        ) : (
                          <span className="text-sm text-slate-400 dark:text-slate-500">—</span>
                        )}
                      </td>
                      <td
                        className="px-3 py-2 text-slate-400 dark:text-slate-500 cursor-pointer"
                        onClick={() => setDrawerKey(r.id)}
                      >
                        <ChevronRight size={14} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="px-4 py-2.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-base text-slate-600 dark:text-slate-400">
            <span>
              {data.total} snapshot{data.total === 1 ? '' : 's'} · page {data.page + 1} / {Math.max(1, totalPages)}
              {selected.size > 0 && (
                <span className="ml-3 text-blue-600 font-medium">
                  {selected.size} selected
                </span>
              )}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0 || loading}
              >
                {t('pricing.pagination.prev')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={page + 1 >= totalPages || loading}
              >
                {t('pricing.pagination.next')}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Detail drawer */}
      {drawerRow && (
        <PricingDetailDrawer
          row={drawerRow}
          onClose={() => setDrawerKey(null)}
          onPushed={() => fetchData()}
        />
      )}
    </div>
  )
}

function PricingDetailDrawer({
  row,
  onClose,
  onPushed,
}: {
  row: SnapshotRow
  onClose: () => void
  onPushed: () => void
}) {
  const { t } = useTranslations()
  const [pushing, setPushing] = useState(false)
  const { toast } = useToast()

  const push = async () => {
    setPushing(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/pricing/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: row.sku,
          channel: row.channel,
          marketplace: row.marketplace,
          fulfillmentMethod: row.fulfillmentMethod,
        }),
      })
      const json = await res.json()
      if (json.ok) {
        toast.success(
          `Pushed ${json.pushedPrice} ${json.currency} to ${json.channel}:${json.marketplace}.`,
        )
        onPushed()
      } else {
        toast.error(`Push failed: ${json.error ?? `HTTP ${res.status}`}`)
      }
    } catch (e) {
      toast.error(`Push failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPushing(false)
    }
  }

  const breakdown = (row.breakdown ?? {}) as any
  const headerTitle = (
    <div className="min-w-0">
      <div className="text-md font-semibold text-slate-900 dark:text-slate-100 truncate font-mono">
        {row.sku}
      </div>
      <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
        {row.channel} · {row.marketplace}
        {row.fulfillmentMethod ? ` · ${row.fulfillmentMethod}` : ''}
      </div>
    </div>
  )

  return (
    <Modal
      open
      onClose={onClose}
      placement="drawer-right"
      size="xl"
      title={headerTitle}
    >
      <ModalBody className="space-y-4">
        {/* Resolved */}
        <div className="bg-slate-50 dark:bg-slate-800 rounded p-3">
          <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
            {t('pricing.drawer.resolvedPrice')}
          </div>
          <div className="text-[24px] font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {Number(row.computedPrice).toFixed(2)}{' '}
            <span className="text-lg font-normal text-slate-500 dark:text-slate-400">
              {row.currency}
            </span>
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            {t('pricing.drawer.source')}: <span className="font-mono">{row.source}</span>
            {row.isClamped && (
              <span className="ml-2 text-amber-700 dark:text-amber-300">
                · {t('pricing.drawer.clampedFrom', { value: row.clampedFrom ?? '?' })}
              </span>
            )}
          </div>
        </div>

        {/* Breakdown */}
        <div>
          <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1.5">
            {t('pricing.drawer.breakdown')}
          </div>
          <dl className="grid grid-cols-2 gap-y-1 text-base">
            <Item label={t('pricing.drawer.masterPrice')} value={breakdown.masterPrice} suffix="EUR" />
            <Item label={t('pricing.drawer.fxRate')} value={breakdown.fxRate} format="rate" />
            <Item label={t('pricing.drawer.costEntered')} value={breakdown.costPrice} suffix="EUR" />
            <Item label={t('pricing.drawer.landedReceipts')} value={breakdown.landedCost} suffix="EUR" />
            <Item
              label={t('pricing.drawer.floorCostBasis')}
              value={breakdown.effectiveCostBasis}
              suffix="EUR"
            />
            <Item label={t('pricing.drawer.fbaFee')} value={breakdown.fbaFee} suffix={row.currency} />
            <Item label={t('pricing.drawer.referralFee')} value={breakdown.referralFee} suffix={row.currency} />
            <Item label={t('pricing.drawer.vatRate')} value={breakdown.vatRate} suffix="%" />
            <Item label={t('pricing.drawer.minMargin')} value={breakdown.minMarginPercent} suffix="%" />
            <Item
              label={t('pricing.drawer.taxInclusive')}
              value={
                breakdown.taxInclusive
                  ? t('pricing.drawer.taxInclusive.yes')
                  : t('pricing.drawer.taxInclusive.no')
              }
            />
            {breakdown.appliedRule && (
              <Item
                label={t('pricing.drawer.appliedRule')}
                value={`${breakdown.appliedRule.type}${breakdown.appliedRule.adjustment != null ? ` (${breakdown.appliedRule.adjustment >= 0 ? '+' : ''}${breakdown.appliedRule.adjustment}%)` : ''}`}
              />
            )}
          </dl>
        </div>

        {/* Warnings */}
        {row.warnings.length > 0 && (
          <div className="border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950 rounded p-3">
            <div className="text-sm uppercase tracking-wider text-amber-800 dark:text-amber-200 font-semibold mb-1">
              {t('pricing.drawer.warnings')}
            </div>
            <ul className="text-base text-amber-800 dark:text-amber-200 space-y-0.5">
              {row.warnings.map((w, i) => (
                <li key={i}>• {w}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Push action */}
        <div className="border border-slate-200 dark:border-slate-800 rounded p-3">
          <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">
            {t('pricing.drawer.pushTitle')}
          </div>
          <div className="text-base text-slate-600 dark:text-slate-400 mb-2">
            {t('pricing.drawer.pushDescription', { channel: row.channel })}
          </div>
          <Button
            variant="primary"
            size="md"
            onClick={push}
            loading={pushing}
            icon={pushing ? null : <Send size={12} />}
            className="bg-slate-900 hover:bg-slate-800 border-slate-900"
          >
            {pushing
              ? t('pricing.drawer.pushing')
              : t('pricing.drawer.pushButton')}
          </Button>
        </div>

        <div className="text-sm text-slate-400 dark:text-slate-500">
          {t('pricing.drawer.lastComputed', {
            when: new Date(row.computedAt).toLocaleString(),
          })}
        </div>
      </ModalBody>
    </Modal>
  )
}

function Item({
  label,
  value,
  suffix,
  format,
}: {
  label: string
  value: any
  suffix?: string
  format?: 'rate'
}) {
  if (value == null || value === '') return null
  const display =
    format === 'rate'
      ? Number(value).toFixed(4)
      : typeof value === 'number'
      ? value.toFixed(2)
      : String(value)
  return (
    <>
      <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="font-mono text-slate-800 dark:text-slate-200 text-right tabular-nums">
        {display}
        {suffix ? <span className="text-slate-400 dark:text-slate-500 ml-1">{suffix}</span> : null}
      </dd>
    </>
  )
}

// B.1 + F.1.b + H.1 — KPI strip. Six tiles, dense Salesforce/Airtable style
// (per the visibility-over-minimalism feedback memory). Each tile shows the
// count + a one-word label + a hint sentence. Drift + Alerts deep-link to
// /pricing/alerts; On sale → /pricing/promotions; the rest are read-only.
// Labels + hints are i18n'd; numerals stay locale-agnostic.
function KpiStrip({ kpis }: { kpis: KpiResponse | null }) {
  const { t } = useTranslations()
  // Snapshot age: green ≤1h (cron just ran), amber ≤4h, rose >4h.
  const stale = kpis?.snapshots.oldestAgeHours
  const staleTone =
    stale == null
      ? 'slate'
      : stale <= 1
      ? 'emerald'
      : stale <= 4
      ? 'amber'
      : 'rose'
  const staleLabel =
    stale == null ? '—' : stale < 1 ? '<1h' : `${Math.round(stale)}h`

  // Buy Box: rose <50%, amber <80%, emerald ≥80%. Slate when no observations
  // yet (sp-api creds missing OR cron hasn't run since F.1 deploy).
  const wr = kpis?.buyBox.winRatePct
  const buyBoxTone =
    wr == null
      ? 'slate'
      : wr < 50
      ? 'rose'
      : wr < 80
      ? 'amber'
      : 'emerald'
  const buyBoxLabel =
    wr == null
      ? '—'
      : `${wr.toFixed(1)}%`
  const buyBoxHint =
    kpis && kpis.buyBox.observations > 0
      ? t('pricing.kpi.buyBoxHint', {
          wins: kpis.buyBox.ourWins,
          obs: kpis.buyBox.observations,
        })
      : t('pricing.kpi.buyBoxHintEmpty')

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
      <KpiTile
        href="/pricing/alerts"
        icon={TrendingDown}
        value={kpis?.drift ?? '—'}
        label={t('pricing.kpi.drift')}
        tone={kpis && kpis.drift > 0 ? 'rose' : 'slate'}
        hint={t('pricing.kpi.driftHint')}
      />
      <KpiTile
        href="/pricing/alerts"
        icon={AlertTriangle}
        value={kpis?.alerts ?? '—'}
        label={t('pricing.kpi.alerts')}
        tone={kpis && kpis.alerts > 0 ? 'amber' : 'slate'}
        hint={t('pricing.kpi.alertsHint')}
      />
      <KpiTile
        href="/pricing/promotions"
        icon={Tag}
        value={kpis?.salesActive ?? '—'}
        label={t('pricing.kpi.onSale')}
        tone={kpis && kpis.salesActive > 0 ? 'pink' : 'slate'}
        hint={t('pricing.kpi.onSaleHint')}
      />
      <KpiTile
        icon={Clock}
        value={staleLabel}
        label={t('pricing.kpi.snapshotAge')}
        tone={staleTone}
        hint={t('pricing.kpi.snapshotAgeHint')}
      />
      <KpiTile
        icon={AlertCircle}
        value={kpis?.marginAtRisk ?? '—'}
        label={t('pricing.kpi.noCost')}
        tone={kpis && kpis.marginAtRisk > 0 ? 'amber' : 'slate'}
        hint={t('pricing.kpi.noCostHint')}
      />
      <KpiTile
        icon={Trophy}
        value={buyBoxLabel}
        label={t('pricing.kpi.buyBox')}
        tone={buyBoxTone}
        hint={buyBoxHint}
      />
    </div>
  )
}

function KpiTile({
  href,
  icon: Icon,
  value,
  label,
  tone,
  hint,
}: {
  href?: string
  icon: typeof TrendingDown
  value: number | string
  label: string
  tone: 'rose' | 'amber' | 'pink' | 'emerald' | 'slate'
  hint: string
}) {
  const toneClasses: Record<typeof tone, string> = {
    rose: 'border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300',
    amber: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300',
    pink: 'border-pink-200 dark:border-pink-900 bg-pink-50 dark:bg-pink-950 text-pink-700 dark:text-pink-300',
    emerald: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300',
    slate: 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400',
  }
  const inner = (
    <div
      className={cn(
        'border rounded-md px-3 py-2 flex items-start gap-2',
        toneClasses[tone],
        href && 'hover:shadow-sm transition-shadow cursor-pointer',
      )}
    >
      <Icon size={14} className="mt-0.5 flex-shrink-0" />
      <div className="min-w-0">
        <div className="text-[20px] leading-tight font-semibold tabular-nums">
          {value}
        </div>
        <div className="text-base font-medium text-slate-700 dark:text-slate-300 leading-tight">
          {label}
        </div>
        <div className="text-sm text-slate-500 dark:text-slate-400 leading-tight mt-0.5 truncate">
          {hint}
        </div>
      </div>
    </div>
  )
  return href ? <Link href={href}>{inner}</Link> : inner
}
