/**
 * Phase 10c — UniversalFilterBar.
 *
 * One filter bar consumed by every page that filters tabular data
 * (/products, /listings, /catalog/organize, /bulk-operations,
 * /products/drafts). Speaks the canonical CommonFilters contract from
 * apps/web/src/lib/filters so URL params, vocabulary, and UI behaviour
 * stay consistent across pages.
 *
 * Why one component
 * ─────────────────
 * Phase 1 audit found each page reimplementing the same UI with
 * subtle differences (CSV vs repeated-key URLs, slightly different
 * select widgets, no shared 'Clear all' affordance). Centralising
 * the bar means a fix here ships everywhere; pages keep ownership of
 * their page-specific filters via the `extras` slot.
 *
 * What it does NOT own
 * ────────────────────
 * - URL state. The page's own router.replace() lives at the call
 *   site so each page can decide how to merge its page-specific
 *   filters with the common ones.
 * - Server fetches. The bar emits `onChange(filters)` when the user
 *   modifies anything; the page handles refetching.
 * - Saved views. Tracked in TECH_DEBT, separate phase.
 *
 * Usage
 * ─────
 *   <UniversalFilterBar
 *     filters={current}
 *     onChange={(next) => updateUrl(next)}
 *     available={{
 *       channels: ['AMAZON', 'EBAY', 'SHOPIFY'],
 *       marketplaces: ['IT', 'DE', 'GLOBAL'],
 *       statuses: [{ value: 'ACTIVE', label: 'Active' }, …],
 *     }}
 *     searchPlaceholder="Search products by SKU, name, ASIN…"
 *     extras={<MyPageSpecificFilter />}
 *   />
 */

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, ChevronDown, Check, Filter } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CommonFilters } from '@/lib/filters'
import { activeCount, isEmpty, EMPTY_FILTERS } from '@/lib/filters'

export interface StatusOption {
  value: string
  /** Visible label; defaults to the value title-cased. */
  label?: string
  /** Optional accent color tone for the chip when selected. */
  tone?: 'neutral' | 'success' | 'warn' | 'danger' | 'info'
}

export interface UniversalFilterBarAvailable {
  /** Channel codes (upper-case) the page supports filtering by. */
  channels?: string[]
  /** Marketplace codes (upper-case). */
  marketplaces?: string[]
  /** Status options the page accepts; absent = no status filter rendered. */
  statuses?: StatusOption[]
}

export interface UniversalFilterBarProps {
  filters: CommonFilters
  onChange: (next: CommonFilters) => void
  available: UniversalFilterBarAvailable
  searchPlaceholder?: string
  /**
   * Slot for page-specific filter UI (productType, brand, hasPhotos,
   * etc.). Rendered to the right of the standard dimensions.
   */
  extras?: React.ReactNode
  /** Optional className applied to the root for layout overrides. */
  className?: string
  /**
   * Search debounce in ms. The bar still updates its own input value
   * synchronously; only the onChange emission for `filters.search` is
   * deferred so the page doesn't refetch on every keystroke. Default 250.
   */
  searchDebounceMs?: number
}

