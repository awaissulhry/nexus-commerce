'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { FFFilterSection } from '@/app/products/_shared/FFFilterPanel'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UnifiedFilterState {
  search: string
  productTypes: string[]
  channels: string[]             // 'amazon_IT' | 'amazon_DE' | 'ebay_IT' | 'ebay_UK' | 'shopify'
  status: string[]               // 'ACTIVE' | 'DRAFT' | 'INACTIVE'
  stockLevel: 'all' | 'out' | 'low' | 'in'
  browseNodeIds: string[]
  ebayCategory: string
}

export const UNIFIED_FILTER_DEFAULT: UnifiedFilterState = {
  search: '',
  productTypes: [],
  channels: [],
  status: [],
  stockLevel: 'all',
  browseNodeIds: [],
  ebayCategory: '',
}

export function unifiedFilterActiveCount(f: UnifiedFilterState): number {
  let n = 0
  if (f.search) n++
  if (f.productTypes.length) n++
  if (f.channels.length) n++
  if (f.status.length) n++
  if (f.stockLevel !== 'all') n++
  if (f.browseNodeIds.length) n++
  if (f.ebayCategory) n++
  return n
}

// ─── Channel options ──────────────────────────────────────────────────────────

const CHANNEL_OPTIONS = [
  { id: 'amazon_IT', label: 'Amazon IT' },
  { id: 'amazon_DE', label: 'Amazon DE' },
  { id: 'ebay_IT',   label: 'eBay IT' },
  { id: 'ebay_DE',   label: 'eBay DE' },
  { id: 'ebay_UK',   label: 'eBay UK' },
  { id: 'shopify',   label: 'Shopify' },
]

const STATUS_OPTIONS = ['ACTIVE', 'DRAFT', 'INACTIVE']
const STOCK_OPTIONS = [
  { value: 'all' as const, label: 'All' },
  { value: 'out' as const, label: 'Out of stock' },
  { value: 'low' as const, label: 'Low (≤10)' },
  { value: 'in'  as const, label: 'In stock' },
]

// ─── Browse node facet ────────────────────────────────────────────────────────

interface BrowseNodeFacet { browseNodeId: string; label: string; count: number }

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  value: UnifiedFilterState
  onChange: (next: UnifiedFilterState) => void
}

