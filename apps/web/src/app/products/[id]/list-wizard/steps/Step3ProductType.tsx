'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'
import { Button } from '@/components/ui/Button'
import Step2GtinExemption from './Step2GtinExemption'

// ── GTIN types (mirrored from Step1Identifiers) ───────────────────
type GtinPath = 'have-code' | 'have-exemption' | 'apply-now'

interface IdentifiersSlice {
  path?: GtinPath
  gtinValue?: string
  trademarkNumber?: string
  exemptionApplicationId?: string
}

interface ExemptCheckResponse {
  approved?: { id: string; brandName: string; approvedAt: string | null }
  pending?: { id: string; brandName: string; submittedAt: string | null; status: string }
  amazonInference?: { inferred: 'exempt' | 'not_exempt' | 'unknown'; evidenceSku?: string; evidenceAsin?: string; reason: string }
}

interface ProductTypeListItem {
  productType: string
  displayName: string
  bundled: boolean
}

interface RankedSuggestion {
  productType: string
  displayName: string
  confidence: number
  reason: string
}

interface SuggestResult {
  suggestions: RankedSuggestion[]
  source: 'gemini' | 'rule-based'
  ruleBasedFallback: boolean
}

interface ProductTypeSlice {
  productType?: string
  displayName?: string
  source?: 'ai' | 'manual' | 'mirror'
  /** When source==='mirror', the channel key we're copying from. */
  mirrorOf?: string
  selectedAt?: string
  aiSuggestions?: RankedSuggestion[]
  /** P.3 — Amazon browse-node IDs for this channel. Per-marketplace
   *  IDs differ even within the same physical category (Amazon DE
   *  uses different node IDs than Amazon IT for the same shelf).
   *  Stored here so the "Same as" mirror copies them along with the
   *  productType, and the Step 5 Attributes step sees them via the
   *  curated common-optional `recommended_browse_nodes` field. */
  browseNodes?: string[]
}

const LIST_DEBOUNCE_MS = 200

