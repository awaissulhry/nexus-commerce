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
import {
  AlertCircle,
  Box,
  CheckCircle2,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
  Send,
  X,
  Zap,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
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

const SOURCE_TONE: Record<string, string> = {
  SCHEDULED_SALE: 'bg-pink-50 text-pink-700 border-pink-200',
  OFFER_OVERRIDE: 'bg-blue-50 text-blue-700 border-blue-200',
  CHANNEL_OVERRIDE: 'bg-violet-50 text-violet-700 border-violet-200',
  CHANNEL_RULE: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  PRICING_RULE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  MASTER_INHERIT: 'bg-slate-50 text-slate-600 border-slate-200',
  FALLBACK: 'bg-amber-50 text-amber-700 border-amber-200',
}

const SOURCE_LABEL: Record<string, string> = {
  SCHEDULED_SALE: 'Sale',
  OFFER_OVERRIDE: 'Offer',
  CHANNEL_OVERRIDE: 'Manual',
  CHANNEL_RULE: 'Channel rule',
  PRICING_RULE: 'Engine rule',
  MASTER_INHERIT: 'Master',
  FALLBACK: 'Fallback',
}

export default function PricingMatrixClient() {
  const [data, setData] = useState<MatrixResponse | null>(null)
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
  const [bulkResult, setBulkResult] = useState<string | null>(null)

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

  const refreshAll = async () => {
    setRefreshing(true)
    try {
      await fetch(`${getBackendUrl()}/api/pricing/refresh-snapshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      await fetchData()
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
    setBulkResult(null)
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
        setBulkResult(`Updated ${json.updated} listing${json.updated === 1 ? '' : 's'}, refreshed ${json.snapshotsRefreshed} snapshot${json.snapshotsRefreshed === 1 ? '' : 's'}.`)
        setSelected(new Set())
        await fetchData()
      } else {
        setBulkResult(`Error: ${json.error ?? `HTTP ${res.status}`}`)
      }
    } catch (e) {
      setBulkResult(`Error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBulkApplying(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <Card>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-sm">
            <Search
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <Input
              placeholder="Search SKU…"
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
            className="h-8 px-2 border border-slate-200 rounded-md text-[12px] bg-white"
          >
            <option value="">All channels</option>
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
            className="h-8 px-2 border border-slate-200 rounded-md text-[12px] bg-white"
          >
            <option value="">All marketplaces</option>
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
            className="h-8 px-2 border border-slate-200 rounded-md text-[12px] bg-white"
          >
            <option value="">All sources</option>
            <option value="SCHEDULED_SALE">Sale</option>
            <option value="OFFER_OVERRIDE">Offer</option>
            <option value="CHANNEL_OVERRIDE">Manual</option>
            <option value="CHANNEL_RULE">Channel rule</option>
            <option value="PRICING_RULE">Engine rule</option>
            <option value="MASTER_INHERIT">Master</option>
            <option value="FALLBACK">Fallback</option>
          </select>
          <label className="inline-flex items-center gap-1.5 text-[12px] text-slate-700 ml-2">
            <input
              type="checkbox"
              checked={clampedOnly}
              onChange={(e) => {
                setClampedOnly(e.target.checked)
                setPage(0)
              }}
            />
            Clamped only
          </label>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={fetchData}
              disabled={loading}
              className="h-8 px-3 text-[12px] border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <RefreshCw size={12} /> Refresh
            </button>
            <button
              onClick={refreshAll}
              disabled={refreshing}
              className="h-8 px-3 text-[12px] bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {refreshing ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" /> Recomputing…
                </>
              ) : (
                <>
                  <Zap size={12} /> Recompute all
                </>
              )}
            </button>
          </div>
        </div>
      </Card>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-20 bg-slate-900 text-white rounded-lg px-4 py-3 flex items-center gap-3 flex-wrap shadow-lg">
          <span className="text-[12px] font-semibold tabular-nums">
            {selected.size} row{selected.size === 1 ? '' : 's'} selected
          </span>
          <div className="h-4 w-px bg-slate-700" />
          <select
            value={bulkMode}
            onChange={(e) =>
              setBulkMode(e.target.value as typeof bulkMode)
            }
            className="h-7 px-2 rounded border border-slate-600 bg-slate-800 text-white text-[12px]"
          >
            <option value="SET_FIXED">Set fixed price</option>
            <option value="SET_PERCENT_DISCOUNT">Discount %</option>
            <option value="CLEAR">Clear override</option>
          </select>
          {bulkMode !== 'CLEAR' && (
            <input
              type="number"
              step="0.01"
              min="0"
              placeholder={bulkMode === 'SET_FIXED' ? '0.00' : '0–99'}
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
              className="h-7 w-24 px-2 rounded border border-slate-600 bg-slate-800 text-white text-[12px] tabular-nums"
            />
          )}
          <button
            onClick={applyBulkOverride}
            disabled={bulkApplying || (bulkMode !== 'CLEAR' && !bulkValue)}
            className="h-7 px-3 rounded bg-white text-slate-900 text-[12px] font-semibold hover:bg-slate-100 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {bulkApplying ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : null}
            Apply
          </button>
          <button
            onClick={() => {
              setSelected(new Set())
              setBulkResult(null)
            }}
            className="h-7 px-2 rounded text-slate-400 hover:text-white text-[12px] inline-flex items-center gap-1"
          >
            <X size={12} /> Deselect
          </button>
          {bulkResult && (
            <>
              <div className="h-4 w-px bg-slate-700" />
              <span
                className={cn(
                  'text-[12px] inline-flex items-center gap-1',
                  bulkResult.startsWith('Error') ? 'text-rose-400' : 'text-emerald-400',
                )}
              >
                {bulkResult.startsWith('Error') ? (
                  <AlertCircle size={12} />
                ) : (
                  <CheckCircle2 size={12} />
                )}
                {bulkResult}
              </span>
            </>
          )}
        </div>
      )}

      {/* Table */}
      {loading && !data ? (
        <Card>
          <div className="text-[13px] text-slate-500 py-8 text-center inline-flex items-center justify-center gap-2 w-full">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading snapshots…
          </div>
        </Card>
      ) : error ? (
        <div className="border border-rose-200 bg-rose-50 rounded px-3 py-2 text-[12px] text-rose-700 inline-flex items-start gap-1.5">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      ) : !data || data.rows.length === 0 ? (
        <EmptyState
          icon={Box}
          title="No pricing snapshots yet"
          description="Click Recompute all to materialize prices from the engine."
        />
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 w-8">
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
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">
                    SKU
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">
                    Channel · Marketplace
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">
                    FM
                  </th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">
                    Price
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">
                    Source
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">
                    Warnings
                  </th>
                  <th className="px-3 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const isSelected = selected.has(r.id)
                  return (
                    <tr
                      key={r.id}
                      className={cn(
                        'border-b border-slate-100 hover:bg-slate-50',
                        isSelected && 'bg-blue-50 hover:bg-blue-50',
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
                        className="px-3 py-2 font-mono text-[12px] text-slate-800 cursor-pointer"
                        onClick={() => setDrawerKey(r.id)}
                      >
                        {r.sku}
                      </td>
                      <td
                        className="px-3 py-2 text-slate-700 cursor-pointer"
                        onClick={() => setDrawerKey(r.id)}
                      >
                        <span className="font-medium">{r.channel}</span>
                        <span className="text-slate-400"> · </span>
                        <span className="font-mono text-[11px]">{r.marketplace}</span>
                      </td>
                      <td
                        className="px-3 py-2 text-[11px] text-slate-500 cursor-pointer"
                        onClick={() => setDrawerKey(r.id)}
                      >
                        {r.fulfillmentMethod ?? '—'}
                      </td>
                      <td
                        className={cn(
                          'px-3 py-2 text-right tabular-nums font-semibold cursor-pointer',
                          r.isClamped ? 'text-amber-700' : 'text-slate-900',
                        )}
                        title={
                          r.isClamped
                            ? `Clamped from ${r.clampedFrom} ${r.currency}`
                            : undefined
                        }
                        onClick={() => setDrawerKey(r.id)}
                      >
                        {Number(r.computedPrice).toFixed(2)}{' '}
                        <span className="text-[11px] text-slate-500 font-normal">
                          {r.currency}
                        </span>
                      </td>
                      <td
                        className="px-3 py-2 cursor-pointer"
                        onClick={() => setDrawerKey(r.id)}
                      >
                        <span
                          className={cn(
                            'inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded',
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
                            className="text-[11px] text-amber-700 inline-flex items-center gap-1"
                            title={r.warnings.join('; ')}
                          >
                            <AlertCircle size={11} /> {r.warnings.length}
                          </span>
                        ) : (
                          <span className="text-[11px] text-slate-400">—</span>
                        )}
                      </td>
                      <td
                        className="px-3 py-2 text-slate-400 cursor-pointer"
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
          <div className="px-4 py-2.5 border-t border-slate-200 flex items-center justify-between text-[12px] text-slate-600">
            <span>
              {data.total} snapshot{data.total === 1 ? '' : 's'} · page {data.page + 1} / {Math.max(1, totalPages)}
              {selected.size > 0 && (
                <span className="ml-3 text-blue-600 font-medium">
                  {selected.size} selected
                </span>
              )}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0 || loading}
                className="h-7 px-2 border border-slate-200 rounded text-[12px] disabled:opacity-40"
              >
                Prev
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page + 1 >= totalPages || loading}
                className="h-7 px-2 border border-slate-200 rounded text-[12px] disabled:opacity-40"
              >
                Next
              </button>
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
  const [pushing, setPushing] = useState(false)
  const [pushResult, setPushResult] = useState<string | null>(null)

  const push = async () => {
    setPushing(true)
    setPushResult(null)
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
        setPushResult(`Pushed ${json.pushedPrice} ${json.currency} to ${json.channel}:${json.marketplace}.`)
        onPushed()
      } else {
        setPushResult(json.error ?? `HTTP ${res.status}`)
      }
    } catch (e) {
      setPushResult(e instanceof Error ? e.message : String(e))
    } finally {
      setPushing(false)
    }
  }

  const breakdown = (row.breakdown ?? {}) as any

  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        className="flex-1 bg-slate-900/30 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="w-full max-w-xl bg-white border-l border-slate-200 shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-slate-900 truncate font-mono">
              {row.sku}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              {row.channel} · {row.marketplace}
              {row.fulfillmentMethod ? ` · ${row.fulfillmentMethod}` : ''}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Resolved */}
          <div className="bg-slate-50 rounded p-3">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
              Resolved price
            </div>
            <div className="text-[24px] font-semibold tabular-nums text-slate-900">
              {Number(row.computedPrice).toFixed(2)}{' '}
              <span className="text-[14px] font-normal text-slate-500">
                {row.currency}
              </span>
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Source:{' '}
              <span className="font-mono">{row.source}</span>
              {row.isClamped && (
                <span className="ml-2 text-amber-700">
                  · clamped from {row.clampedFrom}
                </span>
              )}
            </div>
          </div>

          {/* Breakdown */}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
              Breakdown
            </div>
            <dl className="grid grid-cols-2 gap-y-1 text-[12px]">
              <Item label="Master price" value={breakdown.masterPrice} suffix="EUR" />
              <Item label="FX rate" value={breakdown.fxRate} format="rate" />
              <Item label="Cost" value={breakdown.costPrice} suffix="EUR" />
              <Item label="FBA fee" value={breakdown.fbaFee} suffix={row.currency} />
              <Item label="Referral fee" value={breakdown.referralFee} suffix={row.currency} />
              <Item label="VAT rate" value={breakdown.vatRate} suffix="%" />
              <Item label="Min margin" value={breakdown.minMarginPercent} suffix="%" />
              <Item label="Tax-inclusive" value={breakdown.taxInclusive ? 'Yes' : 'No'} />
              {breakdown.appliedRule && (
                <>
                  <Item
                    label="Applied rule"
                    value={`${breakdown.appliedRule.type}${breakdown.appliedRule.adjustment != null ? ` (${breakdown.appliedRule.adjustment >= 0 ? '+' : ''}${breakdown.appliedRule.adjustment}%)` : ''}`}
                  />
                </>
              )}
            </dl>
          </div>

          {/* Warnings */}
          {row.warnings.length > 0 && (
            <div className="border border-amber-200 bg-amber-50 rounded p-3">
              <div className="text-[11px] uppercase tracking-wider text-amber-800 font-semibold mb-1">
                Warnings
              </div>
              <ul className="text-[12px] text-amber-800 space-y-0.5">
                {row.warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Push action */}
          <div className="border border-slate-200 rounded p-3">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2">
              Push to marketplace
            </div>
            <div className="text-[12px] text-slate-600 mb-2">
              Sends this resolved price to {row.channel} via the channel API.
              Logs to ChannelListingOverride for audit; respects 5-minute
              hold window if the channel is configured for it.
            </div>
            <button
              type="button"
              onClick={push}
              disabled={pushing}
              className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {pushing ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" /> Pushing…
                </>
              ) : (
                <>
                  <Send size={12} /> Push price
                </>
              )}
            </button>
            {pushResult && (
              <div
                className={cn(
                  'mt-2 text-[12px] inline-flex items-center gap-1.5',
                  pushResult.startsWith('Pushed') ? 'text-emerald-700' : 'text-rose-700',
                )}
              >
                {pushResult.startsWith('Pushed') ? (
                  <CheckCircle2 size={12} />
                ) : (
                  <AlertCircle size={12} />
                )}
                {pushResult}
              </div>
            )}
          </div>

          <div className="text-[11px] text-slate-400">
            Last computed {new Date(row.computedAt).toLocaleString()}
          </div>
        </div>
      </div>
    </div>
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
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-mono text-slate-800 text-right tabular-nums">
        {display}
        {suffix ? <span className="text-slate-400 ml-1">{suffix}</span> : null}
      </dd>
    </>
  )
}