export function UnifiedFilterExtras({ value, onChange }: Props) {
  const [browseNodes, setBrowseNodes] = useState<BrowseNodeFacet[]>([])
  const [categorySuggestions, setCategorySuggestions] = useState<
    Array<{ categoryId: string; categoryName: string; path: string }>
  >([])
  const [categorySearch, setCategorySearch] = useState('')
  const [categoryLoading, setCategoryLoading] = useState(false)

  // Fetch browse node facets once
  useEffect(() => {
    fetch(`${getBackendUrl()}/api/products/browse-nodes/facets`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((json) => setBrowseNodes(Array.isArray(json) ? json.slice(0, 20) : []))
      .catch(() => {})
  }, [])

  // Category search
  useEffect(() => {
    if (!categorySearch.trim() || categorySearch.length < 2) {
      setCategorySuggestions([])
      return
    }
    setCategoryLoading(true)
    const t = setTimeout(() => {
      fetch(
        `${getBackendUrl()}/api/ebay/flat-file/category-search?q=${encodeURIComponent(categorySearch)}&marketplace=IT`,
        { cache: 'no-store' },
      )
        .then((r) => r.json())
        .then((json) => setCategorySuggestions(Array.isArray(json) ? json.slice(0, 8) : []))
        .catch(() => {})
        .finally(() => setCategoryLoading(false))
    }, 350)
    return () => clearTimeout(t)
  }, [categorySearch])

  function toggleMulti(field: 'productTypes' | 'channels' | 'status' | 'browseNodeIds', v: string) {
    const cur = value[field] as string[]
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]
    onChange({ ...value, [field]: next })
  }

  return (
    <>
      {/* Product search */}
      <FFFilterSection label="Search">
        <input
          type="text"
          value={value.search}
          onChange={(e) => onChange({ ...value, search: e.target.value })}
          placeholder="SKU or name…"
          className="w-full h-6 px-2 text-xs border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </FFFilterSection>

      {/* Status */}
      <FFFilterSection label="Status">
        <div className="flex flex-wrap gap-1.5">
          {STATUS_OPTIONS.map((s) => (
            <Chip
              key={s}
              active={value.status.includes(s)}
              onClick={() => toggleMulti('status', s)}
            >
              {s}
            </Chip>
          ))}
        </div>
      </FFFilterSection>

      {/* Stock level */}
      <FFFilterSection label="Stock Level">
        <div className="flex flex-wrap gap-1.5">
          {STOCK_OPTIONS.map((o) => (
            <Chip
              key={o.value}
              active={value.stockLevel === o.value}
              onClick={() => onChange({ ...value, stockLevel: o.value })}
            >
              {o.label}
            </Chip>
          ))}
        </div>
      </FFFilterSection>

      {/* Channel visibility */}
      <FFFilterSection label="Channels (column groups)">
        <div className="flex flex-wrap gap-1.5">
          {CHANNEL_OPTIONS.map((c) => (
            <Chip
              key={c.id}
              active={value.channels.includes(c.id)}
              onClick={() => toggleMulti('channels', c.id)}
            >
              {c.label}
            </Chip>
          ))}
        </div>
        {value.channels.length > 0 && (
          <p className="text-[10px] text-tertiary mt-1">Selected channels shown as column groups</p>
        )}
      </FFFilterSection>

      {/* Browse nodes (Amazon) */}
      {browseNodes.length > 0 && (
        <FFFilterSection label="Amazon Browse Nodes">
          <div className="space-y-0.5 max-h-28 overflow-y-auto">
            {browseNodes.map((bn) => (
              <label
                key={bn.browseNodeId}
                className="flex items-center justify-between gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer hover:text-slate-900"
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={value.browseNodeIds.includes(bn.browseNodeId)}
                    onChange={() => toggleMulti('browseNodeIds', bn.browseNodeId)}
                    className="w-3 h-3 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="truncate font-mono">{bn.label}</span>
                </div>
                <span className="text-[10px] text-tertiary flex-shrink-0">{bn.count}</span>
              </label>
            ))}
          </div>
        </FFFilterSection>
      )}

      {/* eBay category */}
      <FFFilterSection label="eBay Category">
        <input
          type="text"
          value={categorySearch}
          onChange={(e) => { setCategorySearch(e.target.value); if (!e.target.value) onChange({ ...value, ebayCategory: '' }) }}
          placeholder="Search eBay categories…"
          className="w-full h-6 px-2 text-xs border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        {value.ebayCategory && (
          <p className="text-[10px] text-blue-600 dark:text-blue-400 mt-1">
            Active: {value.ebayCategory}
            <button className="ml-2 underline" onClick={() => { onChange({ ...value, ebayCategory: '' }); setCategorySearch('') }}>clear</button>
          </p>
        )}
        {categoryLoading && <p className="text-[10px] text-tertiary mt-1">Searching…</p>}
        {categorySuggestions.length > 0 && (
          <div className="mt-1 border border-default dark:border-slate-700 rounded text-xs overflow-hidden">
            {categorySuggestions.map((cat) => (
              <button
                key={cat.categoryId}
                type="button"
                onClick={() => {
                  onChange({ ...value, ebayCategory: cat.categoryId })
                  setCategorySearch(cat.categoryName)
                  setCategorySuggestions([])
                }}
                className="w-full text-left px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 truncate border-b border-subtle dark:border-slate-800 last:border-0"
              >
                <span className="font-medium text-slate-800 dark:text-slate-200">{cat.categoryName}</span>
                <span className="text-tertiary ml-1 text-[10px]">{cat.categoryId}</span>
              </button>
            ))}
          </div>
        )}
      </FFFilterSection>
    </>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'text-[10px] font-medium px-2 py-0.5 rounded border transition-colors',
        active
          ? 'bg-blue-600 text-white border-blue-600'
          : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-default dark:border-slate-700 hover:border-slate-300',
      )}
    >
      {children}
    </button>
  )
}