export default function Step3ProductType({
  wizardId,
  wizardState,
  updateWizardState,
  channels,
  product,
  marketplace,
  ...restProps
}: StepProps) {
  // Phase K.1: every Amazon channel gets its own picker. Non-Amazon
  // channels don't have a productType taxonomy (yet), so they're
  // surfaced as "skipped" rows.
  const channelStates = (wizardState.channelStates ?? {}) as Record<
    string,
    Record<string, any>
  >
  const legacyShared = (wizardState.productType ?? {}) as ProductTypeSlice

  // Build initial picks from channelStates → fall back to the legacy
  // shared slot for backwards compat with Phase B-D wizards that wrote
  // a single shared productType.
  // FF — pickable platforms have a real taxonomy backend. Amazon uses
  // list-once-filter-client; eBay uses search-as-you-type via the
  // Taxonomy API. Other platforms (Shopify, Woo) are still skipped.
  const isPickable = (platform: string) =>
    platform === 'AMAZON' || platform === 'EBAY'

  const initialPicks = useMemo(() => {
    const m: Record<string, ProductTypeSlice> = {}
    for (const c of channels) {
      const key = `${c.platform}:${c.marketplace}`
      const slice = channelStates[key]?.productType as
        | ProductTypeSlice
        | undefined
      if (slice && slice.productType) {
        m[key] = slice
      } else if (
        c.platform === 'AMAZON' &&
        legacyShared.productType
      ) {
        m[key] = { ...legacyShared, source: 'manual' }
      }
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [picks, setPicks] = useState<Record<string, ProductTypeSlice>>(
    initialPicks,
  )
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Auto-expand any pickable channel that doesn't have a pick yet.
    const set = new Set<string>()
    for (const c of channels) {
      const key = `${c.platform}:${c.marketplace}`
      if (!isPickable(c.platform)) continue
      if (!initialPicks[key]?.productType) set.add(key)
    }
    // If everyone already has a pick, expand the first pickable one.
    if (set.size === 0) {
      const firstPickable = channels.find((c) => isPickable(c.platform))
      if (firstPickable) {
        set.add(`${firstPickable.platform}:${firstPickable.marketplace}`)
      }
    }
    return set
  })

  // ── GTIN / Identifiers state (merged from the former Step 3) ────
  const hasAmazon = channels.some((c) => c.platform === 'AMAZON')
  const firstAmazonMarketplace =
    channels.find((c) => c.platform === 'AMAZON')?.marketplace ?? marketplace
  const existingGtin =
    product.gtin || product.upc || product.ean || null
  const idSlice = (wizardState.identifiers ?? {}) as IdentifiersSlice

  const [gtinPath, setGtinPath] = useState<GtinPath>(
    idSlice.path ?? (existingGtin ? 'have-code' : 'apply-now'),
  )
  const [gtinValue, setGtinValue] = useState(
    idSlice.gtinValue ?? existingGtin ?? '',
  )
  const [trademarkNumber, setTrademarkNumber] = useState(
    idSlice.trademarkNumber ?? '',
  )
  const [exemptCache, setExemptCache] = useState<ExemptCheckResponse | null>(null)
  const [exemptLoading, setExemptLoading] = useState(false)

  useEffect(() => {
    if (!hasAmazon || !product.brand) return
    setExemptLoading(true)
    let cancelled = false
    const url = new URL(`${getBackendUrl()}/api/gtin-exemption/check`)
    url.searchParams.set('brand', product.brand)
    url.searchParams.set('marketplace', firstAmazonMarketplace)
    fetch(url.toString(), { cache: 'no-store' })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((data: ExemptCheckResponse | null) => {
        if (cancelled || !data) return
        setExemptCache(data)
        if (idSlice.path) return // user already chose a path
        if (data.approved) setGtinPath('have-exemption')
        else if (data.amazonInference?.inferred === 'exempt') setGtinPath('have-exemption')
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setExemptLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.brand, firstAmazonMarketplace])

  const handleGtinPathChange = useCallback(
    (newPath: GtinPath) => {
      setGtinPath(newPath)
      // Save path immediately so Step2GtinExemption (apply-now) can read it.
      void updateWizardState({ identifiers: { ...idSlice, path: newPath } })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [updateWizardState],
  )

  const gtinDigits = gtinValue.replace(/\D/g, '')
  const gtinValid = gtinDigits.length >= 8 && gtinDigits.length <= 14
  const amazonInferredExempt = exemptCache?.amazonInference?.inferred === 'exempt'

  const gtinContinueDisabled =
    hasAmazon &&
    ((gtinPath === 'have-code' && !gtinValid) ||
      (gtinPath === 'have-exemption' &&
        !exemptCache?.approved &&
        !amazonInferredExempt &&
        !trademarkNumber))

  // ── Persist per-channel pick to channelStates[key].productType ──
  const persistPick = useCallback(
    async (channelKey: string, slice: ProductTypeSlice) => {
      const channelStatesPatch: Record<string, Record<string, unknown>> = {
        [channelKey]: { productType: slice },
      }
      await fetch(`${getBackendUrl()}/api/listing-wizard/${wizardId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelStates: channelStatesPatch }),
      }).catch(() => {})
    },
    [wizardId],
  )

  const setPick = useCallback(
    (channelKey: string, slice: ProductTypeSlice) => {
      setPicks((prev) => ({ ...prev, [channelKey]: slice }))
      void persistPick(channelKey, slice)
    },
    [persistPick],
  )

  // P.1 — per-channel GTIN status. Re-fetches whenever any pick
  // changes so the user sees the live exemption status (auto-covered
  // / in-progress / needed) right next to each channel's category
  // pick. We wait one tick after the persist so the server-side
  // resolution sees the new productType.
  const [gtinStatusByChannel, setGtinStatusByChannel] = useState<
    Record<
      string,
      {
        needed: boolean
        reason:
          | 'has_gtin'
          | 'existing_exemption'
          | 'in_progress'
          | 'needed'
          | 'no_product_type'
        applicationId?: string
        status?: string
      }
    >
  >({})
  useEffect(() => {
    // Only Amazon channels have GTIN exemption concept.
    const hasAmazon = channels.some((c) => c.platform === 'AMAZON')
    if (!hasAmazon) {
      setGtinStatusByChannel({})
      return
    }
    let cancelled = false
    // 250ms debounce so rapid pick changes coalesce into one fetch.
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/listing-wizard/${wizardId}/gtin-status`,
        )
        if (!res.ok) return
        const json = await res.json()
        if (cancelled) return
        if (json && typeof json === 'object' && json.perChannel) {
          setGtinStatusByChannel(json.perChannel)
        }
      } catch {
        /* swallow — UI just shows no banner */
      }
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [picks, channels, wizardId])

  const toggleExpanded = useCallback((channelKey: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(channelKey)) next.delete(channelKey)
      else next.add(channelKey)
      return next
    })
  }, [])

  // ── Continue gating: every pickable channel needs a pick ──────
  const pickableChannelKeys = useMemo(
    () =>
      channels
        .filter((c) => isPickable(c.platform))
        .map((c) => `${c.platform}:${c.marketplace}`),
    [channels],
  )
  // Mirror still only makes sense within the same channel — copying
  // an Amazon productType id into an eBay categoryId field would be
  // garbage. Keep mirror candidates per-channel.
  const mirrorCandidatesByKey = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const k of pickableChannelKeys) {
      const [platform] = k.split(':')
      m[k] = pickableChannelKeys.filter((other) => {
        if (other === k) return false
        if (!other.startsWith(`${platform}:`)) return false
        return picks[other]?.productType && picks[other]!.productType!.length > 0
      })
    }
    return m
  }, [pickableChannelKeys, picks])
  const unsatisfied = useMemo(() => {
    return pickableChannelKeys.filter(
      (k) => !picks[k]?.productType || picks[k]!.productType!.length === 0,
    )
  }, [pickableChannelKeys, picks])

  const onContinue = useCallback(async () => {
    if (unsatisfied.length > 0) return
    if (gtinContinueDisabled) return
    const identifiers: IdentifiersSlice = hasAmazon
      ? {
          path: gtinPath,
          gtinValue: gtinPath === 'have-code' ? gtinValue : undefined,
          trademarkNumber:
            gtinPath === 'have-exemption' ? trademarkNumber : undefined,
          exemptionApplicationId: exemptCache?.approved?.id,
        }
      : { path: 'have-code', gtinValue: existingGtin ?? '' }
    await updateWizardState({ identifiers }, { advance: true })
  }, [
    unsatisfied.length,
    gtinContinueDisabled,
    hasAmazon,
    gtinPath,
    gtinValue,
    trademarkNumber,
    exemptCache,
    existingGtin,
    updateWizardState,
  ])

  if (channels.length === 0) {
    return (
      <div className="max-w-2xl mx-auto py-6 md:py-12 px-3 md:px-6 text-center">
        <p className="text-md text-slate-600 dark:text-slate-400">
          Pick channels in Step 1 first.
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto py-4 md:py-10 px-3 md:px-6">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Product Type
        </h2>
        <p className="text-md text-slate-600 dark:text-slate-400 mt-1">
          Pick a category per channel. Amazon uses its productType
          taxonomy; eBay uses its category tree (search by name).
          The "Same as" dropdown mirrors a sibling channel's pick
          within the same platform.
        </p>
      </div>

      <div className="space-y-2">
        {channels.map((c) => {
          const channelKey = `${c.platform}:${c.marketplace}`
          const pick = picks[channelKey]
          if (!isPickable(c.platform)) {
            return (
              <NonPickableRow
                key={channelKey}
                channelKey={channelKey}
                platform={c.platform}
              />
            )
          }
          return (
            <ChannelRow
              key={channelKey}
              channelKey={channelKey}
              platform={c.platform}
              marketplace={c.marketplace}
              pick={pick}
              gtinStatus={gtinStatusByChannel[channelKey]}
              expanded={expanded.has(channelKey)}
              onToggle={() => toggleExpanded(channelKey)}
              onPick={(slice) => setPick(channelKey, slice)}
              onMirror={(sourceKey) => {
                const src = picks[sourceKey]
                if (!src?.productType) return
                setPick(channelKey, {
                  productType: src.productType,
                  displayName: src.displayName ?? src.productType,
                  source: 'mirror',
                  mirrorOf: sourceKey,
                  selectedAt: new Date().toISOString(),
                })
              }}
              wizardId={wizardId}
              mirrorCandidates={mirrorCandidatesByKey[channelKey] ?? []}
              mirrorPicks={picks}
              productName={product.name}
            />
          )
        })}
      </div>

      {/* GTIN / Identifiers — merged from the former Step 3 */}
      {hasAmazon && (
        <div className="mt-6 pt-5 border-t border-slate-100 dark:border-slate-800">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-0.5">
            Product Identifiers
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
            Amazon requires a UPC / EAN / GTIN or brand exemption certificate.
          </p>

          {/* Exemption / inference banners */}
          {exemptLoading && (
            <div className="mb-3 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Checking brand exemption status…
            </div>
          )}
          {exemptCache?.approved && (
            <div className="mb-3 px-3 py-2.5 rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-sm text-emerald-900 dark:text-emerald-200 flex items-start gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
              <div>
                <span className="font-semibold">"{product.brand}"</span> has an approved GTIN
                exemption on Amazon {firstAmazonMarketplace}. Pre-selected below.
              </div>
            </div>
          )}
          {exemptCache?.amazonInference?.inferred === 'exempt' &&
            !exemptCache.approved &&
            !exemptCache.pending && (
              <div className="mb-3 px-3 py-2.5 rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-sm text-emerald-900 dark:text-emerald-200 flex items-start gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
                <div>
                  Amazon shows <span className="font-semibold">"{product.brand}"</span> already
                  sells GTIN-free — exemption inferred from existing listings.
                </div>
              </div>
            )}

          {/* 3-path radio options */}
          <div className="space-y-2">
            <GtinOption
              checked={gtinPath === 'have-code'}
              onChange={() => handleGtinPathChange('have-code')}
              label="I have a UPC / EAN / GTIN for this product"
            >
              <div className="flex items-center gap-2 mt-2">
                <input
                  value={gtinValue}
                  onChange={(e) => setGtinValue(e.target.value)}
                  placeholder="e.g. 1234567890123"
                  className="flex-1 h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
                {gtinValue.trim().length > 0 && (
                  <span
                    className={cn(
                      'text-xs',
                      gtinValid
                        ? 'text-emerald-700 dark:text-emerald-300'
                        : 'text-amber-700 dark:text-amber-300',
                    )}
                  >
                    {gtinValid ? '✓ valid' : '8–14 digits'}
                  </span>
                )}
              </div>
            </GtinOption>

            <GtinOption
              checked={gtinPath === 'have-exemption'}
              onChange={() => handleGtinPathChange('have-exemption')}
              label="My brand already has GTIN exemption on Amazon"
            >
              <div className="space-y-2 mt-2">
                <div className="text-sm text-slate-600 dark:text-slate-400">
                  Brand:{' '}
                  <span className="font-mono bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded">
                    {product.brand ?? '(no brand set)'}
                  </span>
                </div>
                <input
                  value={trademarkNumber}
                  onChange={(e) => setTrademarkNumber(e.target.value)}
                  placeholder="Trademark number (optional, e.g. EU 018937481)"
                  className="w-full h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
                {!exemptCache?.approved && !amazonInferredExempt && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    No approved exemption on record — pick "Apply now" if you
                    need to apply.
                  </p>
                )}
              </div>
            </GtinOption>

            <GtinOption
              checked={gtinPath === 'apply-now'}
              onChange={() => handleGtinPathChange('apply-now')}
              label="I need to apply for a GTIN exemption"
            >
              <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                We generate the brand letter PDF and submission package — fill
                in the form below.
              </p>
            </GtinOption>
          </div>

          {/* Embedded exemption application form (apply-now path) */}
          {gtinPath === 'apply-now' && (
            <div className="mt-3 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 px-4 py-4">
              <Step2GtinExemption
                wizardId={wizardId}
                wizardState={wizardState}
                updateWizardState={updateWizardState}
                product={product}
                channels={channels}
                updateWizardChannels={restProps.updateWizardChannels}
                channel={restProps.channel}
                marketplace={marketplace}
                onJumpToStep={restProps.onJumpToStep}
                reportValidity={restProps.reportValidity}
                setJumpToBlocker={restProps.setJumpToBlocker}
                embedded
              />
            </div>
          )}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between gap-3">
        <span className="text-base">
          {unsatisfied.length === 0 && !gtinContinueDisabled ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Ready to continue.
            </span>
          ) : unsatisfied.length > 0 ? (
            <span className="text-amber-700 dark:text-amber-300">
              {unsatisfied.length} channel
              {unsatisfied.length === 1 ? '' : 's'} still need a category
            </span>
          ) : (
            <span className="text-amber-700 dark:text-amber-300">
              Fill in the identifier above to continue
            </span>
          )}
        </span>
        <Button
          variant="primary"
          size="sm"
          onClick={onContinue}
          disabled={unsatisfied.length > 0 || gtinContinueDisabled}
        >
          Continue
        </Button>
      </div>
    </div>
  )
}