export default function UniversalFilterBar({
  filters,
  onChange,
  available,
  searchPlaceholder = 'Search…',
  extras,
  className,
  searchDebounceMs = 250,
}: UniversalFilterBarProps) {
  // Local search state lets the input stay snappy even while the
  // debounce window is still open — typing reflects immediately,
  // onChange emission is deferred.
  const [searchInput, setSearchInput] = useState(filters.search ?? '')
  const lastEmittedSearch = useRef(filters.search ?? '')

  // Keep input in sync when the parent supplies a new value (e.g.
  // after a Clear all, or when the URL changes via back/forward).
  useEffect(() => {
    if ((filters.search ?? '') !== lastEmittedSearch.current) {
      setSearchInput(filters.search ?? '')
      lastEmittedSearch.current = filters.search ?? ''
    }
  }, [filters.search])

  useEffect(() => {
    if (searchInput === lastEmittedSearch.current) return
    const t = window.setTimeout(() => {
      lastEmittedSearch.current = searchInput
      onChange({ ...filters, search: searchInput || undefined })
    }, searchDebounceMs)
    return () => window.clearTimeout(t)
  }, [searchInput, searchDebounceMs])

  const toggleMulti = useCallback(
    (key: 'channel' | 'marketplace' | 'status', value: string) => {
      const current = filters[key]
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value]
      onChange({ ...filters, [key]: next })
    },
    [filters, onChange],
  )

  const clearKey = useCallback(
    (key: 'channel' | 'marketplace' | 'status') => {
      onChange({ ...filters, [key]: [] })
    },
    [filters, onChange],
  )

  const clearAll = useCallback(() => {
    setSearchInput('')
    lastEmittedSearch.current = ''
    onChange(EMPTY_FILTERS)
  }, [onChange])

  const count = activeCount(filters)
  const empty = isEmpty(filters)

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {/* Search */}
      <div className="relative flex-1 min-w-[260px] max-w-[420px]">
        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label="Search"
          className="w-full h-8 pl-8 pr-7 text-base border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-300"
        />
        {searchInput && (
          <button
            type="button"
            onClick={() => setSearchInput('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600"
            aria-label="Clear search"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Channel */}
      {available.channels && available.channels.length > 0 && (
        <MultiSelect
          label="Channel"
          options={available.channels.map((c) => ({ value: c, label: c }))}
          selected={filters.channel}
          onToggle={(v) => toggleMulti('channel', v)}
          onClear={() => clearKey('channel')}
        />
      )}

      {/* Marketplace */}
      {available.marketplaces && available.marketplaces.length > 0 && (
        <MultiSelect
          label="Marketplace"
          options={available.marketplaces.map((m) => ({ value: m, label: m }))}
          selected={filters.marketplace}
          onToggle={(v) => toggleMulti('marketplace', v)}
          onClear={() => clearKey('marketplace')}
        />
      )}

      {/* Status */}
      {available.statuses && available.statuses.length > 0 && (
        <MultiSelect
          label="Status"
          options={available.statuses.map((s) => ({
            value: s.value,
            label: s.label ?? s.value,
            tone: s.tone,
          }))}
          selected={filters.status}
          onToggle={(v) => toggleMulti('status', v)}
          onClear={() => clearKey('status')}
        />
      )}

      {/* Page-specific filters */}
      {extras}

      {/* Clear all + active count */}
      {!empty && (
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-slate-500 inline-flex items-center gap-1">
            <Filter className="w-3 h-3" />
            {count} active
          </span>
          <button
            type="button"
            onClick={clearAll}
            className="h-8 px-2.5 text-sm text-slate-700 hover:text-slate-900 border border-slate-200 rounded-md hover:bg-slate-50"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  )
}

interface MultiOption {
  value: string
  label: string
  tone?: StatusOption['tone']
}

interface MultiSelectProps {
  label: string
  options: MultiOption[]
  selected: string[]
  onToggle: (value: string) => void
  onClear: () => void
}

const TONE_CHIP: Record<NonNullable<StatusOption['tone']>, string> = {
  neutral: 'bg-slate-50 border-slate-200 text-slate-700',
  success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  warn: 'bg-amber-50 border-amber-200 text-amber-800',
  danger: 'bg-rose-50 border-rose-200 text-rose-800',
  info: 'bg-blue-50 border-blue-200 text-blue-800',
}

function MultiSelect({
  label,
  options,
  selected,
  onToggle,
  onClear,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Close on outside click + on Escape.
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  const buttonLabel = useMemo(() => {
    if (selected.length === 0) return label
    if (selected.length === 1) return `${label}: ${selected[0]}`
    return `${label} · ${selected.length}`
  }, [label, selected])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          'inline-flex items-center gap-1.5 h-8 px-2.5 text-base rounded-md border transition-colors',
          selected.length > 0
            ? 'bg-blue-50 border-blue-300 text-blue-800'
            : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300',
        )}
      >
        {buttonLabel}
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute z-20 top-full mt-1 left-0 min-w-[200px] max-h-[320px] overflow-auto bg-white border border-slate-200 rounded-md shadow-lg py-1"
        >
          {options.length === 0 ? (
            <div className="px-3 py-2 text-sm text-slate-400">
              No options
            </div>
          ) : (
            options.map((opt) => {
              const isOn = selected.includes(opt.value)
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={isOn}
                  onClick={() => onToggle(opt.value)}
                  className={cn(
                    'w-full flex items-center justify-between gap-3 px-3 py-1.5 text-base text-left hover:bg-slate-50',
                    isOn && 'bg-slate-50',
                  )}
                >
                  <span className="flex items-center gap-2">
                    {opt.tone && (
                      <span
                        className={cn(
                          'inline-block w-1.5 h-1.5 rounded-full',
                          TONE_CHIP[opt.tone].split(' ')[0].replace('bg-', 'bg-'),
                        )}
                      />
                    )}
                    {opt.label}
                  </span>
                  {isOn && <Check className="w-3.5 h-3.5 text-blue-600" />}
                </button>
              )
            })
          )}
          {selected.length > 0 && (
            <div className="border-t border-slate-100 mt-1 pt-1 px-2">
              <button
                type="button"
                onClick={() => {
                  onClear()
                  setOpen(false)
                }}
                className="w-full text-left px-1 py-1 text-sm text-slate-500 hover:text-slate-700"
              >
                Clear {label.toLowerCase()}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
