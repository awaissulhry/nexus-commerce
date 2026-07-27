'use client'

// ── Product lookup (extracted from the ED v2 P3 PreviewProductPicker) ────────
// Same /api/products/lookup combobox pattern as the images drawer's
// "Add family" picker: family roots (parents + standalones), drafts included.
//
// DS-1 fixes over the modal's picker:
//  - spinner race: loading used to flip ON at effect start and OFF in the
//    aborted predecessor's `finally`, so a superseded request could hide the
//    live request's spinner. Now only the request that actually fired owns the
//    spinner, and an aborted request touches nothing.
//  - a failed lookup renders a "Search failed" row (with Retry) instead of a
//    silently empty dropdown.

import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, Search } from 'lucide-react'
import { Input } from '@/design-system/primitives/Input'
import { getBackendUrl } from '@/lib/backend-url'
import { fetchJson } from './fetchJson'
import type { LookupItem, PreviewProduct } from './types'

export function ProductLookup({ onSelect, placeholder, disabled }: {
  onSelect: (p: PreviewProduct) => void
  placeholder?: string
  disabled?: boolean
}) {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<LookupItem[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setItems([]); setLoading(false); setFailed(null); return }
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      // Spinner race fix: loading flips ON only when THIS request fires, and
      // only THIS request may flip it off — a superseded (aborted) request
      // returns without touching any state.
      setLoading(true)
      setFailed(null)
      void fetchJson<{ items: LookupItem[] }>(
        `${getBackendUrl()}/api/products/lookup?q=${encodeURIComponent(term)}&limit=20`,
        { signal: ctrl.signal },
      ).then((r) => {
        if (!r.ok && r.aborted) return
        setLoading(false)
        if (!r.ok) { setItems([]); setFailed(r.error); return }
        setItems(r.data.items ?? [])
      })
    }, 250)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [q, retryTick])

  const term = q.trim()
  const showDropdown = focused && term.length >= 2
  return (
    <div className="relative flex-1 min-w-0">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setFocused(true)}
        // Delay blur so a result click registers before the dropdown unmounts.
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        leadingIcon={<Search className="w-3.5 h-3.5" />}
        placeholder={placeholder ?? 'Search a product by SKU or title…'}
        aria-label="Search a product to add"
        disabled={disabled}
      />
      {showDropdown && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg max-h-64 overflow-y-auto">
          {loading && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Searching…
            </div>
          )}
          {!loading && failed && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-red-600 dark:text-red-400">
              <span className="min-w-0 flex-1">Search failed — {failed}</span>
              <button type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setRetryTick((n) => n + 1)}
                className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">
                <RefreshCw className="w-3 h-3" /> Retry
              </button>
            </div>
          )}
          {!loading && !failed && items.length === 0 && (
            <div className="px-3 py-2 text-xs text-slate-400">No products match "{term}".</div>
          )}
          {!loading && !failed && items.map((it) => (
            <button key={it.id} type="button"
              // onMouseDown fires before the input's blur, so the click always lands.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onSelect({ id: it.id, sku: it.sku, title: it.title, hasEbayListing: it.hasEbayListing }); setQ('') }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors">
              <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex-shrink-0">{it.sku}</span>
              {it.title && <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate min-w-0">{it.title}</span>}
              {!it.hasEbayListing && (
                <span className="ml-auto flex-shrink-0 text-[10px] rounded-full px-1.5 py-0.5 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 font-medium"
                  title="No eBay listing yet — previews render with an empty body">
                  draft
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
