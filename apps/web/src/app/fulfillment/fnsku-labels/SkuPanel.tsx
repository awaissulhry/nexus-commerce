'use client'

import { useEffect, useRef, useState } from 'react'
import { Search, X, Loader2, RefreshCw, Plus, Minus, ClipboardList, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { LabelItem } from './types'

interface Props {
  items: LabelItem[]
  onChange: (items: LabelItem[]) => void
  onFetchFnskus: () => void
  fetchingFnskus: boolean
}

interface VariantResult {
  sku: string
  fnsku: string | null
  productName: string | null
  variationAttributes: Record<string, string>
  imageUrl: string | null
}

type Tab = 'search' | 'paste'

export function SkuPanel({ items, onChange, onFetchFnskus, fetchingFnskus }: Props) {
  const [tab, setTab] = useState<Tab>('search')

  // Search tab state
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<VariantResult[]>([])
  const [searching, setSearching] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Paste tab state
  const [pasteText, setPasteText] = useState('')
  const [pasting, setPasting] = useState(false)
  const [pasteResult, setPasteResult] = useState<string | null>(null)

  // Debounced variant search — calls /api/products/variant-search
  useEffect(() => {
    const q = query.trim()
    if (q.length < 1) { setResults([]); return }
    setSearching(true)
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products/variant-search?search=${encodeURIComponent(q)}&limit=12`,
        )
        const data = await res.json().catch(() => ({}))
        setResults(data?.variants ?? [])
      } catch { setResults([]) }
      finally { setSearching(false) }
    }, 200)
    return () => window.clearTimeout(t)
  }, [query])

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setResults([])
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const addVariant = (p: VariantResult) => {
    const existing = items.findIndex(it => it.sku === p.sku)
    if (existing >= 0) {
      onChange(items.map((it, i) => i === existing ? { ...it, quantity: it.quantity + 1 } : it))
    } else {
      onChange([...items, {
        sku: p.sku,
        fnsku: p.fnsku ?? '',
        quantity: 1,
        productName: p.productName,
        listingTitle: null,
        variationAttributes: p.variationAttributes ?? {},
        imageUrl: p.imageUrl,
      }])
    }
    setQuery('')
    setResults([])
  }

  // Paste tab: parse text, call lookup, add all
  const handlePaste = async () => {
    const lines = pasteText
      .split(/[\n,]+/)
      .map(s => s.trim())
      .filter(Boolean)
    const unique = [...new Set(lines)]
    if (unique.length === 0) return

    setPasting(true)
    setPasteResult(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/fnsku/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skus: unique }),
      })
      const data = await res.json()
      const results: any[] = data?.results ?? []

      const newItems: LabelItem[] = []
      let added = 0
      let skipped = 0

      for (const r of results) {
        const existing = items.findIndex(it => it.sku === r.sku)
        if (existing >= 0) {
          skipped++
          continue
        }
        newItems.push({
          sku: r.sku,
          fnsku: r.fnsku ?? '',
          quantity: 1,
          productName: r.productName ?? null,
          listingTitle: r.listingTitle ?? null,
          variationAttributes: r.variationAttributes ?? {},
          imageUrl: r.imageUrl ?? null,
          fnskuError: r.error,
        })
        added++
      }

      // Also add SKUs that weren't found in DB as stubs
      for (const sku of unique) {
        if (!results.find((r: any) => r.sku === sku)) {
          const existing = items.findIndex(it => it.sku === sku)
          if (existing < 0) {
            newItems.push({
              sku,
              fnsku: '',
              quantity: 1,
              productName: null,
              listingTitle: null,
              variationAttributes: {},
              imageUrl: null,
              fnskuError: 'SKU not found — enter FNSKU manually',
            })
            added++
          } else {
            skipped++
          }
        }
      }

      onChange([...items, ...newItems])
      setPasteResult(`Added ${added}${skipped > 0 ? `, skipped ${skipped} already in list` : ''}`)
      if (added > 0) setPasteText('')
    } catch (err: any) {
      setPasteResult(`Error: ${err?.message ?? 'failed'}`)
    } finally {
      setPasting(false)
    }
  }

  const updateQty = (idx: number, delta: number) => {
    onChange(items.map((it, i) => i === idx ? { ...it, quantity: Math.max(1, it.quantity + delta) } : it))
  }

  const updateFnsku = (idx: number, val: string) => {
    onChange(items.map((it, i) => i === idx ? { ...it, fnsku: val, fnskuError: undefined } : it))
  }

  const remove = (idx: number) => {
    onChange(items.filter((_, i) => i !== idx))
  }

  return (
    <div className="w-64 shrink-0 flex flex-col bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800">
      {/* Tab bar */}
      <div className="flex border-b border-slate-200 dark:border-slate-800">
        <button
          onClick={() => setTab('search')}
          className={`flex-1 h-9 text-xs font-medium inline-flex items-center justify-center gap-1 border-b-2 transition-colors ${tab === 'search' ? 'border-violet-500 text-violet-700 dark:text-violet-300' : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
        >
          <Search size={11} /> Search
        </button>
        <button
          onClick={() => setTab('paste')}
          className={`flex-1 h-9 text-xs font-medium inline-flex items-center justify-center gap-1 border-b-2 transition-colors ${tab === 'paste' ? 'border-violet-500 text-violet-700 dark:text-violet-300' : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
        >
          <ClipboardList size={11} /> Paste SKUs
        </button>
      </div>

      {/* Search tab */}
      {tab === 'search' && (
        <div className="p-3 border-b border-slate-200 dark:border-slate-800" ref={dropdownRef}>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-2.5 text-slate-400 pointer-events-none" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search variant SKU or name…"
              className="w-full h-8 pl-8 pr-7 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500"
              autoComplete="off"
            />
            {searching
              ? <Loader2 size={13} className="absolute right-2.5 top-2.5 text-slate-400 animate-spin pointer-events-none" />
              : query && (
                <button onClick={() => { setQuery(''); setResults([]) }} className="absolute right-2 top-2 text-slate-400 hover:text-slate-600">
                  <X size={13} />
                </button>
              )
            }
          </div>

          {results.length > 0 && (
            <div className="absolute left-0 right-0 mt-1 mx-3 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 shadow-xl z-50 max-h-64 overflow-y-auto">
              {results.map(p => {
                const attrs = p.variationAttributes ?? {}
                const color = attrs['Color'] ?? attrs['color'] ?? ''
                const size = attrs['Size'] ?? attrs['size'] ?? ''
                const gender = attrs['Gender'] ?? attrs['gender'] ?? ''
                return (
                  <button
                    key={p.sku}
                    onClick={() => addVariant(p)}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-violet-50 dark:hover:bg-violet-950/30 text-left border-b border-slate-100 dark:border-slate-800 last:border-0"
                  >
                    {p.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.imageUrl} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-mono text-violet-600 dark:text-violet-400 truncate">{p.sku}</div>
                      <div className="text-xs text-slate-700 dark:text-slate-300 truncate">{p.productName ?? ''}</div>
                      <div className="flex gap-1 mt-0.5 flex-wrap">
                        {color && <span className="text-[10px] bg-slate-100 dark:bg-slate-700 text-slate-500 px-1 rounded">{color}</span>}
                        {size  && <span className="text-[10px] bg-slate-100 dark:bg-slate-700 text-slate-500 px-1 rounded">{size}</span>}
                        {gender && <span className="text-[10px] bg-slate-100 dark:bg-slate-700 text-slate-500 px-1 rounded">{gender}</span>}
                        {p.fnsku && <span className="text-[10px] bg-green-100 dark:bg-green-950 text-green-700 dark:text-green-400 px-1 rounded font-mono">{p.fnsku}</span>}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          {!searching && query.length >= 1 && results.length === 0 && (
            <p className="mt-1.5 text-xs text-slate-400 text-center">No variants found</p>
          )}
        </div>
      )}

      {/* Paste SKUs tab */}
      {tab === 'paste' && (
        <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex flex-col gap-2">
          <p className="text-xs text-slate-500">One SKU per line, or comma-separated:</p>
          <textarea
            value={pasteText}
            onChange={e => { setPasteText(e.target.value); setPasteResult(null) }}
            placeholder={'GALE-BLK-S\nGALE-BLK-M\nGALE-RED-S, GALE-RED-M'}
            rows={8}
            className="w-full px-2 py-1.5 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500 resize-none"
          />
          <button
            onClick={handlePaste}
            disabled={pasting || !pasteText.trim()}
            className="w-full h-7 text-xs rounded bg-violet-600 text-white font-medium hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1"
          >
            {pasting ? <><Loader2 size={11} className="animate-spin" /> Adding…</> : 'Add SKUs'}
          </button>
          {pasteResult && (
            <p className="text-xs text-center text-slate-600 dark:text-slate-400">{pasteResult}</p>
          )}
        </div>
      )}

      {/* Fetch FNSKUs button */}
      {items.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800">
          <button
            onClick={onFetchFnskus}
            disabled={fetchingFnskus}
            className="w-full inline-flex items-center justify-center gap-1.5 h-7 text-xs rounded border border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/30 disabled:opacity-50"
          >
            {fetchingFnskus ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {fetchingFnskus ? 'Fetching from Amazon…' : 'Re-fetch FNSKUs from Amazon'}
          </button>
        </div>
      )}

      {/* Item list */}
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 && (
          <p className="text-xs text-slate-400 text-center mt-8 px-4 leading-relaxed">
            Search for variant SKUs above<br />or paste a list in bulk
          </p>
        )}
        {items.map((it, idx) => {
          const attrs = it.variationAttributes ?? {}
          const color  = attrs['Color']  ?? attrs['color']  ?? ''
          const size   = attrs['Size']   ?? attrs['size']   ?? ''
          const gender = attrs['Gender'] ?? attrs['gender'] ?? ''
          return (
            <div key={`${it.sku}-${idx}`} className="px-3 py-2.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
              <div className="flex items-start justify-between gap-1">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-mono text-violet-600 dark:text-violet-400 truncate">{it.sku}</div>
                  {it.productName && (
                    <div className="text-xs text-slate-600 dark:text-slate-400 truncate">{it.productName}</div>
                  )}
                  {(color || size || gender) && (
                    <div className="flex gap-1 mt-0.5 flex-wrap">
                      {color  && <span className="text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-500 px-1 py-0.5 rounded">{color}</span>}
                      {size   && <span className="text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-500 px-1 py-0.5 rounded">{size}</span>}
                      {gender && <span className="text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-500 px-1 py-0.5 rounded">{gender}</span>}
                    </div>
                  )}
                </div>
                <button onClick={() => remove(idx)} className="text-slate-400 hover:text-red-500 shrink-0 mt-0.5">
                  <X size={13} />
                </button>
              </div>

              {/* FNSKU input */}
              <div className="mt-1.5">
                <div className="flex items-center justify-between mb-0.5">
                  <label className="text-xs text-slate-400">FNSKU</label>
                  {it.fnskuError && (
                    <span className="flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                      <AlertTriangle size={9} /> {it.fnskuError.includes('not configured') ? 'SP-API off' : it.fnskuError.includes('not found') ? 'Not in DB' : 'API failed'}
                    </span>
                  )}
                </div>
                <div className="relative flex items-center">
                  <input
                    value={it.fnsku}
                    onChange={e => updateFnsku(idx, e.target.value)}
                    placeholder={it.fnskuLoading ? 'Fetching…' : 'e.g. X0029S704D'}
                    className={`w-full h-6 px-2 text-xs font-mono rounded border bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500 ${it.fnskuError && !it.fnsku ? 'border-amber-400 dark:border-amber-600' : 'border-slate-300 dark:border-slate-700'}`}
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
                <span className="text-xs w-5 text-center font-mono tabular-nums">{it.quantity}</span>
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