// P.1 — GTIN status banner shown inline on the Categories step
// once a productType has been picked for an Amazon channel.
function GtinStatusBanner({
  status,
}: {
  status: {
    needed: boolean
    reason:
      | 'has_gtin'
      | 'existing_exemption'
      | 'in_progress'
      | 'needed'
      | 'no_product_type'
    applicationId?: string
    status?: string
  }
}) {
  const tone = !status.needed
    ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800'
    : status.reason === 'in_progress'
    ? 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-amber-800'
    : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
  const headline = (() => {
    switch (status.reason) {
      case 'has_gtin':
        return 'GTIN already on the product — no exemption needed'
      case 'existing_exemption':
        return 'Brand has an approved exemption for this category'
      case 'in_progress':
        return `Existing exemption application is ${(status.status ?? 'in progress').toLowerCase()}`
      case 'no_product_type':
        return 'Pick a product type before checking GTIN status'
      default:
        return 'GTIN exemption needed — fill in below'
    }
  })()
  return (
    <div
      className={cn(
        'border-t px-4 py-2 text-sm inline-flex items-start gap-1.5 w-full',
        tone,
      )}
    >
      {!status.needed ? (
        <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
      ) : (
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
      )}
      <span>{headline}</span>
    </div>
  )
}

// ── Non-pickable row: Shopify / WooCommerce don't use a category id
// the same way Amazon / eBay do. We surface them as skipped.

