'use client'

/**
 * W9.6o — ForecastDetailDrawer + SupplierAlternativesPanel.
 *
 * Extracted from ReplenishmentWorkspace.tsx. The drawer is the
 * largest single inline component (~350 lines). It opens when an
 * operator clicks a SKU in the suggestions table and shows:
 *
 *   - 60-day actual + 90-day forecast chart with 80% prediction band
 *   - Per-location stock breakdown + ATP totals (R.2)
 *   - Per-channel days-of-cover (R.2)
 *   - Reorder math snapshot (R.4)
 *   - Amazon FBA Restock cross-check (R.8)
 *   - Supplier alternatives (R.9, defined here as a private helper)
 *   - Substitution links + raw-vs-adjusted velocity (R.17)
 *   - Open inbound shipments
 *   - Causal signals breakdown
 *   - Forecast accuracy card (R.1)
 *   - Recommendation history (R.3)
 *
 * SupplierAlternativesPanel is private to this file because nothing
 * else opens supplier-comparison drawers.
 *
 * Adds dark-mode classes throughout the chrome (panel surfaces,
 * borders, text, error/banner backgrounds, supplier card states).
 * Recharts color literals are unchanged — they need a theme-aware
 * refactor that's out of scope for the file split.
 */

import { useEffect, useState } from 'react'
import { X, Loader2, AlertCircle, RefreshCw } from 'lucide-react'
import {
  ResponsiveContainer,
  ComposedChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  Area,
  Line,
} from 'recharts'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import type { DetailResponse } from './types'
import { ReorderMathPanel } from './ReorderMathPanel'
import {
  SignalsPanel,
  StockByLocationPanel,
  ChannelCoverPanel,
} from './DrawerPanels'
import { FbaRestockSignalPanel } from './FbaRestockPanels'
import { SubstitutionPanel } from './SubstitutionPanel'
import { ForecastAccuracyCard } from './ForecastDiagnosticsCards'
import { RecommendationHistoryCard } from './RecommendationHistoryCard'

interface SupplierCandidate {
  supplierId: string
  supplierName: string
  unitCostCentsEur: number | null
  leadTimeDays: number
  moq: number
  casePack: number | null
  currencyCode: string
  compositeScore: number
  costScore: number
  speedScore: number
  flexScore: number
  reliabilityScore: number
  rank: number
  isCurrentlyPreferred: boolean
  paymentTerms: string | null
  notes: string[]
}

/**
 * R.9 — ranked alternative suppliers for this product. Lazy-loads
 * on first expand to avoid firing the request for every drawer open.
 * One-click switch of the preferred supplier calls the rec engine
 * to re-derive on next page render.
 */
