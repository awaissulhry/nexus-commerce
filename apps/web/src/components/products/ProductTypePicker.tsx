'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  ChevronDown,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────

export interface ProductTypeListItem {
  productType: string
  displayName: string
  bundled: boolean
  /** Z.3 — eBay confidence score 0..100. */
  matchPercentage?: number
}

interface Props {
  /** Channel scope. Today only AMAZON has a real taxonomy; eBay etc.
   *  return an empty list — the picker falls back to a free-text input
   *  with a TECH_DEBT note in that case. */
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY'
  /** Marketplace scope (Amazon: 'IT', 'DE', etc; null for global). */
  marketplace: string | null
  /** Currently selected productType id (e.g. 'OUTERWEAR'); '' when
   *  unset. */
  value: string
  onChange: (productType: string) => void
  disabled?: boolean
  placeholder?: string
}

// ── Session cache (per-(channel, marketplace[, search])) ─────────
//
// Module-level so multiple pickers in the same session share fetched
// payloads. The server caches with a 24-hour TTL (X.2 / Y.1); this
// avoids re-issuing the same GET inside one page load.
//
// AMAZON uses the (channel, marketplace) key — full list cached once.
// EBAY uses the (channel, marketplace, search) key — different query
// = different result; the eBay API is search-as-you-type so each
// keystroke that lands a network call gets its own cache entry.

const sessionCache = new Map<string, ProductTypeListItem[]>()
const inflight = new Map<string, Promise<ProductTypeListItem[]>>()

function cacheKey(
  channel: string,
  marketplace: string | null,
  search?: string,
): string {
  if (search && search.length > 0) {
    return `${channel}:${marketplace ?? '*'}:${search.toLowerCase()}`
  }
  return `${channel}:${marketplace ?? '*'}`
}

async function fetchList(
  channel: string,
  marketplace: string | null,
  forceRefresh: boolean,
  search?: string,
): Promise<ProductTypeListItem[]> {
  const key = cacheKey(channel, marketplace, search)
  if (!forceRefresh) {
    const cached = sessionCache.get(key)
    if (cached) return cached
    const pending = inflight.get(key)
    if (pending) return pending
  }
  const url = new URL(
    `${getBackendUrl()}/api/listing-wizard/product-types`,
  )
  url.searchParams.set('channel', channel)
  if (marketplace) url.searchParams.set('marketplace', marketplace)
  if (search) url.searchParams.set('search', search)
  if (forceRefresh) url.searchParams.set('refresh', '1')
  const promise = fetch(url.toString(), { cache: 'no-store' })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    })
    .then((json) => {
      const items = Array.isArray(json.items)
        ? (json.items as ProductTypeListItem[])
        : []
      sessionCache.set(key, items)
      inflight.delete(key)
      return items
    })
    .catch((err) => {
      inflight.delete(key)
      throw err
    })
  inflight.set(key, promise)
  return promise
}

/** Public API for callers that want to force-refresh from another
 *  affordance (e.g. a settings page). */
export function clearProductTypeCache(
  channel?: string,
  marketplace?: string | null,
) {
  if (!channel) {
    sessionCache.clear()
    return
  }
  // For eBay we don't know which (search) keys are cached, so wipe
  // anything that prefix-matches.
  const prefix = `${channel}:${marketplace ?? '*'}`
  for (const k of Array.from(sessionCache.keys())) {
    if (k.startsWith(prefix)) sessionCache.delete(k)
  }
}

// ── Component ──────────────────────────────────────────────────