function NonPickableRow({
  channelKey,
  platform,
}: {
  channelKey: string
  platform: string
}) {
  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-slate-50/50 px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500 font-medium">
          Skipped
        </span>
        <span className="font-mono text-base text-slate-600 dark:text-slate-400 truncate">
          {channelKey}
        </span>
      </div>
      <span className="text-sm text-slate-500 dark:text-slate-400">
        {platform} doesn't use a productType — handled by tags/collections at submit.
      </span>
    </div>
  )
}

// ── Per-channel picker ──────────────────────────────────────────

function ChannelRow({
  channelKey,
  platform,
  marketplace,
  pick,
  gtinStatus,
  expanded,
  onToggle,
  onPick,
  onMirror,
  wizardId,
  mirrorCandidates,
  mirrorPicks,
  productName,
}: {
  channelKey: string
  platform: string
  marketplace: string
  pick?: ProductTypeSlice
  gtinStatus?: {
    needed: boolean
    reason:
      | 'has_gtin'
      | 'existing_exemption'
      | 'in_progress'
      | 'needed'
      | 'no_product_type'
    applicationId?: string
    status?: string
  }
  expanded: boolean
  onToggle: () => void
  onPick: (slice: ProductTypeSlice) => void
  onMirror: (sourceChannelKey: string) => void
  wizardId: string
  mirrorCandidates: string[]
  mirrorPicks: Record<string, ProductTypeSlice>
  productName: string
}) {
  const hasPick = !!pick?.productType

  return (
    <div
      className={cn(
        'border rounded-lg bg-white dark:bg-slate-900',
        hasPick ? 'border-slate-200 dark:border-slate-700' : 'border-amber-200 dark:border-amber-900 bg-amber-50/30',
      )}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-2 min-w-0 text-left"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
          )}
          {hasPick ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          )}
          <div className="min-w-0">
            <div className="font-mono text-md text-slate-900 dark:text-slate-100 font-medium truncate">
              {channelKey}
            </div>
            {hasPick ? (
              <div className="text-sm text-slate-500 dark:text-slate-400 truncate">
                {pick.displayName ?? pick.productType}{' '}
                <span className="text-slate-400 dark:text-slate-500">
                  · {pick.productType}
                </span>
                {pick.source === 'mirror' && pick.mirrorOf && (
                  <span className="ml-1 text-xs uppercase tracking-wide text-blue-700 dark:text-blue-300">
                    · mirrors {pick.mirrorOf}
                  </span>
                )}
              </div>
            ) : (
              <div className="text-sm text-amber-700 dark:text-amber-300">
                No product type picked
              </div>
            )}
          </div>
        </button>
        {mirrorCandidates.length > 0 && (
          <MirrorMenu
            candidates={mirrorCandidates}
            picks={mirrorPicks}
            onMirror={onMirror}
          />
        )}
      </div>

      {/* P.1 — GTIN status banner. Renders only for Amazon channels
          with a productType picked, since GTIN exemption is Amazon-
          only and category-aware (post-K.7). */}
      {hasPick && gtinStatus && (
        <GtinStatusBanner status={gtinStatus} />
      )}

      {expanded && (
        <div className="border-t border-slate-100 dark:border-slate-800">
          <Picker
            wizardId={wizardId}
            channel={platform}
            marketplace={marketplace}
            currentPick={pick}
            onPick={onPick}
            productName={productName}
          />
        </div>
      )}
    </div>
  )
}

