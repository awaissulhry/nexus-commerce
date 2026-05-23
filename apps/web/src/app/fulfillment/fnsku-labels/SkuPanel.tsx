'use client'

import { useEffect, useRef, useState } from 'react'
import { Search, X, Loader2, RefreshCw, Plus, Minus, ClipboardList, AlertTriangle, ScanLine, Trash2, GripVertical } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { BarcodeScanInput } from '@/components/ui/BarcodeScanInput'
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { pickAttr } from './LabelPreview'
import { fnskuFormatHint } from './fnsku-validation'
import type { LabelItem } from './types'

interface Props {
  items: LabelItem[]
  onChange: (items: LabelItem[]) => void
  onFetchFnskus: (force?: boolean) => void
  fetchingFnskus: boolean
}

interface VariantResult {
  sku: string
  fnsku: string | null
  asin?: string | null
  productName: string | null
  variationAttributes: Record<string, string>
  imageUrl: string | null
}

type Tab = 'search' | 'paste' | 'scan'

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

  // Scan tab state — last scan feedback for the operator
  const [scanFeedback, setScanFeedback] = useState<{ kind: 'ok' | 'warn' | 'err'; msg: string } | null>(null)
  const [scanLooking, setScanLooking] = useState(false)

  // Multi-select for bulk delete — keyed by SKU (stable across reorders).
  const [selectedSet, setSelectedSet] = useState<Set<string>>(new Set())

  // Drop selections that point to SKUs no longer in the queue.
  useEffect(() => {
    setSelectedSet(prev => {
      const next = new Set<string>()
      for (const s of prev) if (items.some(it => it.sku === s)) next.add(s)
      return next.size === prev.size ? prev : next
    })
  }, [items])

  const toggleSelect = (sku: string) => {
    setSelectedSet(prev => {
      const next = new Set(prev)
      if (next.has(sku)) next.delete(sku)
      else next.add(sku)
      return next
    })
  }

  // Drag-to-reorder — order is preserved in PDF page order. Activation
  // constraint prevents accidental drags when clicking the handle.
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIdx = items.findIndex(it => it.sku === active.id)
    const newIdx = items.findIndex(it => it.sku === over.id)
    if (oldIdx < 0 || newIdx < 0) return
    onChange(arrayMove(items, oldIdx, newIdx))
  }

  const selectAll = () => setSelectedSet(new Set(items.map(it => it.sku)))
  const clearSelection = () => setSelectedSet(new Set())
  const deleteSelected = () => {
    if (selectedSet.size === 0) return
    const ok = window.confirm(
      `Delete ${selectedSet.size} selected SKU${selectedSet.size !== 1 ? 's' : ''}? This cannot be undone.`,
    )
    if (!ok) return
    onChange(items.filter(it => !selectedSet.has(it.sku)))
    setSelectedSet(new Set())
  }

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
        asin: p.asin ?? null,
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

  // Scan handler — resolves either a variant SKU or an FNSKU and adds to queue.
  // FNSKU shape (X + 9 alphanumeric) is treated as a direct FNSKU stub; anything
  // else is sent to the variant lookup. Increments quantity if already present.
  const handleScan = async (rawValue: string) => {
    const value = rawValue.trim()
    if (!value) return
    setScanFeedback(null)
    setScanLooking(true)

    // Direct FNSKU input (e.g. scanning an existing FNSKU label for re-print)
    if (/^X[A-Z0-9]{9}$/i.test(value)) {
      const upper = value.toUpperCase()
      const existing = items.findIndex(it => it.fnsku === upper)
      if (existing >= 0) {
        onChange(items.map((it, i) => i === existing ? { ...it, quantity: it.quantity + 1 } : it))
        setScanFeedback({ kind: 'ok', msg: `FNSKU ${upper} — qty +1` })
      } else {
        onChange([...items, {
          sku: upper,
          fnsku: upper,
          quantity: 1,
          productName: null,
          listingTitle: null,
          variationAttributes: {},
          imageUrl: null,
          manuallyEdited: true,
        }])
        setScanFeedback({ kind: 'warn', msg: `Added FNSKU ${upper} (no SKU lookup)` })
      }
      setScanLooking(false)
      return
    }

    // Variant SKU lookup via the same path as the search tab
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/variant-search?search=${encodeURIComponent(value)}&limit=2`,
      )
      const data = await res.json().catch(() => ({}))
      const hits: VariantResult[] = data?.variants ?? []
      const exact = hits.find(h => h.sku.toUpperCase() === value.toUpperCase()) ?? (hits.length === 1 ? hits[0] : null)
      if (!exact) {
        if (hits.length > 1) {
          setScanFeedback({ kind: 'warn', msg: `${hits.length} matches for "${value}" — refine search` })
        } else {
          setScanFeedback({ kind: 'err', msg: `No SKU match for "${value}"` })
        }
        setScanLooking(false)
        return
      }
      addVariant(exact)
      setScanFeedback({ kind: 'ok', msg: `Added ${exact.sku}` })
    } catch (e: any) {
      setScanFeedback({ kind: 'err', msg: e?.message ?? 'Scan lookup failed' })
    } finally {
      setScanLooking(false)
    }
  }

  const updateQty = (idx: number, delta: number) => {
    onChange(items.map((it, i) => i === idx ? { ...it, quantity: Math.max(1, it.quantity + delta) } : it))
  }

  const updateFnsku = (idx: number, val: string) => {
    // Typed entry locks the field — re-fetch from SP-API must not overwrite it.
    // Clearing the field (empty value) releases the lock so the next fetch can fill it.
    const trimmed = val.trim()
    onChange(items.map((it, i) => i === idx ? {
      ...it,
      fnsku: val,
      fnskuError: undefined,
      manuallyEdited: trimmed.length > 0,
    } : it))
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
          <ClipboardList size={11} /> Paste
        </button>
        <button
          onClick={() => setTab('scan')}
          className={`flex-1 h-9 text-xs font-medium inline-flex items-center justify-center gap-1 border-b-2 transition-colors ${tab === 'scan' ? 'border-violet-500 text-violet-700 dark:text-violet-300' : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
        >
          <ScanLine size={11} /> Scan
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
                const color  = pickAttr(attrs, 'color')
                const size   = pickAttr(attrs, 'size')
                const gender = pickAttr(attrs, 'gender')
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

      {/* Scan tab — USB scanner / camera */}
      {tab === 'scan' && (
        <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex flex-col gap-2">
          <p className="text-xs text-slate-500">Scan a SKU or FNSKU — USB scanner or camera mode.</p>
          <BarcodeScanInput
            onScan={handleScan}
            placeholder="Scan SKU or FNSKU…"
            label=""
            autoFocus
            disabled={scanLooking}
          />
          {scanFeedback && (
            <p className={`text-[11px] ${
              scanFeedback.kind === 'ok'   ? 'text-emerald-600 dark:text-emerald-400'
            : scanFeedback.kind === 'warn' ? 'text-amber-600 dark:text-amber-400'
                                           : 'text-red-600 dark:text-red-400'
            }`}>
              {scanFeedback.msg}
            </p>
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

      {/* Fetch FNSKUs + Clear all */}
      {items.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex flex-col gap-1.5">
          <button
            onClick={() => onFetchFnskus(true)}
            disabled={fetchingFnskus}
            className="w-full inline-flex items-center justify-center gap-1.5 h-7 text-xs rounded border border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/30 disabled:opacity-50"
          >
            {fetchingFnskus ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {fetchingFnskus ? 'Fetching from Amazon…' : 'Re-fetch all FNSKUs from Amazon'}
          </button>
          <button
            onClick={() => {
              const totalQty = items.reduce((s, it) => s + Math.max(1, it.quantity), 0)
              const ok = window.confirm(
                `Clear ${items.length} SKU${items.length !== 1 ? 's' : ''} (${totalQty.toLocaleString()} label${totalQty !== 1 ? 's' : ''})?\n\n` +
                `This cannot be undone.`,
              )
              if (!ok) return
              onChange([])
              try { localStorage.removeItem('fnsku-label-items') } catch {}
            }}
            className="w-full inline-flex items-center justify-center gap-1.5 h-6 text-xs rounded border border-red-200 dark:border-red-900 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
          >
            Clear all SKUs
          </button>
        </div>
      )}

      {/* Bulk selection bar — only visible when items exist */}
      {items.length > 0 && (
        <div className="px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 bg-slate-50 dark:bg-slate-900/60">
          {selectedSet.size === 0 ? (
            <>
              <button
                onClick={selectAll}
                className="text-[11px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                title="Select all SKUs (or use the per-row checkboxes)"
              >
                Select all
              </button>
              <span className="text-[11px] text-slate-300 dark:text-slate-700">·</span>
              <span className="text-[11px] text-slate-400 tabular-nums">{items.length} SKU{items.length !== 1 ? 's' : ''}</span>
            </>
          ) : (
            <>
              <span className="text-[11px] text-violet-700 dark:text-violet-300 font-medium tabular-nums">
                {selectedSet.size} selected
              </span>
              <div className="flex-1" />
              <button
                onClick={deleteSelected}
                className="inline-flex items-center gap-0.5 h-5 px-1.5 text-[11px] rounded border border-red-200 dark:border-red-900 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
              >
                <Trash2 size={10} /> Delete
              </button>
              <button
                onClick={clearSelection}
                className="text-[11px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}

      {/* Item list — drag-to-reorder (order = PDF page order) */}
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 && (
          <p className="text-xs text-slate-400 text-center mt-8 px-4 leading-relaxed">
            Search for variant SKUs above<br />or paste a list in bulk
          </p>
        )}
        <DndContext
          sensors={dndSensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={items.map(it => it.sku)} strategy={verticalListSortingStrategy}>
            {items.map((it, idx) => (
              <SortableItemRow
                key={it.sku}
                item={it}
                idx={idx}
                selected={selectedSet.has(it.sku)}
                onToggleSelect={() => toggleSelect(it.sku)}
                onRemove={() => remove(idx)}
                onUpdateFnsku={(v) => updateFnsku(idx, v)}
                onUpdateQty={(delta) => updateQty(idx, delta)}
                onSetQty={(v) => onChange(items.map((item, i) => i === idx ? { ...item, quantity: v } : item))}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  )
}

// ── Sortable row — wraps the existing per-item markup with drag handle. ────
interface SortableItemRowProps {
  item: LabelItem
  idx: number
  selected: boolean
  onToggleSelect: () => void
  onRemove: () => void
  onUpdateFnsku: (val: string) => void
  onUpdateQty: (delta: number) => void
  onSetQty: (val: number) => void
}

function SortableItemRow({ item: it, selected, onToggleSelect, onRemove, onUpdateFnsku, onUpdateQty, onSetQty }: SortableItemRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: it.sku })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: 'relative',
    zIndex: isDragging ? 10 : 'auto',
  }
  const attrs = it.variationAttributes ?? {}
  const color  = pickAttr(attrs, 'color')
  const size   = pickAttr(attrs, 'size')
  const gender = pickAttr(attrs, 'gender')
  const formatHint = fnskuFormatHint(it.fnsku)
  const showFormatWarn = !!it.fnsku && !!formatHint

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`px-3 py-2.5 border-b border-slate-100 dark:border-slate-800 last:border-0 transition-colors bg-white dark:bg-slate-900 ${
        selected ? 'bg-violet-50/60 dark:bg-violet-950/30' : ''
      }`}
    >
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Drag ${it.sku}`}
          title="Drag to reorder (changes PDF page order)"
          className="mt-1 shrink-0 text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400 cursor-grab active:cursor-grabbing focus:outline-none focus-visible:ring-1 focus-visible:ring-violet-500 rounded"
        >
          <GripVertical size={12} />
        </button>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="mt-1 shrink-0 accent-violet-600"
          aria-label={`Select ${it.sku}`}
          title="Select for bulk actions"
        />
        {it.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={it.imageUrl}
            alt=""
            className="w-9 h-9 rounded object-cover shrink-0 border border-slate-200 dark:border-slate-700"
          />
        ) : (
          <div className="w-9 h-9 rounded shrink-0 border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40" />
        )}
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
        <button onClick={onRemove} className="text-slate-400 hover:text-red-500 shrink-0 mt-0.5">
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
          {!it.fnskuError && showFormatWarn && (
            <span className="flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400" title={formatHint!}>
              <AlertTriangle size={9} /> {formatHint}
            </span>
          )}
        </div>
        <div className="relative flex items-center">
          <input
            value={it.fnsku}
            onChange={e => onUpdateFnsku(e.target.value)}
            placeholder={it.fnskuLoading ? 'Fetching…' : 'e.g. X0029S704D'}
            className={`w-full h-6 px-2 text-xs font-mono rounded border bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500 ${(it.fnskuError && !it.fnsku) || showFormatWarn ? 'border-amber-400 dark:border-amber-600' : 'border-slate-300 dark:border-slate-700'}`}
          />
          {it.fnskuLoading && <Loader2 size={11} className="absolute right-1.5 text-slate-400 animate-spin" />}
        </div>
      </div>

      {/* Qty control */}
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="text-xs text-slate-400">Copies:</span>
        <button onClick={() => onUpdateQty(-1)} className="h-5 w-5 flex items-center justify-center rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800">
          <Minus size={10} />
        </button>
        <input
          type="number"
          min={1}
          value={it.quantity}
          onChange={e => onSetQty(Math.max(1, parseInt(e.target.value) || 1))}
          className="w-12 h-5 px-1 text-xs text-center font-mono tabular-nums rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500"
        />
        <button onClick={() => onUpdateQty(1)} className="h-5 w-5 flex items-center justify-center rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800">
          <Plus size={10} />
        </button>
      </div>
    </div>
  )
}
