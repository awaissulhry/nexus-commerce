'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2,
  Sparkles,
  Loader2,
  AlertCircle,
  Search,
  RefreshCw,
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
  source?: 'ai' | 'manual'
  selectedAt?: string
  aiSuggestions?: RankedSuggestion[]
  aiSource?: 'gemini' | 'rule-based'
  aiRuleBasedFallback?: boolean
}

const LIST_DEBOUNCE_MS = 200

export default function Step3ProductType({
  wizardId,
  wizardState,
  updateWizardState,
  product,
  channel,
  marketplace,
}: StepProps) {
  const slice = (wizardState.productType ?? {}) as ProductTypeSlice

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [items, setItems] = useState<ProductTypeListItem[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const [selected, setSelected] = useState<{
    productType: string
    displayName: string
  } | null>(
    slice.productType
      ? {
          productType: slice.productType,
          displayName: slice.displayName ?? slice.productType,
        }
      : null,
  )

  const [suggestions, setSuggestions] = useState<RankedSuggestion[]>(
    slice.aiSuggestions ?? [],
  )
  const [suggestSource, setSuggestSource] = useState<
    'gemini' | 'rule-based' | null
  >(slice.aiSource ?? null)
  const [suggestFallback, setSuggestFallback] = useState<boolean>(
    slice.aiRuleBasedFallback ?? false,
  )
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestError, setSuggestError] = useState<string | null>(null)

  const [activeIdx, setActiveIdx] = useState<number>(-1)
  const listRef = useRef<HTMLDivElement>(null)

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), LIST_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [search])

  // Fetch the candidate list whenever the search changes.
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
      // Cache into wizard state so revisits skip the round-trip.
      void updateWizardState({
        productType: {
          ...slice,
          aiSuggestions: data.suggestions,
          aiSource: data.source,
          aiRuleBasedFallback: data.ruleBasedFallback,
        },
      })
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : String(err))
    } finally {
      setSuggestLoading(false)
    }
    // updateWizardState + slice are deliberately stable refs from the
    // wizard shell; depending on them would re-trigger after every save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, wizardId])

  const handleSelect = useCallback(
    async (
      item: { productType: string; displayName: string },
      source: 'ai' | 'manual',
    ) => {
      setSelected(item)
      const nextSlice: ProductTypeSlice = {
        ...slice,
        productType: item.productType,
        displayName: item.displayName,
        source,
        selectedAt: new Date().toISOString(),
      }
      await updateWizardState({ productType: nextSlice })
      // Fire-and-forget — warm Step 4's schema cache.
      void fetch(
        `${getBackendUrl()}/api/listing-wizard/${wizardId}/prefetch-schema`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productType: item.productType }),
        },
      ).catch(() => {})
    },
    [slice, updateWizardState, wizardId],
  )

  const onContinue = useCallback(async () => {
    if (!selected) return
    await updateWizardState(
      {
        productType: {
          ...slice,
          productType: selected.productType,
          displayName: selected.displayName,
          source: slice.source ?? 'manual',
          selectedAt: slice.selectedAt ?? new Date().toISOString(),
        },
      },
      { advance: true },
    )
  }, [selected, slice, updateWizardState])

  // Keyboard nav over the list. Only active when search is focused or
  // when the user has just clicked into the list area.
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
      if (it) void handleSelect(it, 'manual')
    }
  }

  const continueDisabled = !selected

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="mb-6">
        <h2 className="text-[20px] font-semibold text-slate-900">
          Product Type
        </h2>
        <p className="text-[13px] text-slate-600 mt-1">
          Pick the Amazon category for{' '}
          <span className="font-medium text-slate-800">{product.name}</span>.
          This drives the required-fields form on the next step.
        </p>
      </div>

      {/* ── AI / rule-based suggestions ───────────────────────────── */}
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
        selectedProductType={selected?.productType ?? null}
      />

      {/* ── Manual search ─────────────────────────────────────────── */}
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
          ref={listRef}
          className="max-h-[320px] overflow-y-auto"
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
              No matches.{' '}
              <button
                type="button"
                onClick={() => setSearch('')}
                className="text-blue-600 hover:underline"
              >
                Clear search
              </button>
            </div>
          )}
          {items.map((item, idx) => {
            const isSelected = selected?.productType === item.productType
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
                    title="From the bundled fallback list — connect Amazon SP-API for live results"
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

      {/* ── Selection + continue ─────────────────────────────────── */}
      <div className="mt-6 flex items-center justify-between gap-3">
        <div className="text-[12px] text-slate-600 truncate min-w-0">
          {selected ? (
            <span>
              Selected:{' '}
              <span className="font-mono text-slate-900">
                {selected.productType}
              </span>{' '}
              <span className="text-slate-500">— {selected.displayName}</span>
            </span>
          ) : (
            <span className="text-slate-400">Pick a category to continue</span>
          )}
        </div>
        <button
          type="button"
          onClick={onContinue}
          disabled={continueDisabled}
          className={cn(
            'h-8 px-4 rounded-md text-[13px] font-medium',
            continueDisabled
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
  const sourceLabel = useMemo(() => {
    if (source === 'gemini') return 'AI suggestions'
    if (source === 'rule-based')
      return ruleBasedFallback
        ? 'Suggestions (rule-based — set GEMINI_API_KEY for AI ranking)'
        : 'Suggestions'
    return 'Suggestions'
  }, [source, ruleBasedFallback])

  return (
    <div className="mb-5 border border-slate-200 rounded-lg bg-white">
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
            Click <span className="font-medium">Get suggestions</span> for a
            ranked shortlist based on this product. Or skip and search
            manually below.
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