function MirrorMenu({
  candidates,
  picks,
  onMirror,
}: {
  candidates: string[]
  picks: Record<string, ProductTypeSlice>
  onMirror: (sourceKey: string) => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // C.2 — replaces the prior `fixed inset-0` click-trap (audit
  // flagged it as "hand-rolled modal" but it was actually a
  // dropdown click-outside; the inset-0 trap blocked clicks on
  // the entire viewport including unrelated chrome). Document
  // mousedown is the canonical click-outside pattern; Escape
  // dismiss + click-outside dismiss without intercepting other UI.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('touchstart', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('touchstart', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative flex-shrink-0" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        <Copy className="w-3 h-3" />
        Same as ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-20 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded shadow-md py-1 min-w-[200px]"
        >
          {candidates.map((c) => {
            const p = picks[c]
            return (
              <button
                key={c}
                type="button"
                role="menuitem"
                onClick={() => {
                  onMirror(c)
                  setOpen(false)
                }}
                className="w-full text-left px-3 py-1.5 text-base hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <div className="font-mono text-slate-700 dark:text-slate-300">{c}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                  {p?.productType}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── The actual search + AI picker (per channel) ────────────────

function Picker({
  wizardId,
  channel,
  marketplace,
  currentPick,
  onPick,
  productName,
}: {
  wizardId: string
  channel: string
  marketplace: string
  currentPick?: ProductTypeSlice
  onPick: (slice: ProductTypeSlice) => void
  productName: string
}) {
  const isEbay = channel === 'EBAY'
  // FF — eBay's API is search-as-you-type, so an empty list on first
  // open looks broken. Pre-seed the box with the product name (first
  // 4 words is plenty — eBay ranks by phrase match) so the user gets
  // an instant ranked list of candidates. Amazon has the full list
  // cached so it gets a blank search by design.
  const initialSearch = isEbay ? extractSearchSeed(productName) : ''
  const [search, setSearch] = useState(initialSearch)
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch)
  const [items, setItems] = useState<ProductTypeListItem[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [listErrorCode, setListErrorCode] = useState<
    'auth_missing' | 'auth_failed' | 'upstream' | 'unknown' | null
  >(null)
  const [suggestions, setSuggestions] = useState<RankedSuggestion[]>(
    currentPick?.aiSuggestions ?? [],
  )
  const [suggestSource, setSuggestSource] = useState<
    'gemini' | 'rule-based' | null
  >(null)
  const [suggestFallback, setSuggestFallback] = useState(false)
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestError, setSuggestError] = useState<string | null>(null)
  const [activeIdx, setActiveIdx] = useState<number>(-1)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), LIST_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    let cancelled = false
    setListLoading(true)
    setListError(null)
    setListErrorCode(null)
    const url = new URL(
      `${getBackendUrl()}/api/listing-wizard/product-types`,
    )
    url.searchParams.set('channel', channel)
    if (marketplace) url.searchParams.set('marketplace', marketplace)
    if (debouncedSearch) url.searchParams.set('search', debouncedSearch)
    fetch(url.toString())
      .then(async (r) => {
        const text = await r.text()
        let parsed: unknown = null
        try {
          parsed = text ? JSON.parse(text) : null
        } catch {
          /* non-JSON */
        }
        return { status: r.status, ok: r.ok, body: parsed }
      })
      .then(({ ok, status, body }) => {
        if (cancelled) return
        const data = body as
          | {
              items?: ProductTypeListItem[]
              error?: string
              code?:
                | 'auth_missing'
                | 'auth_failed'
                | 'upstream'
                | 'unknown'
            }
          | null
        if (ok && Array.isArray(data?.items)) {
          setItems(data.items)
          return
        }
        setItems([])
        setListError(
          data?.error ?? `Failed to load product types (HTTP ${status})`,
        )
        setListErrorCode(data?.code ?? 'unknown')
      })
      .catch((err) => {
        if (cancelled) return
        setListError(err instanceof Error ? err.message : String(err))
        setListErrorCode('unknown')
      })
      .finally(() => {
        if (!cancelled) setListLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [channel, marketplace, debouncedSearch])

  const fetchSuggestions = useCallback(async () => {
    if (items.length === 0) return
    setSuggestLoading(true)
    setSuggestError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listing-wizard/${wizardId}/suggest-product-types`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ candidates: items }),
        },
      )
      const data = (await res.json()) as SuggestResult & { error?: string }
      if (!res.ok) {
        setSuggestError(data?.error ?? `HTTP ${res.status}`)
        return
      }
      setSuggestions(data.suggestions)
      setSuggestSource(data.source)
      setSuggestFallback(data.ruleBasedFallback)
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : String(err))
    } finally {
      setSuggestLoading(false)
    }
  }, [items, wizardId])

  const handleSelect = useCallback(
    (
      item: { productType: string; displayName: string },
      source: 'ai' | 'manual',
    ) => {
      onPick({
        productType: item.productType,
        displayName: item.displayName,
        source,
        selectedAt: new Date().toISOString(),
        aiSuggestions: suggestions.length > 0 ? suggestions : undefined,
      })
      // Fire-and-forget prefetch so attribute step lands fast.
      void fetch(
        `${getBackendUrl()}/api/listing-wizard/${wizardId}/prefetch-schema`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productType: item.productType }),
        },
      ).catch(() => {})
    },
    [onPick, suggestions, wizardId],
  )

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault()
      const it = items[activeIdx]
      if (it) handleSelect(it, 'manual')
    }
  }

  return (
    <div className="px-4 py-3 space-y-3">
      {/* FF — eBay's search-as-you-type IS the suggestion surface
          (results come back ranked by matchPercentage), so the
          generic AI Suggestions panel adds noise rather than value.
          Amazon keeps the panel because its taxonomy is large and
          flat — AI ranking is a real shortcut over scrolling. */}
      {!isEbay && (
        <SuggestionsPanel
          suggestions={suggestions}
          source={suggestSource}
          ruleBasedFallback={suggestFallback}
          loading={suggestLoading}
          error={suggestError}
          onFetch={fetchSuggestions}
          onSelect={(s) =>
            handleSelect(
              { productType: s.productType, displayName: s.displayName },
              'ai',
            )
          }
          selectedProductType={currentPick?.productType ?? null}
        />
      )}

      <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-700">
          <Search className="w-4 h-4 text-slate-400 dark:text-slate-500" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setActiveIdx(-1)
            }}
            onKeyDown={onListKeyDown}
            placeholder="Search categories — e.g. jacket, helmet, gloves"
            className="flex-1 h-7 text-md focus:outline-none bg-transparent"
          />
          {listLoading && (
            <Loader2 className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 animate-spin" />
          )}
        </div>
        <div
          className="max-h-[280px] overflow-y-auto"
          tabIndex={0}
          onKeyDown={onListKeyDown}
        >
          {listError && (
            <ListErrorBanner
              code={listErrorCode}
              message={listError}
              channel={channel}
            />
          )}
          {!listError && !listLoading && items.length === 0 && (
            <div className="px-3 py-6 text-base text-slate-500 dark:text-slate-400 text-center">
              {channel === 'EBAY' && search.trim().length < 2
                ? 'Type at least 2 characters to search eBay categories.'
                : 'No matches.'}
            </div>
          )}
          {items.map((item, idx) => {
            const isSelected =
              currentPick?.productType === item.productType
            const isActive = activeIdx === idx
            return (
              <button
                key={item.productType}
                type="button"
                onClick={() => handleSelect(item, 'manual')}
                onMouseEnter={() => setActiveIdx(idx)}
                className={cn(
                  'w-full text-left px-3 py-2 flex items-center gap-3 border-b border-slate-100 dark:border-slate-800 last:border-b-0 transition-colors',
                  isActive && !isSelected && 'bg-slate-50 dark:bg-slate-800',
                  isSelected && 'bg-blue-50 dark:bg-blue-950/40',
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-md text-slate-900 dark:text-slate-100 truncate">
                    {item.displayName}
                  </div>
                  <div className="text-sm font-mono text-slate-500 dark:text-slate-400 truncate">
                    {item.productType}
                  </div>
                </div>
                {item.bundled && (
                  <span
                    className="text-xs text-slate-400 dark:text-slate-500"
                    title="From bundled fallback list — connect Amazon SP-API for live results"
                  >
                    bundled
                  </span>
                )}
                {isSelected && (
                  <CheckCircle2 className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* P.3 — Browse-node input. Amazon-only; eBay's category-id IS
          the leaf node, no separate browse-node taxonomy. */}
      {currentPick?.productType && channel === 'AMAZON' && (
        <BrowseNodeInput
          value={currentPick?.browseNodes ?? []}
          onChange={(next) => {
            // Update slice in place — keep all current fields,
            // overwrite browseNodes only.
            onPick({
              ...(currentPick ?? {}),
              productType: currentPick!.productType,
              displayName: currentPick!.displayName,
              browseNodes: next,
              selectedAt: currentPick!.selectedAt ?? new Date().toISOString(),
            })
          }}
        />
      )}
    </div>
  )
}

function BrowseNodeInput({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState(value.join(', '))
  // Keep the draft in sync when an external mirror writes new
  // browseNodes to the slice.
  useEffect(() => {
    setDraft(value.join(', '))
  }, [value])
  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 px-3 py-2">
      <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
        Browse-node IDs
        <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
          comma-separated, marketplace-specific
        </span>
      </label>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const parts = draft
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
          onChange(parts)
        }}
        placeholder="e.g. 1571265031, 1400717031"
        className="w-full h-7 px-2 text-base font-mono border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
      />
      <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
        Look these up in Amazon Seller Central → Inventory → Add a Product →
        the category page footer shows the node ID. The wizard publishes
        them as <span className="font-mono">recommended_browse_nodes</span>.
      </p>
    </div>
  )
}

function SuggestionsPanel({
  suggestions,
  source,
  ruleBasedFallback,
  loading,
  error,
  onFetch,
  onSelect,
  selectedProductType,
}: {
  suggestions: RankedSuggestion[]
  source: 'gemini' | 'rule-based' | null
  ruleBasedFallback: boolean
  loading: boolean
  error: string | null
  onFetch: () => void
  onSelect: (s: RankedSuggestion) => void
  selectedProductType: string | null
}) {
  const hasResults = suggestions.length > 0
  const sourceLabel = (() => {
    if (source === 'gemini') return 'AI suggestions'
    if (source === 'rule-based')
      return ruleBasedFallback
        ? 'Suggestions (rule-based — set GEMINI_API_KEY for AI ranking)'
        : 'Suggestions'
    return 'Suggestions'
  })()
  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-2 text-base font-medium text-slate-700 dark:text-slate-300">
          <Sparkles className="w-3.5 h-3.5 text-blue-500" />
          {sourceLabel}
        </div>
        <button
          type="button"
          onClick={onFetch}
          disabled={loading}
          className="inline-flex items-center gap-1 h-6 px-2 text-sm text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-40"
        >
          {loading ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          {hasResults ? 'Regenerate' : 'Get suggestions'}
        </button>
      </div>
      <div className="px-3 py-2">
        {error && (
          <div className="flex items-center gap-2 text-base text-rose-700 dark:text-rose-300 py-2">
            <AlertCircle className="w-3.5 h-3.5" />
            {error}
          </div>
        )}
        {!error && !hasResults && !loading && (
          <p className="text-base text-slate-500 dark:text-slate-400 py-2">
            Click <span className="font-medium">Get suggestions</span> for an
            AI-ranked shortlist.
          </p>
        )}
        {hasResults && (
          <div className="space-y-1.5">
            {suggestions.map((s) => {
              const isSelected = selectedProductType === s.productType
              return (
                <button
                  key={s.productType}
                  type="button"
                  onClick={() => onSelect(s)}
                  className={cn(
                    'w-full text-left flex items-center gap-3 px-2 py-2 rounded-md transition-colors',
                    isSelected
                      ? 'bg-blue-50 dark:bg-blue-950/40 ring-1 ring-blue-200'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800',
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-md text-slate-900 dark:text-slate-100 font-medium">
                        {s.displayName}
                      </span>
                      <span className="text-sm font-mono text-slate-500 dark:text-slate-400">
                        {s.productType}
                      </span>
                    </div>
                    <div className="text-sm text-slate-500 dark:text-slate-400 truncate">
                      {s.reason}
                    </div>
                  </div>
                  <ConfidenceBadge value={s.confidence} />
                  {isSelected && (
                    <CheckCircle2 className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// HH — typed error banner for the picker. Renders the right CTA per
// error code so users hit "the eBay account isn't connected" not
// "Failed to load product types" with no path forward.
function ListErrorBanner({
  code,
  message,
  channel,
}: {
  code: 'auth_missing' | 'auth_failed' | 'upstream' | 'unknown' | null
  message: string
  channel: string
}) {
  const isEbay = channel === 'EBAY'
  const headline = (() => {
    if (code === 'auth_missing') {
      return isEbay
        ? 'eBay credentials not configured.'
        : 'Channel credentials not configured.'
    }
    if (code === 'auth_failed') {
      return 'eBay rejected the access token. Reconnect your account.'
    }
    if (code === 'upstream') {
      return "eBay's API returned an error — try again in a moment."
    }
    return 'Could not load categories.'
  })()
  const ctaLabel =
    code === 'auth_missing' || code === 'auth_failed'
      ? 'Connect eBay'
      : null
  return (
    <div className="px-3 py-3 border-l-2 border-rose-300 bg-rose-50/40">
      <div className="flex items-start gap-2 text-base text-rose-800">
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{headline}</div>
          <div className="text-sm text-rose-700 dark:text-rose-300 mt-0.5 break-words">
            {message}
          </div>
          {ctaLabel && (
            <a
              href="/settings/channels"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 mt-2 h-6 px-2 text-sm font-medium text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-900 rounded-md bg-white dark:bg-slate-900 hover:bg-blue-50 dark:hover:bg-blue-950/40"
            >
              {ctaLabel}
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

// FF — strip noise from a product name to a tight eBay search seed.
// Drops parenthetical/dashed trailing variant info ("Black - L"),
// quotes, and keeps the first ~4 meaningful tokens. eBay's API
// matches on phrase tokens, so a shorter seed scores more cleanly
// than the full SKU/name.
function extractSearchSeed(name: string): string {
  if (!name) return ''
  const cleaned = name
    .split(/[-–—:|()]/)[0]
    .replace(/["'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const tokens = cleaned.split(' ').filter((t) => t.length > 0)
  return tokens.slice(0, 4).join(' ')
}

// ── GtinOption — compact radio card used in the merged identifiers section ──
function GtinOption({
  checked,
  onChange,
  label,
  children,
}: {
  checked: boolean
  onChange: () => void
  label: string
  children?: React.ReactNode
}) {
  return (
    <label
      className={cn(
        'block px-3 py-2.5 rounded-lg border cursor-pointer transition-colors',
        checked
          ? 'border-blue-400 bg-blue-50/50 dark:border-blue-700 dark:bg-blue-950/20'
          : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-600',
      )}
    >
      <div className="flex items-start gap-2.5">
        <input
          type="radio"
          checked={checked}
          onChange={onChange}
          className="mt-0.5 w-3.5 h-3.5 text-blue-600 dark:text-blue-400 border-slate-300 dark:border-slate-600 focus:ring-blue-500"
        />
        <div className="flex-1">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{label}</div>
          {checked && children}
        </div>
      </div>
    </label>
  )
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  const tone =
    pct >= 75
      ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900'
      : pct >= 50
      ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900'
      : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'
  return (
    <span
      className={cn(
        'text-xs font-mono px-1.5 py-0.5 border rounded tabular-nums flex-shrink-0',
        tone,
      )}
      title={`${pct}% match confidence`}
    >
      {pct}%
    </span>
  )
}
