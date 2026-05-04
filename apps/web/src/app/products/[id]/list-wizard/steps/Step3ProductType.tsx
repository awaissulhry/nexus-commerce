'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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
    await updateWizardState({}, { advance: true })
  }, [unsatisfied.length, updateWizardState])

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
        <h2 className="text-[20px] font-semibold text-slate-900">
          Product Type
        </h2>
        <p className="text-[13px] text-slate-600 mt-1">
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

      <div className="mt-6 flex items-center justify-between gap-3">
        <span className="text-[12px]">
          {unsatisfied.length === 0 ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Every channel has a product type.
            </span>
          ) : (
            <span className="text-amber-700">
              {unsatisfied.length} channel
              {unsatisfied.length === 1 ? '' : 's'} still need a category
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={onContinue}
          disabled={unsatisfied.length > 0}
          className={cn(
            'h-8 px-4 rounded-md text-[13px] font-medium',
            unsatisfied.length > 0
              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
              : 'bg-blue-600 text-white hover:bg-blue-700',
          )}
        >
          Continue
        </button>
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
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : status.reason === 'in_progress'
    ? 'border-amber-200 bg-amber-50 text-amber-800'
    : 'border-slate-200 bg-slate-50 text-slate-700'
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
        return 'GTIN exemption needed — Step 3 collects it'
    }
  })()
  return (
    <div
      className={cn(
        'border-t px-4 py-2 text-[11px] inline-flex items-start gap-1.5 w-full',
        tone,
      )}
    >
      {!status.needed ? (
        <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-emerald-600 flex-shrink-0" />
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
    <div className="border border-slate-200 rounded-lg bg-slate-50/50 px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[10px] uppercase tracking-wide text-slate-400 font-medium">
          Skipped
        </span>
        <span className="font-mono text-[12px] text-slate-600 truncate">
          {channelKey}
        </span>
      </div>
      <span className="text-[11px] text-slate-500">
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
        'border rounded-lg bg-white',
        hasPick ? 'border-slate-200' : 'border-amber-200 bg-amber-50/30',
      )}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-2 min-w-0 text-left"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
          )}
          {hasPick ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
          )}
          <div className="min-w-0">
            <div className="font-mono text-[13px] text-slate-900 font-medium truncate">
              {channelKey}
            </div>
            {hasPick ? (
              <div className="text-[11px] text-slate-500 truncate">
                {pick.displayName ?? pick.productType}{' '}
                <span className="text-slate-400">
                  · {pick.productType}
                </span>
                {pick.source === 'mirror' && pick.mirrorOf && (
                  <span className="ml-1 text-[10px] uppercase tracking-wide text-blue-700">
                    · mirrors {pick.mirrorOf}
                  </span>
                )}
              </div>
            ) : (
              <div className="text-[11px] text-amber-700">
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
        <div className="border-t border-slate-100">
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
  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline"
      >
        <Copy className="w-3 h-3" />
        Same as ▾
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute right-0 top-full mt-1 z-20 bg-white border border-slate-200 rounded shadow-md py-1 min-w-[200px]">
            {candidates.map((c) => {
              const p = picks[c]
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    onMirror(c)
                    setOpen(false)
                  }}
                  className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-slate-50"
                >
                  <div className="font-mono text-slate-700">{c}</div>
                  <div className="text-[10px] text-slate-500 truncate">
                    {p?.productType}
                  </div>
                </button>
              )
            })}
          </div>
        </>
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
    const url = new URL(
      `${getBackendUrl()}/api/listing-wizard/product-types`,
    )
    url.searchParams.set('channel', channel)
    if (marketplace) url.searchParams.set('marketplace', marketplace)
    if (debouncedSearch) url.searchParams.set('search', debouncedSearch)
    fetch(url.toString())
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        if (Array.isArray(data?.items)) {
          setItems(data.items as ProductTypeListItem[])
        } else {
          setItems([])
          setListError(data?.error ?? 'Failed to load product types')
        }
      })
      .catch((err) => {
        if (cancelled) return
        setListError(err instanceof Error ? err.message : String(err))
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

      <div className="border border-slate-200 rounded-lg bg-white">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200">
          <Search className="w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setActiveIdx(-1)
            }}
            onKeyDown={onListKeyDown}
            placeholder="Search categories — e.g. jacket, helmet, gloves"
            className="flex-1 h-7 text-[13px] focus:outline-none bg-transparent"
          />
          {listLoading && (
            <Loader2 className="w-3.5 h-3.5 text-slate-400 animate-spin" />
          )}
        </div>
        <div
          className="max-h-[280px] overflow-y-auto"
          tabIndex={0}
          onKeyDown={onListKeyDown}
        >
          {listError && (
            <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-rose-700">
              <AlertCircle className="w-3.5 h-3.5" />
              {listError}
            </div>
          )}
          {!listError && !listLoading && items.length === 0 && (
            <div className="px-3 py-6 text-[12px] text-slate-500 text-center">
              No matches.
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
                  'w-full text-left px-3 py-2 flex items-center gap-3 border-b border-slate-100 last:border-b-0 transition-colors',
                  isActive && !isSelected && 'bg-slate-50',
                  isSelected && 'bg-blue-50',
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-slate-900 truncate">
                    {item.displayName}
                  </div>
                  <div className="text-[11px] font-mono text-slate-500 truncate">
                    {item.productType}
                  </div>
                </div>
                {item.bundled && (
                  <span
                    className="text-[10px] text-slate-400"
                    title="From bundled fallback list — connect Amazon SP-API for live results"
                  >
                    bundled
                  </span>
                )}
                {isSelected && (
                  <CheckCircle2 className="w-4 h-4 text-blue-600" />
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
    <div className="border border-slate-200 rounded-lg bg-white px-3 py-2">
      <label className="block text-[11px] font-medium text-slate-700 mb-1">
        Browse-node IDs
        <span className="ml-2 text-[10px] font-normal text-slate-500">
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
        className="w-full h-7 px-2 text-[12px] font-mono border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
      />
      <p className="mt-1 text-[10px] text-slate-400">
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
    <div className="border border-slate-200 rounded-lg bg-white">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-200">
        <div className="flex items-center gap-2 text-[12px] font-medium text-slate-700">
          <Sparkles className="w-3.5 h-3.5 text-blue-500" />
          {sourceLabel}
        </div>
        <button
          type="button"
          onClick={onFetch}
          disabled={loading}
          className="inline-flex items-center gap-1 h-6 px-2 text-[11px] text-slate-600 border border-slate-200 rounded hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40"
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
          <div className="flex items-center gap-2 text-[12px] text-rose-700 py-2">
            <AlertCircle className="w-3.5 h-3.5" />
            {error}
          </div>
        )}
        {!error && !hasResults && !loading && (
          <p className="text-[12px] text-slate-500 py-2">
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
                      ? 'bg-blue-50 ring-1 ring-blue-200'
                      : 'hover:bg-slate-50',
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] text-slate-900 font-medium">
                        {s.displayName}
                      </span>
                      <span className="text-[11px] font-mono text-slate-500">
                        {s.productType}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {s.reason}
                    </div>
                  </div>
                  <ConfidenceBadge value={s.confidence} />
                  {isSelected && (
                    <CheckCircle2 className="w-4 h-4 text-blue-600 flex-shrink-0" />
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

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  const tone =
    pct >= 75
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : pct >= 50
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-slate-50 text-slate-600 border-slate-200'
  return (
    <span
      className={cn(
        'text-[10px] font-mono px-1.5 py-0.5 border rounded tabular-nums flex-shrink-0',
        tone,
      )}
      title={`${pct}% match confidence`}
    >
      {pct}%
    </span>
  )
}
