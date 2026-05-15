'use client'

import { useEffect, useState } from 'react'
import { Search, X, Loader2, RefreshCw, Plus, Minus } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { LabelItem } from './types'

interface Props {
  items: LabelItem[]
  onChange: (items: LabelItem[]) => void
  onFetchFnskus: () => void
  fetchingFnskus: boolean
}

interface SearchResult {
  id: string
  sku: string
  name: string
  imageUrl: string | null
  totalStock: number | null
  variationAttributes?: Record<string, string>
}

export function SkuPanel({ items, onChange, onFetchFnskus, fetchingFnskus }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setResults([]); return }
    setSearching(true)
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/products?search=${encodeURIComponent(q)}&limit=8`)
        const data = await res.json().catch(() => ({}))
        setResults(
          (data?.products ?? []).map((p: any) => ({
            id: p.id,
            sku: p.sku,
            name: p.name,
            imageUrl: p.imageUrl ?? null,
            totalStock: typeof p.totalStock === 'number' ? p.totalStock : null,
            variationAttributes: p.variationAttributes ?? {},
          })),
        )
      } catch { setResults([]) }
      finally { setSearching(false) }
    }, 250)
    return () => window.clearTimeout(t)
  }, [query])

  const addSku = (p: SearchResult) => {
    const existing = items.findIndex(it => it.sku === p.sku)
    if (existing >= 0) {
      onChange(items.map((it, i) => i === existing ? { ...it, quantity: it.quantity + 1 } : it))
    } else {
      onChange([...items, {
        sku: p.sku,
        fnsku: '',
        quantity: 1,
        productName: p.name,
        listingTitle: null,
        variationAttributes: p.variationAttributes ?? {},
        imageUrl: p.imageUrl,
      }])
    }
    setQuery('')
    setResults([])
  }

  const updateQty = (idx: number, delta: number) => {
    onChange(items.map((it, i) => i === idx ? { ...it, quantity: Math.max(1, it.quantity + delta) } : it))
  }

  const updateFnsku = (idx: number, val: string) => {
    onChange(items.map((it, i) => i === idx ? { ...it, fnsku: val } : it))
  }

  const remove = (idx: number) => {
    onChange(items.filter((_, i) => i !== idx))
  }

  return (
    <div className="w-64 shrink-0 flex flex-col bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800">
      {/* Search */}
      <div className="p-3 border-b border-slate-200 dark:border-slate-800">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-2.5 text-slate-400 pointer-events-none" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search SKU or product…"
            className="w-full h-8 pl-8 pr-3 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500"
          />
          {searching && <Loader2 size={13} className="absolute right-2.5 top-2.5 text-slate-400 animate-spin" />}
        </div>

        {/* Dropdown results */}
        {results.length > 0 && (
          <div className="mt-1 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 shadow-lg z-10">
            {results.map(p => (
              <button
                key={p.sku}
                onClick={() => addSku(p)}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-violet-50 dark:hover:bg-violet-950/30 text-left"
              >
                {p.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.imageUrl} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="text-xs font-mono text-slate-500 truncate">{p.sku}</div>
                  <div className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{p.name}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Fetch FNSKUs button */}
      {items.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800">
          <button
            onClick={onFetchFnskus}
            disabled={fetchingFnskus}
            className="w-full inline-flex items-center justify-center gap-1.5 h-7 text-xs rounded border border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/30 disabled:opacity-50"
          >
            {fetchingFnskus ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {fetchingFnskus ? 'Fetching…' : 'Fetch FNSKUs from Amazon'}
          </button>
        </div>
      )}

      {/* Item list */}
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 && (
          <p className="text-xs text-slate-400 text-center mt-8 px-4">Search for products above to add them</p>
        )}
        {items.map((it, idx) => {
          const attrs = it.variationAttributes ?? {}
          const color = attrs['Color'] ?? attrs['color'] ?? ''
          const size = attrs['Size'] ?? attrs['size'] ?? ''
          return (
            <div key={`${it.sku}-${idx}`} className="px-3 py-2.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
              <div className="flex items-start justify-between gap-1">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-mono text-slate-500 truncate">{it.sku}</div>
                  <div className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{it.productName ?? '—'}</div>
                  {(color || size) && (
                    <div className="flex gap-1 mt-0.5 flex-wrap">
                      {color && <span className="text-xs bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 px-1.5 py-0.5 rounded">{color}</span>}
                      {size && <span className="text-xs bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 px-1.5 py-0.5 rounded">{size}</span>}
                    </div>
                  )}
                </div>
                <button onClick={() => remove(idx)} className="text-slate-400 hover:text-red-500 shrink-0 mt-0.5">
                  <X size={13} />
                </button>
              </div>

              {/* FNSKU input */}
              <div className="mt-1.5">
                <label className="text-xs text-slate-400 block mb-0.5">FNSKU</label>
                <div className="relative flex items-center">
                  <input
                    value={it.fnsku}
                    onChange={e => updateFnsku(idx, e.target.value)}
                    placeholder={it.fnskuLoading ? 'Fetching…' : 'e.g. X0029S704D'}
                    className="w-full h-6 px-2 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  />
                  {it.fnskuLoading && <Loader2 size={11} className="absolute right-1.5 text-slate-400 animate-spin" />}
                </div>
              </div>

              {/* Qty control */}
              <div className="mt-1.5 flex items-center gap-1.5">
                <span className="text-xs text-slate-400">Copies:</span>
                <button onClick={() => updateQty(idx, -1)} className="h-5 w-5 flex items-center justify-center rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800">
                  <Minus size={10} />
                </button>
                <span className="text-sm w-5 text-center font-mono">{it.quantity}</span>
                <button onClick={() => updateQty(idx, 1)} className="h-5 w-5 flex items-center justify-center rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800">
                  <Plus size={10} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
