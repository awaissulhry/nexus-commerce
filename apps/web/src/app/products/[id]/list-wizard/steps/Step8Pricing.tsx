'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import ChannelGroupsManager, {
  type ChannelGroup,
} from '../components/ChannelGroupsManager'

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

// AI-6.3 — pricing recommendation shape returned by /suggest-pricing.
interface AiPricingRecommendation {
  platform: string
  marketplace: string
  recommendedPrice: number
  currency: string
  compareAtPrice?: number
  reasoning: string
  marginPercent: number | null
}

export default function Step8Pricing({
  wizardState,
  updateWizardState,
  wizardId,
  channels,
  reportValidity,
  setJumpToBlocker,
}: StepProps) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const baseSlice = (wizardState.pricing ?? {}) as BasePricingSlice
  const channelGroups = (wizardState.channelGroups ?? []) as ChannelGroup[]
  const onChannelGroupsChange = useCallback(
    (next: ChannelGroup[]) => {
      void updateWizardState({ channelGroups: next })
    },
    [updateWizardState],
  )
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
  // AI-6.3 — pricing suggester state. Click "AI: recommend prices"
  // → POST /suggest-pricing with current channel context, get
  // per-channel recommendations + a strategy summary.
  const [aiPricingBusy, setAiPricingBusy] = useState(false)
  const [aiPricingError, setAiPricingError] = useState<string | null>(null)
  const [aiPricingRecs, setAiPricingRecs] = useState<
    AiPricingRecommendation[]
  >([])
  const [aiPricingStrategy, setAiPricingStrategy] = useState<string>('')

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

  // C.0 / A1 — first blocked channel key for the data-attr hook.
  const firstBlockedChannelKey = useMemo(() => {
    for (const [k, v] of Object.entries(issuesByChannel)) {
      if (v.blocking.length > 0) return k
    }
    return null
  }, [issuesByChannel])

  // C.0 / A1 — register jump-to-blocker. Scrolls to the first
  // pricing row with blocking issues.
  useEffect(() => {
    setJumpToBlocker(() => {
      const row = document.querySelector<HTMLElement>(
        '[data-blocker-row="true"]',
      )
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' })
        // Focus the first input inside the row so the user can edit
        // immediately.
        row.querySelector<HTMLInputElement>('input')?.focus({
          preventScroll: true,
        })
        return
      }
      window.scrollTo({ top: 0, behavior: 'smooth' })
    })
    return () => setJumpToBlocker(null)
  }, [setJumpToBlocker])

  const onContinue = useCallback(async () => {
    if (totalBlocking > 0) return
    await updateWizardState({}, { advance: true })
  }, [totalBlocking, updateWizardState])

  // C.0 — report validity from totalBlocking. Warnings (negative
  // margin, price outside repricing band) don't gate. Reasons quote
  // up to 3 channel keys with blocking issues so the disabled-button
  // tooltip stays short.
  useEffect(() => {
    if (loading) {
      reportValidity({
        valid: false,
        blockers: 1,
        reasons: ['Loading pricing context…'],
      })
      return
    }
    if (error) {
      reportValidity({ valid: false, blockers: 1, reasons: [error] })
      return
    }
    if (totalBlocking === 0) {
      reportValidity({ valid: true, blockers: 0 })
      return
    }
    const reasons = Object.entries(issuesByChannel)
      .filter(([, v]) => v.blocking.length > 0)
      .slice(0, 3)
      .map(([ch, v]) => `${ch}: ${v.blocking[0]}`)
    reportValidity({
      valid: false,
      blockers: totalBlocking,
      reasons,
    })
  }, [loading, error, totalBlocking, issuesByChannel, reportValidity])

  if (channels.length === 0) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-6 text-center">
        <p className="text-md text-slate-600 dark:text-slate-400">
          Pick channels in Step 1 first.
        </p>
      </div>
    )
  }

  const askAiToPrice = useCallback(async () => {
    if (!ctx) return
    setAiPricingBusy(true)
    setAiPricingError(null)
    try {
      const channelsPayload = ctx.channels.map((c) => {
        const ovr = overrides[c.channelKey]
        const currentPriceStr = ovr?.marketplacePrice ?? ''
        const currentPrice =
          currentPriceStr !== '' && Number.isFinite(Number(currentPriceStr))
            ? Number(currentPriceStr)
            : undefined
        return {
          platform: c.platform,
          marketplace: c.marketplace,
          currency: c.currency,
          currentPrice,
          referralFee:
            typeof c.defaultFees?.referralPercent === 'number'
              ? c.defaultFees.referralPercent / 100
              : undefined,
          fulfillmentFee:
            typeof c.defaultFees?.fulfillmentFee === 'number'
              ? c.defaultFees.fulfillmentFee
              : undefined,
        }
      })
      // targetMargin is not yet wired through the UI; AI prompt
      // omits it when undefined so reasoning stays strategic only.
      const targetMargin: number | undefined = undefined
      const res = await fetch(
        `${getBackendUrl()}/api/listing-wizard/${wizardId}/suggest-pricing`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channels: channelsPayload,
            costPrice: ctx.product.costPrice ?? undefined,
            minPrice: ctx.product.minPrice ?? undefined,
            targetMargin,
          }),
        },
      )
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
      setAiPricingRecs(
        Array.isArray(json?.recommendations) ? json.recommendations : [],
      )
      setAiPricingStrategy(typeof json?.strategy === 'string' ? json.strategy : '')
    } catch (err) {
      setAiPricingError(err instanceof Error ? err.message : String(err))
      setAiPricingRecs([])
    } finally {
      setAiPricingBusy(false)
    }
    // base.basePrice is read defensively above so don't list it in
    // the deps; aiPricing* are setters, not reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, overrides, wizardId])

  const applyAiPricing = useCallback(
    (rec: AiPricingRecommendation) => {
      const channelKey = `${rec.platform}:${rec.marketplace}`
      setOverrides((prev) => ({
        ...prev,
        [channelKey]: {
          ...(prev[channelKey] ?? {
            marketplacePrice: '',
            minPrice: '',
            maxPrice: '',
            referralPercent: '',
            fulfillmentFee: '',
          }),
          marketplacePrice: rec.recommendedPrice.toFixed(2),
        },
      }))
      toast({
        tone: 'success',
        title: t('listWizard.aiSuggestPricing.applied', {
          channel: channelKey,
          price: rec.recommendedPrice.toFixed(2),
          currency: rec.currency,
        }),
        durationMs: 2400,
      })
    },
    [toast, t],
  )

  const applyAllAiPricing = useCallback(() => {
    if (aiPricingRecs.length === 0) return
    setOverrides((prev) => {
      const next = { ...prev }
      for (const rec of aiPricingRecs) {
        const channelKey = `${rec.platform}:${rec.marketplace}`
        next[channelKey] = {
          ...(next[channelKey] ?? {
            marketplacePrice: '',
            minPrice: '',
            maxPrice: '',
            referralPercent: '',
            fulfillmentFee: '',
          }),
          marketplacePrice: rec.recommendedPrice.toFixed(2),
        }
      }
      return next
    })
    toast({
      tone: 'success',
      title: t('listWizard.aiSuggestPricing.appliedAll', {
        n: aiPricingRecs.length,
      }),
      durationMs: 2400,
    })
  }, [aiPricingRecs, toast, t])

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Pricing</h2>
          <p className="text-md text-slate-600 dark:text-slate-400 mt-1">
            Set a base price; every channel inherits it. Override per
            marketplace when local fees, currency, or competitive pressure
            calls for a different number.
          </p>
        </div>
        {/* AI-6.3 — pricing suggester. Disabled until ctx is loaded
            (no channels to price) or while a call is in flight. */}
        <Button
          variant="secondary"
          size="sm"
          onClick={askAiToPrice}
          disabled={!ctx || aiPricingBusy}
          className="flex-shrink-0 inline-flex items-center gap-1.5"
        >
          {aiPricingBusy ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Sparkles className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
          )}
          {t('listWizard.aiSuggestPricing.button')}
        </Button>
      </div>

      {/* AI-6.3 — recommendations panel. Renders below the title row
          when the operator clicks the button. Strategy summary +
          per-channel rows with Apply CTAs + "Apply all" header. */}
      {(aiPricingRecs.length > 0 || aiPricingError || aiPricingBusy) && (
        <div className="mb-5 border border-purple-200 dark:border-purple-900 bg-purple-50/50 dark:bg-purple-950/20 rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b border-purple-100 dark:border-purple-900 flex items-center justify-between gap-2 bg-purple-50 dark:bg-purple-950/40">
            <div className="text-md font-semibold text-purple-900 dark:text-purple-100 inline-flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              {t('listWizard.aiSuggestPricing.title')}
            </div>
            {aiPricingRecs.length > 0 && (
              <Button
                variant="primary"
                size="sm"
                onClick={applyAllAiPricing}
                className="inline-flex items-center gap-1"
              >
                <Sparkles className="w-3 h-3" />
                {t('listWizard.aiSuggestPricing.applyAll')} ({aiPricingRecs.length})
              </Button>
            )}
          </div>
          <div className="px-4 py-3 space-y-2">
            {aiPricingBusy && (
              <div className="flex items-center gap-2 text-base text-purple-700 dark:text-purple-300">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('listWizard.aiSuggestPricing.busy')}
              </div>
            )}
            {aiPricingError && !aiPricingBusy && (
              <div className="flex items-start gap-2 text-base text-rose-700 dark:text-rose-300">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-medium">
                    {t('listWizard.aiSuggestPricing.error')}
                  </div>
                  <div className="text-sm opacity-90 mt-0.5">{aiPricingError}</div>
                </div>
              </div>
            )}
            {!aiPricingBusy && !aiPricingError && aiPricingStrategy && (
              <p className="text-sm text-slate-600 dark:text-slate-400 italic">
                {aiPricingStrategy}
              </p>
            )}
            {!aiPricingBusy && !aiPricingError && aiPricingRecs.length > 0 && (
              <ul className="space-y-1.5">
                {aiPricingRecs.map((rec) => {
                  const channelKey = `${rec.platform}:${rec.marketplace}`
                  const currentPrice =
                    overrides[channelKey]?.marketplacePrice ?? ''
                  const alreadyApplied =
                    currentPrice !== '' &&
                    Math.abs(Number(currentPrice) - rec.recommendedPrice) <
                      0.01
                  return (
                    <li
                      key={channelKey}
                      className="flex items-start justify-between gap-3 py-1.5 px-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-sm font-medium text-slate-900 dark:text-slate-100">
                            {channelKey}
                          </span>
                          <span className="text-md font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                            {rec.recommendedPrice.toFixed(2)} {rec.currency}
                          </span>
                          {rec.compareAtPrice !== undefined && (
                            <span className="text-sm text-slate-500 dark:text-slate-400 tabular-nums line-through">
                              {rec.compareAtPrice.toFixed(2)} {rec.currency}
                            </span>
                          )}
                          {rec.marginPercent !== null && (
                            <span
                              className={cn(
                                'text-xs font-medium tabular-nums px-1.5 py-0.5 rounded border',
                                rec.marginPercent >= 30
                                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900'
                                  : rec.marginPercent >= 0
                                    ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900'
                                    : 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900',
                              )}
                            >
                              {rec.marginPercent.toFixed(1)}% margin
                            </span>
                          )}
                          {alreadyApplied && (
                            <span className="inline-flex items-center gap-0.5 text-xs text-emerald-700 dark:text-emerald-400">
                              <CheckCircle2 className="w-3 h-3" />
                              applied
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 leading-snug">
                          {rec.reasoning}
                        </p>
                      </div>
                      <div className="flex-shrink-0">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => applyAiPricing(rec)}
                          disabled={alreadyApplied}
                        >
                          {t('listWizard.aiSuggestPricing.applyButton')}
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      {loading && (
        <div
          className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 px-6 py-6 space-y-3"
          aria-busy="true"
          aria-label="Loading pricing context"
        >
          <Skeleton variant="text" lines={2} />
          <Skeleton variant="block" height={56} />
          <Skeleton variant="block" height={56} />
        </div>
      )}

      {error && !loading && (
        <div className="border border-rose-200 dark:border-rose-900 rounded-lg bg-rose-50 dark:bg-rose-950/40 px-4 py-3 text-md text-rose-700 dark:text-rose-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {ctx && !loading && (
        <>
          {/* Base pricing */}
          <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 px-4 py-3 mb-4">
            <div className="text-base font-medium text-slate-700 dark:text-slate-300 mb-2">
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
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
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

          {/* K.6 — channel groups manager (manual, shared with Step 8) */}
          <div className="mb-3">
            <ChannelGroupsManager
              groups={channelGroups}
              availableChannels={channels}
              onChange={onChannelGroupsChange}
              defaultCollapsed
            />
          </div>

          {/* K.6 — per-group bulk price actions */}
          {channelGroups.filter((g) => g.channelKeys.length > 0).length >
            0 && (
            <GroupBulkActions
              channelGroups={channelGroups.filter(
                (g) => g.channelKeys.length > 0,
              )}
              onApply={(groupId, value) => {
                const cg = channelGroups.find((g) => g.id === groupId)
                if (!cg || !Number.isFinite(value)) return
                setOverrides((prev) => {
                  const next = { ...prev }
                  for (const chKey of cg.channelKeys) {
                    next[chKey] = {
                      ...(next[chKey] ?? {
                        marketplacePrice: '',
                        minPrice: '',
                        maxPrice: '',
                        referralPercent: '',
                        fulfillmentFee: '',
                      }),
                      marketplacePrice: String(value),
                    }
                  }
                  return next
                })
              }}
            />
          )}

          {/* Per-channel override grid */}
          <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700 text-base font-medium text-slate-700 dark:text-slate-300">
              Per-channel overrides &amp; margins
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-base">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
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
                        ? 'text-rose-700 dark:text-rose-300'
                        : r.netMargin > 0
                        ? 'text-emerald-700 dark:text-emerald-300'
                        : 'text-slate-600 dark:text-slate-400'
                    const MarginIcon =
                      r.netMargin < 0
                        ? TrendingDown
                        : r.netMargin > 0
                        ? TrendingUp
                        : null
                    const isFirstBlocked =
                      c.channelKey === firstBlockedChannelKey
                    return (
                      <tr
                        key={c.channelKey}
                        data-blocker-row={
                          isFirstBlocked ? 'true' : undefined
                        }
                        className={cn(
                          'border-t border-slate-100 dark:border-slate-800 scroll-mt-24',
                          tone,
                        )}
                      >
                        <td className="px-3 py-2">
                          <div className="font-mono text-sm text-slate-700 dark:text-slate-300 font-medium">
                            {c.channelKey}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {c.currency}{' '}
                            {r.inheritsBase && (
                              <span className="ml-1 text-slate-400 dark:text-slate-500 italic">
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
                          <div className="text-xs text-slate-500 dark:text-slate-400">
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
                  <div key={chKey} className="text-sm">
                    {v.blocking.map((m, i) => (
                      <div
                        key={`b-${i}`}
                        className="text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5"
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
                        className="text-amber-700 dark:text-amber-300 inline-flex items-start gap-1.5"
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
            <div className="text-base">
              {totalBlocking === 0 ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Pricing satisfied across every channel.
                </span>
              ) : (
                <span className="text-rose-700 dark:text-rose-300">
                  {totalBlocking} blocking pricing issue
                  {totalBlocking === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={onContinue}
              disabled={totalBlocking > 0}
            >
              Continue
            </Button>
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
      <label className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-0.5">
        {label}
      </label>
      <input
        type="number"
        step="0.01"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-8 px-2 text-md border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
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
      className="w-20 h-7 px-1.5 text-base border border-slate-200 dark:border-slate-700 rounded text-right tabular-nums focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 placeholder:text-slate-300"
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

function GroupBulkActions({
  channelGroups,
  onApply,
}: {
  channelGroups: ChannelGroup[]
  onApply: (groupId: string, value: number) => void
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 px-3 py-2 mb-3">
      <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
        Set price per channel group (bulk)
      </div>
      <div className="space-y-1.5">
        {channelGroups.map((g) => (
          <div
            key={g.id}
            className="flex items-center gap-2 text-base"
          >
            <span className="font-medium text-slate-700 dark:text-slate-300 flex-shrink-0 w-32 truncate">
              {g.name}
            </span>
            <span className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate flex-1 min-w-0">
              {g.channelKeys.join(', ')}
            </span>
            <input
              type="number"
              step="0.01"
              value={drafts[g.id] ?? ''}
              onChange={(e) =>
                setDrafts((prev) => ({ ...prev, [g.id]: e.target.value }))
              }
              placeholder="price"
              className="w-24 h-7 px-1.5 text-base border border-slate-200 dark:border-slate-700 rounded text-right tabular-nums focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 placeholder:text-slate-300"
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                const raw = drafts[g.id]
                if (!raw) return
                const n = Number(raw)
                if (!Number.isFinite(n)) return
                onApply(g.id, n)
                setDrafts((prev) => {
                  const next = { ...prev }
                  delete next[g.id]
                  return next
                })
              }}
              disabled={!drafts[g.id]}
            >
              Apply
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}