function SupplierAlternativesPanel({
  productId,
  urgency,
  onChanged,
}: {
  productId: string
  urgency: string
  onChanged: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<{ candidates: SupplierCandidate[] } | null>(
    null,
  )
  const [loading, setLoading] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const url = new URL(
        `${getBackendUrl()}/api/fulfillment/replenishment/products/${productId}/supplier-comparison`,
      )
      url.searchParams.set('urgency', urgency)
      const res = await fetch(url.toString())
      if (res.ok) setData(await res.json())
    } finally {
      setLoading(false)
    }
  }

  async function switchPreferred(supplierId: string) {
    setSwitching(supplierId)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/products/${productId}/preferred-supplier`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ supplierId }),
        },
      )
      if (res.ok) {
        await load()
        await onChanged()
      }
    } finally {
      setSwitching(null)
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <button
        type="button"
        onClick={() => {
          if (!open && !data) load()
          setOpen((v) => !v)
        }}
        className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100 w-full"
      >
        <span>Supplier alternatives</span>
        <span className="text-xs text-slate-400 dark:text-slate-500">
          {open ? '▼' : '▶'} {data ? `${data.candidates.length} suppliers` : ''}
        </span>
      </button>
      {open && loading && (
        <div className="mt-2 text-base text-slate-400 dark:text-slate-500">
          Loading…
        </div>
      )}
      {open && !loading && data && data.candidates.length === 0 && (
        <p className="mt-2 text-base text-slate-500 dark:text-slate-400">
          No supplier rows for this product. Add a SupplierProduct entry to
          enable comparison.
        </p>
      )}
      {open && !loading && data && data.candidates.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {data.candidates.map((c) => (
            <li
              key={c.supplierId}
              className={cn(
                'rounded border p-2 text-base',
                c.isCurrentlyPreferred
                  ? 'border-indigo-300 dark:border-indigo-700 bg-indigo-50/40 dark:bg-indigo-950/30'
                  : 'border-slate-200 dark:border-slate-700',
              )}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-slate-400 dark:text-slate-500">
                    #{c.rank}
                  </span>
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    {c.supplierName}
                  </span>
                  {c.isCurrentlyPreferred && (
                    <span className="text-xs uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
                      preferred
                    </span>
                  )}
                </div>
                <div className="font-mono text-sm text-slate-700 dark:text-slate-300">
                  score {(c.compositeScore * 100).toFixed(0)}
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2 text-sm text-slate-600 dark:text-slate-400">
                <div>
                  <div className="text-slate-400 dark:text-slate-500">Cost</div>
                  <div className="font-mono">
                    {c.unitCostCentsEur != null
                      ? `€${(c.unitCostCentsEur / 100).toFixed(2)}`
                      : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400 dark:text-slate-500">Lead</div>
                  <div className="font-mono">{c.leadTimeDays}d</div>
                </div>
                <div>
                  <div className="text-slate-400 dark:text-slate-500">MOQ</div>
                  <div className="font-mono">{c.moq}</div>
                </div>
                <div>
                  <div className="text-slate-400 dark:text-slate-500">
                    Terms
                  </div>
                  <div className="font-mono truncate">
                    {c.paymentTerms ?? '—'}
                  </div>
                </div>
              </div>
              {c.notes.length > 0 && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-snug">
                  {c.notes.join(' · ')}
                </p>
              )}
              {!c.isCurrentlyPreferred && (
                <button
                  type="button"
                  onClick={() => switchPreferred(c.supplierId)}
                  disabled={switching === c.supplierId}
                  className="mt-1 text-sm text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50"
                >
                  {switching === c.supplierId
                    ? 'switching…'
                    : 'set as preferred'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ForecastDetailDrawer({
  productId,
  marketplace,
  channel,
  onClose,
}: {
  productId: string
  marketplace: string | null
  channel: string | null
  onClose: () => void
}) {
  const [detail, setDetail] = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  // R.5 — error state. Pre-R.5 a fetch failure left the spinner
  // running indefinitely; now we render an error panel with retry.
  const [error, setError] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    if (channel) params.set('channel', channel)
    if (marketplace) params.set('marketplace', marketplace)
    fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/${productId}/forecast-detail${
        params.toString() ? `?${params.toString()}` : ''
      }`,
      { cache: 'no-store' },
    )
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load (${r.status})`)
        return r.json()
      })
      .then((j) => {
        if (cancelled) return
        setDetail(j)
      })
      .catch((e: Error) => {
        if (cancelled) return
        setError(e.message)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [productId, channel, marketplace, retryTick])

  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        className="flex-1 bg-slate-900/30 dark:bg-slate-950/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-800">
          <div className="min-w-0">
            {detail ? (
              <>
                <div className="text-lg font-semibold text-slate-900 dark:text-slate-100 truncate">
                  {detail.product.name}
                </div>
                <div className="text-sm text-slate-500 dark:text-slate-400 font-mono">
                  {detail.product.sku}
                </div>
              </>
            ) : (
              <div className="text-md text-slate-500 dark:text-slate-400">
                Loading detail…
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading && !error && (
            <div className="text-md text-slate-500 dark:text-slate-400 inline-flex items-center gap-2 py-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading forecast…
            </div>
          )}
          {/* R.5 — error UI with retry. Pre-R.5 a fetch failure left
              the spinner running indefinitely. */}
          {!loading && error && (
            <div className="bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded p-4 text-md text-rose-800 dark:text-rose-300">
              <div className="flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold mb-1">
                    Couldn't load forecast detail
                  </div>
                  <div className="text-base mb-3">{error}</div>
                  <button
                    onClick={() => setRetryTick((n) => n + 1)}
                    className="h-7 px-2.5 text-sm bg-rose-600 dark:bg-rose-500 text-white rounded hover:bg-rose-700 dark:hover:bg-rose-600 inline-flex items-center gap-1"
                  >
                    <RefreshCw size={11} /> Retry
                  </button>
                </div>
              </div>
            </div>
          )}
          {!loading && !error && detail && (
            <>
              {/* 90-day chart */}
              <div>
                <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
                  60-day actual + 90-day forecast
                </div>
                <div className="h-56 w-full">
                  <ResponsiveContainer>
                    <ComposedChart
                      data={detail.series}
                      margin={{ left: 0, right: 8, top: 4, bottom: 4 }}
                    >
                      <CartesianGrid stroke="#eef2f7" vertical={false} />
                      <XAxis
                        dataKey="day"
                        tick={{ fontSize: 10, fill: '#64748b' }}
                        tickFormatter={(v) => v.slice(5)}
                        minTickGap={24}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: '#64748b' }}
                        width={28}
                      />
                      <Tooltip
                        contentStyle={{ fontSize: 11 }}
                        formatter={(v: unknown) =>
                          typeof v === 'number' ? v.toFixed(1) : (v as string)
                        }
                      />
                      <ReferenceLine
                        x={detail.series.find((p) => p.forecast != null)?.day}
                        stroke="#94a3b8"
                        strokeDasharray="4 4"
                        label={{
                          value: 'today',
                          fontSize: 10,
                          fill: '#64748b',
                          position: 'insideTopRight',
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="upper80"
                        stroke="none"
                        fill="#bfdbfe"
                        fillOpacity={0.3}
                      />
                      <Area
                        type="monotone"
                        dataKey="lower80"
                        stroke="none"
                        fill="#ffffff"
                        fillOpacity={1}
                      />
                      <Line
                        type="monotone"
                        dataKey="actual"
                        stroke="#0f172a"
                        strokeWidth={1.5}
                        dot={false}
                        connectNulls={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="forecast"
                        stroke="#3b82f6"
                        strokeWidth={1.5}
                        dot={false}
                        connectNulls={false}
                        strokeDasharray="3 3"
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-1 flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-3 h-px bg-slate-900 dark:bg-slate-100" />{' '}
                    actual
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-3 h-px border-t border-dashed border-blue-500 dark:border-blue-400" />{' '}
                    forecast
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-3 h-2 bg-blue-200 dark:bg-blue-900 rounded-sm" />{' '}
                    80% interval
                  </span>
                  {detail.generationTag && (
                    <span className="ml-auto text-xs uppercase tracking-wider text-amber-700 dark:text-amber-400">
                      {detail.generationTag.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  )}
                </div>
              </div>

              {/* R.2 — per-location stock breakdown + ATP totals */}
              {detail.atp && <StockByLocationPanel atp={detail.atp} />}

              {/* R.14 — channel-driven urgency banner. Renders only
                  when the worst channel pushed urgency above what the
                  global aggregate would have shown. Tells operators
                  why the headline is more severe than the totals
                  suggest. */}
              {detail.recommendation?.urgencySource === 'CHANNEL' &&
                detail.recommendation?.worstChannelKey && (
                  <div className="rounded-md border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-base text-rose-800 dark:text-rose-300">
                    <span className="font-semibold">
                      {detail.recommendation.urgency}
                    </span>{' '}
                    driven by{' '}
                    <span className="font-mono">
                      {detail.recommendation.worstChannelKey.replace(
                        ':',
                        ' · ',
                      )}
                    </span>{' '}
                    ({detail.recommendation.worstChannelDaysOfCover}d cover).
                    Aggregate stock looks fine, but this channel is at risk.
                  </div>
                )}

              {/* R.2 — per-channel days-of-cover */}
              {detail.channelCover && detail.channelCover.length > 0 && (
                <ChannelCoverPanel
                  channelCover={detail.channelCover}
                  leadTimeDays={detail.atp?.leadTimeDays ?? 14}
                />
              )}

              {/* R.4 — reorder math snapshot. Shows EOQ, safety stock,
                  reorder point, and any MOQ/case-pack constraints
                  that bumped the final qty up. */}
              {detail.recommendation && (
                <ReorderMathPanel rec={detail.recommendation} />
              )}

              {/* R.8 — Amazon FBA Restock cross-check. Renders only
                  when this product has a fresh Amazon recommendation
                  cached on the rec. */}
              {detail.recommendation?.amazonRecommendedQty != null &&
                detail.recommendation && (
                  <FbaRestockSignalPanel rec={detail.recommendation} />
                )}

              {/* R.9 — supplier alternatives. Lazy-loaded panel that
                  ranks every supplier with a SupplierProduct row for
                  this product. */}
              <SupplierAlternativesPanel
                productId={productId}
                urgency={detail.recommendation?.urgency ?? 'MEDIUM'}
                onChanged={async () => {
                  const params = new URLSearchParams()
                  if (marketplace) params.set('marketplace', marketplace)
                  if (channel) params.set('channel', channel)
                  const r = await fetch(
                    `${getBackendUrl()}/api/fulfillment/replenishment/${productId}/forecast-detail${
                      params.toString() ? `?${params.toString()}` : ''
                    }`,
                  )
                  if (r.ok) setDetail(await r.json())
                }}
              />

              {/* R.17 — substitution links + raw-vs-adjusted velocity. */}
              <SubstitutionPanel
                productId={productId}
                rec={detail.recommendation}
                substitutions={detail.substitutions ?? []}
                onChanged={async () => {
                  const params = new URLSearchParams()
                  if (marketplace) params.set('marketplace', marketplace)
                  if (channel) params.set('channel', channel)
                  const r = await fetch(
                    `${getBackendUrl()}/api/fulfillment/replenishment/${productId}/forecast-detail${
                      params.toString() ? `?${params.toString()}` : ''
                    }`,
                  )
                  if (r.ok) setDetail(await r.json())
                }}
              />

              {/* Open shipments */}
              {detail.atp && detail.atp.openShipments.length > 0 && (
                <div>
                  <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">
                    Open inbound shipments
                  </div>
                  <div className="border border-slate-200 dark:border-slate-800 rounded overflow-hidden">
                    {detail.atp.openShipments.map((sh) => (
                      <div
                        key={sh.shipmentId}
                        className="flex items-center justify-between px-3 py-1.5 text-base border-b border-slate-100 dark:border-slate-800 last:border-0"
                      >
                        <div>
                          <span className="font-mono text-sm text-slate-700 dark:text-slate-300">
                            {sh.reference ?? sh.shipmentId.slice(-8)}
                          </span>
                          <span className="ml-2 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
                            {sh.type} · {sh.status}
                          </span>
                        </div>
                        <div className="text-slate-700 dark:text-slate-300 tabular-nums">
                          +{sh.remainingUnits} units
                          {sh.expectedAt && (
                            <span className="ml-2 text-sm text-slate-500 dark:text-slate-400">
                              {new Date(sh.expectedAt)
                                .toISOString()
                                .slice(0, 10)}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Signals breakdown */}
              {detail.signals && typeof detail.signals === 'object' && (
                <SignalsPanel signals={detail.signals} />
              )}

              {/* R.1 — Forecast accuracy. Below signals so the reading
                  flow is prediction → causal → retrospective. */}
              <ForecastAccuracyCard
                sku={detail.product?.sku ?? null}
                channel={null}
                marketplace={null}
              />

              {/* R.3 — Recommendation history. Audit trail of every
                  recommendation we've ever shown for this product +
                  the POs/WOs that came from them. Collapsed by
                  default; expand to load. */}
              <RecommendationHistoryCard
                productId={detail.product?.id ?? null}
              />

              {/* Model */}
              {detail.model && (
                <div className="text-sm text-slate-500 dark:text-slate-400">
                  Generated by{' '}
                  <span className="font-mono text-slate-700 dark:text-slate-300">
                    {detail.model}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
