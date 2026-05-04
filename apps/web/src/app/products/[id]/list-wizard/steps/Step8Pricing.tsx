'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'

interface ChannelContext {
  platform: string
  marketplace: string
  channelKey: string
  currency: string
  defaultFees: { referralPercent: number; fulfillmentFee: number; notes: string }
}

interface PricingContext {
  product: {
    basePrice: number
    costPrice: number | null
    minPrice: number | null
    maxPrice: number | null
    buyBoxPrice: number | null
    competitorPrice: number | null
  }
  channels: ChannelContext[]
}

interface BasePricingSlice {
  /** Master price applied to every channel by default. */
  basePrice?: number
  minPrice?: number
  maxPrice?: number
}

interface ChannelPricingSlice {
  marketplacePrice?: number
  minPrice?: number
  maxPrice?: number
  referralPercent?: number
  fulfillmentFee?: number
}

const SAVE_DEBOUNCE_MS = 600

export default function Step8Pricing({
  wizardState,
  updateWizardState,
  wizardId,
  channels,
}: StepProps) {
  const baseSlice = (wizardState.pricing ?? {}) as BasePricingSlice
  const channelStates =
    (wizardState.channelStates ?? {}) as Record<
      string,
      Record<string, any>
    >

  const [ctx, setCtx] = useState<PricingContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Base price + repricing band — applies to every channel by
  // default. Each channel inherits these unless it has its own
  // override.
  const [base, setBase] = useState<{
    basePrice: string
    minPrice: string
    maxPrice: string
  }>({
    basePrice:
      baseSlice.basePrice !== undefined ? String(baseSlice.basePrice) : '',
    minPrice:
      baseSlice.minPrice !== undefined ? String(baseSlice.minPrice) : '',
    maxPrice:
      baseSlice.maxPrice !== undefined ? String(baseSlice.maxPrice) : '',
  })

  // Per-channel overrides — only set when the user actually overrides.
  // String values for input control; parsed to numbers on save +
  // computation.
  const [overrides, setOverrides] = useState<
    Record<string, Record<keyof ChannelPricingSlice, string>>
  >(() => {
    const seed: Record<string, Record<keyof ChannelPricingSlice, string>> = {}
    for (const [chKey, slice] of Object.entries(channelStates)) {
      const p = (slice as any).pricing as ChannelPricingSlice | undefined
      if (!p) continue
      seed[chKey] = {
        marketplacePrice:
          p.marketplacePrice !== undefined ? String(p.marketplacePrice) : '',
        minPrice: p.minPrice !== undefined ? String(p.minPrice) : '',
        maxPrice: p.maxPrice !== undefined ? String(p.maxPrice) : '',
        referralPercent:
          p.referralPercent !== undefined ? String(p.referralPercent) : '',
        fulfillmentFee:
          p.fulfillmentFee !== undefined ? String(p.fulfillmentFee) : '',
      }
    }
    return seed
  })

  useEffect(() => {
    if (channels.length === 0) {
      setLoading(false)
      setError('Pick channels in Step 1 first.')
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/listing-wizard/${wizardId}/pricing-context`)
      .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
      .then(({ ok, status, json }) => {
        if (cancelled) return
        if (!ok) {
          setError(json?.error ?? `HTTP ${status}`)
          return
        }
        const c = json as PricingContext
        setCtx(c)
        // Seed base from master product when the user hasn't set
        // anything yet.
        setBase((prev) => {
          const next = { ...prev }
          if (next.basePrice === '' && c.product.basePrice > 0) {
            next.basePrice = String(c.product.basePrice)
          }
          if (next.minPrice === '' && c.product.minPrice !== null) {
            next.minPrice = String(c.product.minPrice)
          }
          if (next.maxPrice === '' && c.product.maxPrice !== null) {
            next.maxPrice = String(c.product.maxPrice)
          }
          return next
        })
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [channels.length, wizardId])

  // Debounced persist of base.
  const baseSaveTimer = useRef<number | null>(null)
  useEffect(() => {
    if (loading) return
    if (baseSaveTimer.current) window.clearTimeout(baseSaveTimer.current)
    baseSaveTimer.current = window.setTimeout(() => {
      void updateWizardState({
        pricing: {
          basePrice: parseNum(base.basePrice),
          minPrice: parseNum(base.minPrice),
          maxPrice: parseNum(base.maxPrice),
        },
      })
    }, SAVE_DEBOUNCE_MS)
    return () => {
      if (baseSaveTimer.current) window.clearTimeout(baseSaveTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, loading])

  // Debounced persist of overrides via channelStates 2-level merge.
  const overrideSaveTimer = useRef<number | null>(null)
  useEffect(() => {
    if (loading) return
    if (overrideSaveTimer.current)
      window.clearTimeout(overrideSaveTimer.current)
    overrideSaveTimer.current = window.setTimeout(() => {
      const channelStatesPatch: Record<string, Record<string, unknown>> = {}
      for (const [chKey, slice] of Object.entries(overrides)) {
        const pricing: ChannelPricingSlice = {}
        if (slice.marketplacePrice !== '')
          pricing.marketplacePrice = parseNum(slice.marketplacePrice)
        if (slice.minPrice !== '') pricing.minPrice = parseNum(slice.minPrice)
        if (slice.maxPrice !== '') pricing.maxPrice = parseNum(slice.maxPrice)
        if (slice.referralPercent !== '')
          pricing.referralPercent = parseNum(slice.referralPercent)
        if (slice.fulfillmentFee !== '')
          pricing.fulfillmentFee = parseNum(slice.fulfillmentFee)
        channelStatesPatch[chKey] = { pricing }
      }
      if (Object.keys(channelStatesPatch).length > 0) {
        void fetch(
          `${getBackendUrl()}/api/listing-wizard/${wizardId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelStates: channelStatesPatch }),
          },
        ).catch(() => {})
      }
    }, SAVE_DEBOUNCE_MS)
    return () => {
      if (overrideSaveTimer.current)
        window.clearTimeout(overrideSaveTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides, loading])

  const setOverride = useCallback(
    (chKey: string, key: keyof ChannelPricingSlice, value: string) => {
      setOverrides((prev) => {
        const slice = {
          ...(prev[chKey] ?? {
            marketplacePrice: '',
            minPrice: '',
            maxPrice: '',
            referralPercent: '',
            fulfillmentFee: '',
          }),
        }
        slice[key] = value
        return { ...prev, [chKey]: slice }
      })
    },
    [],
  )

  const computeForChannel = useCallback(
    (chKey: string, c: ChannelContext) => {
      const ovr = overrides[chKey]
      const price =
        parseNum(ovr?.marketplacePrice ?? '') ?? parseNum(base.basePrice) ?? 0
      const referralPct =
        parseNum(ovr?.referralPercent ?? '') ?? c.defaultFees.referralPercent
      const ffee =
        parseNum(ovr?.fulfillmentFee ?? '') ?? c.defaultFees.fulfillmentFee
      const cost = ctx?.product.costPrice ?? 0
      const referralFee = price * (referralPct / 100)
      const totalFees = referralFee + ffee
      const netRevenue = price - totalFees
      const netMargin = netRevenue - cost
      const netMarginPct = price > 0 ? (netMargin / price) * 100 : 0
      const minP =
        parseNum(ovr?.minPrice ?? '') ?? parseNum(base.minPrice) ?? null
      const maxP =
        parseNum(ovr?.maxPrice ?? '') ?? parseNum(base.maxPrice) ?? null
      const inheritsBase = !ovr || isEmptyOverride(ovr)
      return {
        price,
        cost,
        referralPct,
        referralFee,
        ffee,
        totalFees,
        netRevenue,
        netMargin,
        netMarginPct,
        minP,
        maxP,
        inheritsBase,
      }
    },
    [base, ctx, overrides],
  )

  const issuesByChannel = useMemo(() => {
    const out: Record<string, { blocking: string[]; warnings: string[] }> = {}
    if (!ctx) return out
    for (const c of ctx.channels) {
      const r = computeForChannel(c.channelKey, c)
      const blocking: string[] = []
      const warnings: string[] = []
      if (r.price <= 0) blocking.push('Price must be greater than 0.')
      if (
        r.minP !== null &&
        r.maxP !== null &&
        r.minP > r.maxP
      ) {
        blocking.push('Min price must be ≤ max price.')
      }
      if (r.minP !== null && r.price < r.minP) {
        warnings.push('Listing price is below the repricing floor.')
      }
      if (r.maxP !== null && r.price > r.maxP) {
        warnings.push('Listing price is above the repricing ceiling.')
      }
      if (r.cost > 0 && r.netMargin < 0) {
        warnings.push(
          `Net margin is negative (${r.netMargin.toFixed(2)} ${c.currency}).`,
        )
      }
      if (r.cost === 0 && r.price > 0) {
        warnings.push('No costPrice on the master product — margin assumes 0.')
      }
      out[c.channelKey] = { blocking, warnings }
    }
    return out
  }, [computeForChannel, ctx])

  const totalBlocking = useMemo(() => {
    return Object.values(issuesByChannel).reduce(
      (acc, v) => acc + v.blocking.length,
      0,
    )
  }, [issuesByChannel])

  const onContinue = useCallback(async () => {
    if (totalBlocking > 0) return
    await updateWizardState({}, { advance: true })
  }, [totalBlocking, updateWizardState])

  if (channels.length === 0) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-6 text-center">
        <p className="text-[13px] text-slate-600">
          Pick channels in Step 1 first.
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="mb-6">
        <h2 className="text-[20px] font-semibold text-slate-900">Pricing</h2>
        <p className="text-[13px] text-slate-600 mt-1">
          Set a base price; every channel inherits it. Override per
          marketplace when local fees, currency, or competitive pressure
          calls for a different number.
        </p>
      </div>

      {loading && (
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-12 text-center text-[13px] text-slate-500 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading pricing context…
        </div>
      )}

      {error && !loading && (
        <div className="border border-rose-200 rounded-lg bg-rose-50 px-4 py-3 text-[13px] text-rose-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {ctx && !loading && (
        <>
          {/* Base pricing */}
          <div className="border border-slate-200 rounded-lg bg-white px-4 py-3 mb-4">
            <div className="text-[12px] font-medium text-slate-700 mb-2">
              Base pricing (applies to every channel by default)
            </div>
            <div className="grid grid-cols-3 gap-3">
              <BaseField
                label="Base price"
                value={base.basePrice}
                onChange={(v) => setBase((p) => ({ ...p, basePrice: v }))}
                placeholder={String(ctx.product.basePrice)}
              />
              <BaseField
                label="Min price"
                value={base.minPrice}
                onChange={(v) => setBase((p) => ({ ...p, minPrice: v }))}
              />
              <BaseField
                label="Max price"
                value={base.maxPrice}
                onChange={(v) => setBase((p) => ({ ...p, maxPrice: v }))}
              />
            </div>
            {ctx.product.costPrice !== null && (
              <p className="mt-2 text-[11px] text-slate-500">
                Master cost: {formatMoney(ctx.product.costPrice, 'EUR')}
                {ctx.product.buyBoxPrice !== null &&
                  ` · Buy Box: ${formatMoney(ctx.product.buyBoxPrice, 'EUR')}`}
                {ctx.product.competitorPrice !== null &&
                  ` · Lowest competitor: ${formatMoney(
                    ctx.product.competitorPrice,
                    'EUR',
                  )}`}
              </p>
            )}
          </div>

          {/* Per-channel override grid */}
          <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
            <div className="px-3 py-2 border-b border-slate-200 text-[12px] font-medium text-slate-700">
              Per-channel overrides &amp; margins
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wide">
                    <th className="text-left px-3 py-1.5">Channel</th>
                    <th className="text-left px-2 py-1.5">Price</th>
                    <th className="text-left px-2 py-1.5">Min</th>
                    <th className="text-left px-2 py-1.5">Max</th>
                    <th className="text-left px-2 py-1.5">Ref %</th>
                    <th className="text-left px-2 py-1.5">FFee</th>
                    <th className="text-right px-3 py-1.5">Net margin</th>
                  </tr>
                </thead>
                <tbody>
                  {ctx.channels.map((c) => {
                    const r = computeForChannel(c.channelKey, c)
                    const ovr = overrides[c.channelKey] ?? {
                      marketplacePrice: '',
                      minPrice: '',
                      maxPrice: '',
                      referralPercent: '',
                      fulfillmentFee: '',
                    }
                    const issues = issuesByChannel[c.channelKey] ?? {
                      blocking: [],
                      warnings: [],
                    }
                    const tone =
                      issues.blocking.length > 0
                        ? 'bg-rose-50/40'
                        : issues.warnings.length > 0
                        ? 'bg-amber-50/40'
                        : ''
                    const marginTone =
                      r.netMargin < 0
                        ? 'text-rose-700'
                        : r.netMargin > 0
                        ? 'text-emerald-700'
                        : 'text-slate-600'
                    const MarginIcon =
                      r.netMargin < 0
                        ? TrendingDown
                        : r.netMargin > 0
                        ? TrendingUp
                        : null
                    return (
                      <tr
                        key={c.channelKey}
                        className={cn(
                          'border-t border-slate-100',
                          tone,
                        )}
                      >
                        <td className="px-3 py-2">
                          <div className="font-mono text-[11px] text-slate-700 font-medium">
                            {c.channelKey}
                          </div>
                          <div className="text-[10px] text-slate-500">
                            {c.currency}{' '}
                            {r.inheritsBase && (
                              <span className="ml-1 text-slate-400 italic">
                                · inherits base
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-2">
                          <CompactInput
                            value={ovr.marketplacePrice}
                            placeholder={
                              parseNum(base.basePrice)?.toFixed(2) ?? '—'
                            }
                            onChange={(v) =>
                              setOverride(c.channelKey, 'marketplacePrice', v)
                            }
                          />
                        </td>
                        <td className="px-2 py-2">
                          <CompactInput
                            value={ovr.minPrice}
                            placeholder={
                              parseNum(base.minPrice)?.toFixed(2) ?? '—'
                            }
                            onChange={(v) =>
                              setOverride(c.channelKey, 'minPrice', v)
                            }
                          />
                        </td>
                        <td className="px-2 py-2">
                          <CompactInput
                            value={ovr.maxPrice}
                            placeholder={
                              parseNum(base.maxPrice)?.toFixed(2) ?? '—'
                            }
                            onChange={(v) =>
                              setOverride(c.channelKey, 'maxPrice', v)
                            }
                          />
                        </td>
                        <td className="px-2 py-2">
                          <CompactInput
                            value={ovr.referralPercent}
                            placeholder={String(c.defaultFees.referralPercent)}
                            onChange={(v) =>
                              setOverride(c.channelKey, 'referralPercent', v)
                            }
                          />
                        </td>
                        <td className="px-2 py-2">
                          <CompactInput
                            value={ovr.fulfillmentFee}
                            placeholder={String(c.defaultFees.fulfillmentFee)}
                            onChange={(v) =>
                              setOverride(c.channelKey, 'fulfillmentFee', v)
                            }
                          />
                        </td>
                        <td
                          className={cn(
                            'px-3 py-2 tabular-nums text-right',
                            marginTone,
                          )}
                        >
                          <span className="inline-flex items-center gap-1">
                            {MarginIcon && (
                              <MarginIcon className="w-3 h-3" />
                            )}
                            {formatMoney(r.netMargin, c.currency)}
                          </span>
                          <div className="text-[10px] text-slate-500">
                            {r.netMarginPct.toFixed(1)}%
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Per-channel issues */}
          {Object.entries(issuesByChannel).some(
            ([, v]) => v.blocking.length > 0 || v.warnings.length > 0,
          ) && (
            <div className="mt-4 space-y-1.5">
              {Object.entries(issuesByChannel).map(([chKey, v]) => {
                if (v.blocking.length === 0 && v.warnings.length === 0) {
                  return null
                }
                return (
                  <div key={chKey} className="text-[11px]">
                    {v.blocking.map((m, i) => (
                      <div
                        key={`b-${i}`}
                        className="text-rose-700 inline-flex items-start gap-1.5"
                      >
                        <AlertCircle className="w-3 h-3 mt-0.5" />
                        <span>
                          <span className="font-mono">{chKey}</span>: {m}
                        </span>
                      </div>
                    ))}
                    {v.warnings.map((m, i) => (
                      <div
                        key={`w-${i}`}
                        className="text-amber-700 inline-flex items-start gap-1.5"
                      >
                        <AlertCircle className="w-3 h-3 mt-0.5" />
                        <span>
                          <span className="font-mono">{chKey}</span>: {m}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )}

          {/* Continue */}
          <div className="mt-6 flex items-center justify-between gap-3">
            <div className="text-[12px]">
              {totalBlocking === 0 ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-700">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Pricing satisfied across every channel.
                </span>
              ) : (
                <span className="text-rose-700">
                  {totalBlocking} blocking pricing issue
                  {totalBlocking === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={onContinue}
              disabled={totalBlocking > 0}
              className={cn(
                'h-8 px-4 rounded-md text-[13px] font-medium',
                totalBlocking > 0
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  : 'bg-blue-600 text-white hover:bg-blue-700',
              )}
            >
              Continue
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function BaseField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-slate-600 mb-0.5">
        {label}
      </label>
      <input
        type="number"
        step="0.01"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-8 px-2 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
      />
    </div>
  )
}

function CompactInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <input
      type="number"
      step="0.01"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-20 h-7 px-1.5 text-[12px] border border-slate-200 rounded text-right tabular-nums focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 placeholder:text-slate-300"
    />
  )
}

function isEmptyOverride(
  ovr: Record<keyof ChannelPricingSlice, string>,
): boolean {
  return Object.values(ovr).every((v) => v === '' || v === undefined)
}

function parseNum(s: string | undefined): number | undefined {
  if (s === '' || s === undefined) return undefined
  const n = Number(s)
  if (Number.isNaN(n)) return undefined
  return n
}

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency}`
  }
}