export default function ProductTypePicker({
  channel,
  marketplace,
  value,
  onChange,
  disabled,
  placeholder,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<ProductTypeListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  // Y.2 — three modes:
  //   'list':      AMAZON. Load full list once, filter client-side as
  //                user types. Fast for ~1k entries; one round-trip
  //                per (marketplace, session).
  //   'search':    EBAY. eBay's taxonomy has tens of thousands of
  //                categories; the API is search-as-you-type. Empty
  //                input = empty results; debounced server fetch on
  //                each keystroke.
  //   'free-text': SHOPIFY/WOOCOMMERCE/ETSY. No taxonomy service yet
  //                (TECH_DEBT); the picker collapses to a plain input.
  const mode: 'list' | 'search' | 'free-text' =
    channel === 'AMAZON'
      ? 'list'
      : channel === 'EBAY'
      ? 'search'
      : 'free-text'

  const channelHasTaxonomy = mode !== 'free-text'

  // Debounced search query for 'search' mode.
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    if (mode !== 'search') return
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => window.clearTimeout(t)
  }, [search, mode])

  // Load on mount (list mode) OR re-fetch when debouncedSearch
  // changes (search mode).
  useEffect(() => {
    if (mode === 'free-text') {
      setItems([])
      return
    }
    if (mode === 'search' && debouncedSearch.length < 2) {
      setItems([])
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setError(null)
    setLoading(true)
    fetchList(
      channel,
      marketplace,
      false,
      mode === 'search' ? debouncedSearch : undefined,
    )
      .then((list) => {
        if (cancelled) return
        setItems(list)
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
  }, [channel, marketplace, mode, debouncedSearch])

  // Outside click / Esc to close.
  useEffect(() => {
    if (!open) return
    const onMouse = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouse)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouse)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Focus the search input when opening.
  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 30)
      return () => window.clearTimeout(t)
    }
  }, [open])

  // 'list' mode filters client-side; 'search' mode trusts the server's
  // already-ranked results.
  const filtered = useMemo(() => {
    if (mode === 'search') return items
    if (!search.trim()) return items
    const q = search.trim().toLowerCase()
    return items.filter(
      (i) =>
        i.productType.toLowerCase().includes(q) ||
        i.displayName.toLowerCase().includes(q),
    )
  }, [items, search, mode])

  const handleRefresh = async () => {
    if (!channelHasTaxonomy) return
    setRefreshing(true)
    setError(null)
    try {
      const fresh = await fetchList(
        channel,
        marketplace,
        true,
        mode === 'search' ? debouncedSearch : undefined,
      )
      setItems(fresh)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }

  // ── Free-text fallback for channels without a taxonomy ─────────
  if (!channelHasTaxonomy) {
    return (
      <div className="space-y-1">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? 'Channel-specific category id'}
          disabled={disabled}
          className="w-full h-8 px-2 text-[12px] font-mono border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50 disabled:text-slate-400"
        />
        <p className="text-[10px] text-amber-700">
          {channel} taxonomy isn't wired yet — type the channel's id
          manually for now (TECH_DEBT).
        </p>
      </div>
    )
  }

  const selected = useMemo(
    () => items.find((i) => i.productType === value),
    [items, value],
  )

  const triggerLabel = (() => {
    if (value && selected) return selected.displayName
    if (value) return value
    return placeholder ?? 'Pick a product type'
  })()

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((s) => !s)}
        className={cn(
          'w-full inline-flex items-center justify-between gap-2 h-8 px-2 text-[12px] border rounded-md bg-white transition-colors',
          value
            ? 'border-slate-200 text-slate-900'
            : 'border-slate-200 text-slate-500',
          'hover:border-slate-300 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500',
          disabled && 'bg-slate-50 cursor-not-allowed opacity-60',
        )}
      >
        <span className="flex-1 text-left truncate">
          {triggerLabel}
          {value && selected && (
            <span className="ml-2 text-[10px] font-mono text-slate-400">
              {selected.productType}
            </span>
          )}
        </span>
        {loading && !open && (
          <Loader2 className="w-3 h-3 animate-spin text-slate-400 flex-shrink-0" />
        )}
        <ChevronDown className="w-3 h-3 text-slate-400 flex-shrink-0" />
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute left-0 right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-lg shadow-lg flex flex-col max-h-[360px]"
        >
          {/* Search row */}
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-slate-100">
            <Search className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                mode === 'search'
                  ? `Type to search ${channel} categories…`
                  : 'Search product types'
              }
              className="flex-1 h-6 text-[12px] outline-none placeholder:text-slate-400"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="text-slate-400 hover:text-slate-700 p-0.5"
                aria-label="Clear search"
              >
                <X className="w-3 h-3" />
              </button>
            )}
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              title="Re-fetch the productType list from the channel"
              className="text-slate-500 hover:text-slate-900 p-0.5 disabled:opacity-40"
              aria-label="Refresh"
            >
              {refreshing ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto">
            {loading && items.length === 0 && (
              <div className="px-3 py-6 text-[12px] text-slate-500 inline-flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading product types from {channel}…
              </div>
            )}
            {error && (
              <div className="m-2 px-3 py-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded inline-flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <div>
                  {error}
                  <button
                    type="button"
                    onClick={() => void handleRefresh()}
                    className="ml-2 underline"
                  >
                    Try again
                  </button>
                </div>
              </div>
            )}
            {!loading && !error && filtered.length === 0 && (
              <div className="px-3 py-4 text-[12px] text-slate-500">
                {mode === 'search' && debouncedSearch.length < 2
                  ? `Type at least 2 characters to search ${channel} categories.`
                  : `No matches${search ? ` for "${search}"` : ''}.`}
              </div>
            )}
            {filtered.map((i) => {
              const active = i.productType === value
              return (
                <button
                  key={i.productType}
                  type="button"
                  onClick={() => {
                    onChange(i.productType)
                    setOpen(false)
                    setSearch('')
                  }}
                  className={cn(
                    'w-full px-3 py-1.5 text-left flex items-center justify-between gap-2 hover:bg-slate-50',
                    active && 'bg-blue-50 text-blue-900',
                  )}
                >
                  <span className="flex flex-col min-w-0">
                    <span className="text-[12px] truncate">
                      {i.displayName}
                    </span>
                    <span className="text-[10px] font-mono text-slate-500 truncate">
                      {i.productType}
                    </span>
                  </span>
                  <span className="flex items-center gap-1 flex-shrink-0">
                    {/* Z.3 — eBay confidence score. Greens at ≥85%,
                        ambers in the 60–84% range, slate below 60.
                        Helps the user pick the right leaf when several
                        sibling categories share a path prefix. */}
                    {typeof i.matchPercentage === 'number' && (
                      <span
                        className={cn(
                          'text-[10px] tabular-nums font-medium px-1 py-0.5 rounded border',
                          i.matchPercentage >= 85
                            ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                            : i.matchPercentage >= 60
                            ? 'text-amber-700 bg-amber-50 border-amber-200'
                            : 'text-slate-600 bg-slate-50 border-slate-200',
                        )}
                        title={`eBay confidence: ${i.matchPercentage}%`}
                      >
                        {Math.round(i.matchPercentage)}%
                      </span>
                    )}
                    {i.bundled && (
                      <span
                        className="text-[10px] uppercase tracking-wide font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1 py-0.5 rounded"
                        title="From bundled list — SP-API not configured or returned nothing"
                      >
                        bundled
                      </span>
                    )}
                    {active && (
                      <Check className="w-3.5 h-3.5 text-blue-600" />
                    )}
                  </span>
                </button>
              )
            })}
          </div>

          {/* Footer */}
          <div className="border-t border-slate-100 px-3 py-1.5 text-[10px] text-slate-500 flex items-center justify-between">
            <span>
              {mode === 'search'
                ? `${filtered.length} match${
                    filtered.length === 1 ? '' : 'es'
                  } · search-as-you-type`
                : `${filtered.length}/${items.length} types · cached for the session`}
            </span>
            <span className="font-mono">
              {channel}:{marketplace ?? '*'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
