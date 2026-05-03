'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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

interface PricingContext {
  currency: string
  product: {
    basePrice: number
    costPrice: number | null
    minPrice: number | null
    maxPrice: number | null
    buyBoxPrice: number | null
    competitorPrice: number | null
  }
  fees: {
    referralPercent: number
    fulfillmentFee: number
    notes: string
  }
}

interface PricingSlice {
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
}: StepProps) {
  const slice = (wizardState.pricing ?? {}) as PricingSlice

  const [ctx, setCtx] = useState<PricingContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [marketplacePrice, setMarketplacePrice] = useState<string>(
    slice.marketplacePrice !== undefined
      ? String(slice.marketplacePrice)
      : '',
  )
  const [minPrice, setMinPrice] = useState<string>(
    slice.minPrice !== undefined ? String(slice.minPrice) : '',
  )
  const [maxPrice, setMaxPrice] = useState<string>(
    slice.maxPrice !== undefined ? String(slice.maxPrice) : '',
  )
  const [referralPercent, setReferralPercent] = useState<string>(
    slice.referralPercent !== undefined
      ? String(slice.referralPercent)
      : '',
  )
  const [fulfillmentFee, setFulfillmentFee] = useState<string>(
    slice.fulfillmentFee !== undefined
      ? String(slice.fulfillmentFee)
      : '',
  )

  // Fetch the master product's pricing + channel-default fees.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(
      `${getBackendUrl()}/api/listing-wizard/${wizardId}/pricing-context`,
    )
      .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
      .then(({ ok, status, json }) => {
        if (cancelled) return
        if (!ok) {
          setError(json?.error ?? `HTTP ${status}`)
          return
        }
        const c = json as PricingContext
        setCtx(c)
        // Seed inputs with defaults only if they're not already set.
        if (marketplacePrice === '' && c.product.basePrice > 0) {
          setMarketplacePrice(String(c.product.basePrice))
        }
        if (minPrice === '' && c.product.minPrice !== null) {
          setMinPrice(String(c.product.minPrice))
        }
        if (maxPrice === '' && c.product.maxPrice !== null) {
          setMaxPrice(String(c.product.maxPrice))
        }
        if (referralPercent === '') {
          setReferralPercent(String(c.fees.referralPercent))
        }
        if (fulfillmentFee === '') {
          setFulfillmentFee(String(c.fees.fulfillmentFee))
        }
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
    // Only seed once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardId])

  // Debounced persist.
  useEffect(() => {
    if (loading) return
    const t = window.setTimeout(() => {
      const next: PricingSlice = {
        marketplacePrice: parseNum(marketplacePrice),
        minPrice: parseNum(minPrice),
        maxPrice: parseNum(maxPrice),
        referralPercent: parseNum(referralPercent),
        fulfillmentFee: parseNum(fulfillmentFee),
      }
      void updateWizardState({ pricing: next })
    }, SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
    // updateWizardState is stable from the wizard shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    loading,
    marketplacePrice,
    minPrice,
    maxPrice,
    referralPercent,
    fulfillmentFee,
  ])

  const computed = useMemo(() => {
    const price = parseNum(marketplacePrice) ?? 0
    const cost = ctx?.product.costPrice ?? 0
    const refPct = parseNum(referralPercent) ?? 0
    const ffee = parseNum(fulfillmentFee) ?? 0
    const referralFee = price * (refPct / 100)
    const totalFees = referralFee + ffee
    const netRevenue = price - totalFees
    const grossMargin = price - cost
    const grossMarginPct = price > 0 ? (grossMargin / price) * 100 : 0
    const netMargin = netRevenue - cost
    const netMarginPct = price > 0 ? (netMargin / price) * 100 : 0
    return {
      price,
      cost,
      referralFee,
      totalFees,
      netRevenue,
      grossMargin,
      grossMarginPct,
      netMargin,
      netMarginPct,
    }
  }, [
    ctx?.product.costPrice,
    marketplacePrice,
    referralPercent,
    fulfillmentFee,
  ])

  const issues = useMemo(() => {
    const blocking: string[] = []
    const warnings: string[] = []
    const price = parseNum(marketplacePrice)
    const min = parseNum(minPrice)
    const max = parseNum(maxPrice)

    if (price === undefined || price <= 0) {
      blocking.push('Marketplace price is required and must be greater than 0.')
    }
    if (min !== undefined && max !== undefined && min > max) {
      blocking.push('Min price must be ≤ max price.')
    }
    if (price !== undefined && min !== undefined && price < min) {
      warnings.push(
        'Listing price is below your repricing floor — saved as-is, but the repricer would push it back up.',
      )
    }
    if (price !== undefined && max !== undefined && price > max) {
      warnings.push(
        'Listing price is above your repricing ceiling — repricer will pull it down.',
      )
    }
    if (computed.netMargin < 0 && computed.cost > 0) {
      warnings.push(
        `Net margin is negative (${computed.netMargin.toFixed(2)} ${ctx?.currency ?? ''}) — you'd lose money on every sale at this price.`,
      )
    }
    if (
      computed.cost === 0 &&
      ctx?.product.costPrice === null &&
      price !== undefined &&
      price > 0
    ) {
      warnings.push(
        "No costPrice on the master product — margin shown assumes cost = 0. Set costPrice on the product to see the real margin.",
      )
    }
    return { blocking, warnings }
  }, [
    computed.cost,
    computed.netMargin,
    ctx?.currency,
    ctx?.product.costPrice,
    marketplacePrice,
    maxPrice,
    minPrice,
  ])

  const onContinue = useCallback(async () => {
    if (issues.blocking.length > 0) return
    await updateWizardState(
      {
        pricing: {
          marketplacePrice: parseNum(marketplacePrice),
          minPrice: parseNum(minPrice),
          maxPrice: parseNum(maxPrice),
          referralPercent: parseNum(referralPercent),
          fulfillmentFee: parseNum(fulfillmentFee),
        } as PricingSlice,
      },
      { advance: true },
    )
  }, [
    fulfillmentFee,
    issues.blocking.length,
    marketplacePrice,
    maxPrice,
    minPrice,
    referralPercent,
    updateWizardState,
  ])

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="mb-6">
        <h2 className="text-[20px] font-semibold text-slate-900">Pricing</h2>
        <p className="text-[13px] text-slate-600 mt-1">
          Set the marketplace price and (optional) repricing bounds. Margins
          update live based on cost + channel fee assumptions.
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* ── Inputs ────────────────────────────────────────────── */}
          <div className="space-y-4">
            <Field
              label="Marketplace price"
              required
              suffix={ctx.currency}
              value={marketplacePrice}
              onChange={setMarketplacePrice}
              hint={`Master price: ${formatMoney(ctx.product.basePrice, ctx.currency)}`}
            />
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Min price"
                suffix={ctx.currency}
                value={minPrice}
                onChange={setMinPrice}
                hint="Repricing floor"
              />
              <Field
                label="Max price"
                suffix={ctx.currency}
                value={maxPrice}
                onChange={setMaxPrice}
                hint="Repricing ceiling"
              />
            </div>
            <Field
              label="Referral fee"
              suffix="%"
              value={referralPercent}
              onChange={setReferralPercent}
            />
            <Field
              label="Fulfillment fee"
              suffix={ctx.currency}
              value={fulfillmentFee}
              onChange={setFulfillmentFee}
            />
            <p className="text-[11px] text-slate-500">{ctx.fees.notes}</p>
          </div>

          {/* ── Margin readout ────────────────────────────────────── */}
          <div className="border border-slate-200 rounded-lg bg-white px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">
              Margin breakdown
            </div>
            <Row
              label="Listing price"
              value={formatMoney(computed.price, ctx.currency)}
            />
            <Row
              label="Less: referral fee"
              value={`− ${formatMoney(computed.referralFee, ctx.currency)}`}
              muted
            />
            <Row
              label="Less: fulfillment fee"
              value={`− ${formatMoney(parseNum(fulfillmentFee) ?? 0, ctx.currency)}`}
              muted
            />
            <Row
              label="Net revenue"
              value={formatMoney(computed.netRevenue, ctx.currency)}
              divider
            />
            <Row
              label="Less: cost"
              value={`− ${formatMoney(computed.cost, ctx.currency)}`}
              muted
            />
            <Row
              label="Net margin"
              value={formatMoney(computed.netMargin, ctx.currency)}
              strong
              divider
              tone={
                computed.netMargin > 0
                  ? 'positive'
                  : computed.netMargin < 0
                  ? 'negative'
                  : 'neutral'
              }
              icon={
                computed.netMargin > 0 ? (
                  <TrendingUp className="w-3.5 h-3.5" />
                ) : computed.netMargin < 0 ? (
                  <TrendingDown className="w-3.5 h-3.5" />
                ) : null
              }
            />
            <Row
              label="Net margin %"
              value={`${computed.netMarginPct.toFixed(1)}%`}
              tone={
                computed.netMarginPct > 0
                  ? 'positive'
                  : computed.netMarginPct < 0
                  ? 'negative'
                  : 'neutral'
              }
            />

            {(ctx.product.buyBoxPrice !== null ||
              ctx.product.competitorPrice !== null) && (
              <div className="mt-3 pt-3 border-t border-slate-200 space-y-1">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">
                  Marketplace context
                </div>
                {ctx.product.buyBoxPrice !== null && (
                  <Row
                    label="Buy Box"
                    value={formatMoney(
                      ctx.product.buyBoxPrice,
                      ctx.currency,
                    )}
                    muted
                  />
                )}
                {ctx.product.competitorPrice !== null && (
                  <Row
                    label="Lowest competitor"
                    value={formatMoney(
                      ctx.product.competitorPrice,
                      ctx.currency,
                    )}
                    muted
                  />
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Validation + Continue */}
      {ctx && !loading && (
        <div className="mt-6">
          <ValidationPanel
            blocking={issues.blocking}
            warnings={issues.warnings}
          />
          <div className="mt-3 flex items-center justify-end">
            <button
              type="button"
              onClick={onContinue}
              disabled={issues.blocking.length > 0}
              className={cn(
                'h-8 px-4 rounded-md text-[13px] font-medium',
                issues.blocking.length > 0
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  : 'bg-blue-600 text-white hover:bg-blue-700',
              )}
            >
              Continue
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  required,
  suffix,
  value,
  onChange,
  hint,
}: {
  label: string
  required?: boolean
  suffix?: string
  value: string
  onChange: (v: string) => void
  hint?: string
}) {
  return (
    <div>
      <label className="block text-[12px] font-medium text-slate-700 mb-0.5">
        {label}
        {required && <span className="text-rose-600 ml-0.5">*</span>}
      </label>
      <div className="relative flex items-center">
        <input
          type="number"
          step="0.01"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full h-8 px-2 pr-12 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
        />
        {suffix && (
          <span className="absolute right-2 text-[11px] text-slate-400 pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
      {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
    </div>
  )
}

function Row({
  label,
  value,
  muted,
  strong,
  divider,
  tone = 'neutral',
  icon,
}: {
  label: string
  value: string
  muted?: boolean
  strong?: boolean
  divider?: boolean
  tone?: 'positive' | 'negative' | 'neutral'
  icon?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between text-[12px] py-1',
        divider && 'mt-1 pt-2 border-t border-slate-100',
      )}
    >
      <span className={cn(muted ? 'text-slate-500' : 'text-slate-700')}>
        {label}
      </span>
      <span
        className={cn(
          'tabular-nums inline-flex items-center gap-1',
          muted && 'text-slate-500',
          strong && 'font-semibold',
          tone === 'positive' && 'text-emerald-700',
          tone === 'negative' && 'text-rose-700',
        )}
      >
        {icon}
        {value}
      </span>
    </div>
  )
}

function ValidationPanel({
  blocking,
  warnings,
}: {
  blocking: string[]
  warnings: string[]
}) {
  if (blocking.length === 0 && warnings.length === 0) {
    return (
      <p className="text-[12px] text-emerald-700 inline-flex items-center gap-1.5">
        <CheckCircle2 className="w-3.5 h-3.5" />
        Pricing looks good.
      </p>
    )
  }
  return (
    <div className="space-y-1.5">
      {blocking.map((msg, i) => (
        <div
          key={`b-${i}`}
          className="text-[12px] text-rose-700 inline-flex items-start gap-1.5"
        >
          <AlertCircle className="w-3.5 h-3.5 mt-0.5" />
          <span>{msg}</span>
        </div>
      ))}
      {warnings.map((msg, i) => (
        <div
          key={`w-${i}`}
          className="text-[12px] text-amber-700 inline-flex items-start gap-1.5"
        >
          <AlertCircle className="w-3.5 h-3.5 mt-0.5" />
          <span>{msg}</span>
        </div>
      ))}
    </div>
  )
}

function parseNum(s: string): number | undefined {
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
