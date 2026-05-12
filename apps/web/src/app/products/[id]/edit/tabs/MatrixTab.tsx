'use client'

/**
 * PE.2 — Matrix tab: combines variant management, master pricing,
 * and per-market channel pricing + inventory into one spreadsheet.
 *
 * Columns (per selected market):
 *   [axes] | SKU | Base price | [Market] price | [Market] listed qty | Physical | Status | ⋮
 *
 * Editing:
 *   • Base price / physical stock → PATCH /api/products/:childId (master cascade)
 *   • Channel price / listed qty  → PATCH /api/products/:id/channel-pricing
 *
 * Drag-fill: same Excel pattern as MatrixWorkspace — numeric fill handle.
 * Real-time: subscribes to 'product.updated' + 'channel-pricing.updated'.
 *            Emits both after every save so the flat file + pricing section
 *            pick up changes instantly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, ArrowUpDown, Check, ChevronDown, Copy, Layers,
  Loader2, Percent, Plus, RefreshCw, Trash2,
} from 'lucide-react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { cn } from '@/lib/utils'
import ChannelPricingSection from './ChannelPricingSection'
import ChannelInventorySection from './ChannelInventorySection'

// ── Constants ──────────────────────────────────────────────────────────────

const ALL_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK']
const MARKET_COLORS: Record<string, string> = {
  IT: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  DE: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  FR: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  ES: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  UK: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
}
// ── Types ──────────────────────────────────────────────────────────────────

interface ChildRow {
  id: string; sku: string; name?: string | null; basePrice: number | string | null
  totalStock: number | null; lowStockThreshold?: number | null; status?: string | null
  variantAttributes?: Record<string, unknown> | null
  variations?: Record<string, string> | null
}

interface MarketPricing {
  marketplace: string; price: number | null; salePrice: number | null
  listedQty: number | null; physicalStock: number; listingStatus: string
  lastSyncedAt: string | null
}

interface ChannelVariantRow {
  variantId: string; markets: MarketPricing[]
}

// Cell addressing — two kinds of editable cells
type MasterField = 'basePrice' | 'totalStock'
type ChanField   = 'price' | 'quantity'

interface MasterAddr { kind: 'master'; childId: string; field: MasterField }
interface ChanAddr   { kind: 'chan';   childId: string; field: ChanField; marketplace: string }
type CellAddr = MasterAddr | ChanAddr

function cellKey(a: CellAddr): string {
  return a.kind === 'master'
    ? `${a.childId}:${a.field}`
    : `${a.childId}:${a.field}:${a.marketplace}`
}

// ── Helpers ────────────────────────────────────────────────────────────────

function readNumber(v: unknown): number {
  const n = Number(v); return Number.isFinite(n) ? n : 0
}

function getAttr(child: ChildRow, axis: string): string | undefined {
  const raw =
    (child.variantAttributes as Record<string, unknown> | null)?.[axis] ??
    (child.variations as Record<string, string> | null)?.[axis]
  return raw == null ? undefined : String(raw)
}

// ── Editable cell ──────────────────────────────────────────────────────────

function EditCell({
  addr, value, active, onActivate, onCommit, onDeactivate,
  cellState, drag, onDragStart, onDragEnter,
  prefix = '', readOnly = false,
}: {
  addr: CellAddr; value: number; active: boolean
  onActivate: () => void; onCommit: (v: number) => void; onDeactivate: () => void
  cellState: Record<string, 'saving' | 'flash' | 'error'>
  drag: { source: CellAddr; targets: CellAddr[] } | null
  onDragStart: (addr: CellAddr, v: number) => void
  onDragEnter: (addr: CellAddr) => void
  prefix?: string; readOnly?: boolean
}) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const key = cellKey(addr)
  const state = cellState[key]
  const isTarget = drag?.targets.some((t) => cellKey(t) === key)
  const isSource = drag ? cellKey(drag.source) === key : false

  useEffect(() => {
    if (active) { setDraft(String(value)); setTimeout(() => inputRef.current?.select(), 0) }
  }, [active, value])

  if (readOnly) {
    return (
      <td className="px-2 py-1.5 text-right tabular-nums text-sm text-slate-500 dark:text-slate-400">
        {value === 0 ? '—' : value.toLocaleString()}
      </td>
    )
  }

  return (
    <td
      className={cn(
        'px-2 py-1.5 relative group/cell tabular-nums',
        isTarget && 'bg-blue-50 dark:bg-blue-950/30',
        isSource && 'ring-1 ring-inset ring-blue-400',
        state === 'error' && 'bg-red-50 dark:bg-red-950/30',
        state === 'flash' && 'bg-green-50 dark:bg-green-950/30',
      )}
      onMouseEnter={() => drag && onDragEnter(addr)}
    >
      {active ? (
        <div className="flex items-center gap-0.5">
          {prefix && <span className="text-xs text-slate-400">{prefix}</span>}
          <input
            ref={inputRef}
            type="number"
            step={prefix === '€' ? '0.01' : '1'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              const n = parseFloat(draft)
              if (!isNaN(n)) onCommit(n)
              else onDeactivate()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const n = parseFloat(draft)
                if (!isNaN(n)) onCommit(n); else onDeactivate()
              }
              if (e.key === 'Escape') onDeactivate()
            }}
            className="w-20 px-1 py-0.5 text-sm border border-blue-400 dark:border-blue-600 rounded bg-white dark:bg-slate-900 focus:outline-none"
            autoFocus
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={onActivate}
          className="w-full text-right text-sm tabular-nums hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          {state === 'saving' && <Loader2 className="w-3 h-3 inline animate-spin text-slate-400 mr-1" />}
          {state === 'flash'  && <Check className="w-3 h-3 inline text-green-600 mr-1" />}
          {state === 'error'  && <AlertCircle className="w-3 h-3 inline text-red-500 mr-1" />}
          {prefix}{value.toFixed(prefix === '€' ? 2 : 0)}
        </button>
      )}
      {/* Drag-fill handle */}
      {!active && !drag && (
        <div
          className="absolute bottom-0.5 right-0.5 w-2.5 h-2.5 bg-blue-400 rounded-sm opacity-0 group-hover/cell:opacity-100 cursor-s-resize"
          onMouseDown={(e) => { e.preventDefault(); onDragStart(addr, value) }}
        />
      )}
    </td>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

interface Props {
  product: any
  onDirtyChange: (n: number) => void
  discardSignal: number
}

export default function MatrixTab({ product }: Props) {
  const backend = getBackendUrl()

  // ── State ────────────────────────────────────────────────────────────
  const [children, setChildren]         = useState<ChildRow[]>([])
  const [channelData, setChannelData]   = useState<ChannelVariantRow[]>([])
  const [invData, setInvData]           = useState<ChannelVariantRow[]>([]) // reuse same shape for inventory
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState<string | null>(null)
  const [selectedMarket, setSelectedMarket] = useState('IT')
  const [activeEdit, setActiveEdit]     = useState<CellAddr | null>(null)
  const [cellState, setCellState]       = useState<Record<string, 'saving' | 'flash' | 'error'>>({})
  const [drag, setDrag]                 = useState<{ source: CellAddr; sourceValue: number; targets: CellAddr[] } | null>(null)

  // Variant management
  const [addOpen, setAddOpen]           = useState(false)
  const [editTarget, setEditTarget]     = useState<ChildRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ChildRow | null>(null)
  const [deleteListings, setDeleteListings] = useState<Record<string, number>>({})
  const [deleteLoading, setDeleteLoading] = useState(false)

  // Bulk
  const [bulkMode, setBulkMode]         = useState<'none' | 'price' | 'pct' | 'copy' | 'qty'>('none')
  const [bulkValue, setBulkValue]       = useState('')
  const [bulkSrc, setBulkSrc]           = useState('IT')
  const [bulkDst, setBulkDst]           = useState('DE')
  const [bulkApplying, setBulkApplying] = useState(false)
  const [sortBy, setSortBy]             = useState<string | null>(null)
  const [sortDir, setSortDir]           = useState<'asc' | 'desc'>('asc')

  // ── Fetch ─────────────────────────────────────────────────────────────
  const refetch = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [childRes, pricingRes, invRes] = await Promise.all([
        fetch(`${backend}/api/products/${product.id}/children`, { cache: 'no-store' }),
        fetch(`${backend}/api/products/${product.id}/channel-pricing?channel=AMAZON`),
        fetch(`${backend}/api/products/${product.id}/channel-inventory?channel=AMAZON`),
      ])
      if (!childRes.ok) throw new Error(`HTTP ${childRes.status}`)
      const childJson = await childRes.json()
      setChildren(childJson.children ?? [])

      if (pricingRes.ok) {
        const pd = await pricingRes.json()
        // Map to simpler shape for matrix use
        setChannelData((pd.variants ?? []).map((v: any) => ({
          variantId: v.variantId,
          markets: v.markets.map((m: any) => ({
            marketplace: m.marketplace, price: m.price, salePrice: m.salePrice,
            listedQty: null, physicalStock: 0, listingStatus: m.listingStatus, lastSyncedAt: m.lastSyncedAt,
          })),
        })))
      }
      if (invRes.ok) {
        const id_ = await invRes.json()
        setInvData((id_.variants ?? []).map((v: any) => ({
          variantId: v.variantId,
          markets: v.markets.map((m: any) => ({
            marketplace: m.marketplace, price: null, salePrice: null,
            listedQty: m.listedQty, physicalStock: v.physicalStock,
            listingStatus: m.listingStatus, lastSyncedAt: m.lastSyncedAt,
          })),
        })))
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [backend, product.id])

  useEffect(() => { void refetch() }, [refetch])

  useInvalidationChannel(['product.updated', 'channel-pricing.updated'], () => { void refetch() })

  // ── Helpers for channel data lookup ──────────────────────────────────
  function getChannelPrice(variantId: string, market: string): number {
    return channelData.find((v) => v.variantId === variantId)
      ?.markets.find((m) => m.marketplace === market)?.price ?? 0
  }
  function getListedQty(variantId: string, market: string): number {
    return invData.find((v) => v.variantId === variantId)
      ?.markets.find((m) => m.marketplace === market)?.listedQty ?? 0
  }
  function getPhysicalStock(variantId: string): number {
    return invData.find((v) => v.variantId === variantId)
      ?.markets[0]?.physicalStock ?? 0
  }
  function getListingStatus(variantId: string, market: string): string {
    return channelData.find((v) => v.variantId === variantId)
      ?.markets.find((m) => m.marketplace === market)?.listingStatus ?? '—'
  }

  // ── Optimistic cell state helpers ────────────────────────────────────
  function flash(key: string) {
    setCellState((s) => ({ ...s, [key]: 'flash' }))
    setTimeout(() => setCellState((s) => { const n = { ...s }; delete n[key]; return n }), 800)
  }
  function errCell(key: string) {
    setCellState((s) => ({ ...s, [key]: 'error' }))
    setTimeout(() => setCellState((s) => { const n = { ...s }; delete n[key]; return n }), 2500)
  }

  // ── Patch master cell (base price / total stock) ─────────────────────
  const patchMaster = useCallback(async (addr: MasterAddr, value: number) => {
    const key = cellKey(addr)
    const prev = children.find((c) => c.id === addr.childId)
    const prevVal = prev ? readNumber(prev[addr.field]) : 0
    setCellState((s) => ({ ...s, [key]: 'saving' }))
    setChildren((ch) => ch.map((c) => c.id === addr.childId ? { ...c, [addr.field]: value } : c))
    setActiveEdit(null)
    try {
      const res = await fetch(`${backend}/api/products/${addr.childId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [addr.field]: value }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      flash(key)
      emitInvalidation({ type: 'product.updated', meta: { productIds: [addr.childId] } })
    } catch (e: any) {
      setChildren((ch) => ch.map((c) => c.id === addr.childId ? { ...c, [addr.field]: prevVal } : c))
      errCell(key); setError(e.message)
    }
  }, [backend, children])

  // ── Patch channel cell (price / listed qty) ──────────────────────────
  const patchChannel = useCallback(async (addr: ChanAddr, value: number) => {
    const key = cellKey(addr)
    setCellState((s) => ({ ...s, [key]: 'saving' }))
    // Optimistic update
    if (addr.field === 'price') {
      setChannelData((prev) => prev.map((v) =>
        v.variantId !== addr.childId ? v : {
          ...v, markets: v.markets.map((m) =>
            m.marketplace !== addr.marketplace ? m : { ...m, price: value }
          )
        }
      ))
    } else {
      setInvData((prev) => prev.map((v) =>
        v.variantId !== addr.childId ? v : {
          ...v, markets: v.markets.map((m) =>
            m.marketplace !== addr.marketplace ? m : { ...m, listedQty: value }
          )
        }
      ))
    }
    setActiveEdit(null)
    try {
      const updateBody = addr.field === 'price'
        ? { variantId: addr.childId, marketplace: addr.marketplace, channel: 'AMAZON', price: value }
        : { variantId: addr.childId, marketplace: addr.marketplace, channel: 'AMAZON', quantity: value }
      const res = await fetch(`${backend}/api/products/${product.id}/channel-pricing`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: [updateBody] }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      flash(key)
      emitInvalidation({ type: 'channel-pricing.updated', id: product.id })
    } catch (e: any) {
      errCell(key); setError(e.message)
      void refetch() // revert by re-fetching
    }
  }, [backend, product.id, refetch])

  // ── Dispatch cell commit to correct patcher ──────────────────────────
  const commitCell = useCallback((addr: CellAddr, value: number) => {
    if (addr.kind === 'master') patchMaster(addr, value)
    else patchChannel(addr, value)
  }, [patchMaster, patchChannel])

  // ── Drag-fill ────────────────────────────────────────────────────────
  const startDrag = useCallback((addr: CellAddr, v: number) => {
    setDrag({ source: addr, sourceValue: v, targets: [] })
  }, [])

  const enterDrag = useCallback((addr: CellAddr) => {
    if (!drag) return
    // Only same column (same field + marketplace for channel cells)
    const same = addr.kind === drag.source.kind &&
      addr.kind === 'master'
        ? (addr as MasterAddr).field === (drag.source as MasterAddr).field
        : (addr as ChanAddr).field === (drag.source as ChanAddr).field &&
          (addr as ChanAddr).marketplace === (drag.source as ChanAddr).marketplace
    if (!same || cellKey(addr) === cellKey(drag.source)) return
    setDrag((d) => d ? { ...d, targets: [...d.targets.filter((t) => cellKey(t) !== cellKey(addr)), addr] } : null)
  }, [drag])

  useEffect(() => {
    if (!drag) return
    const up = async () => {
      if (drag.targets.length > 0) {
        await Promise.all(drag.targets.map((t) => commitCell(t, drag.sourceValue)))
      }
      setDrag(null)
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [drag, commitCell])

  // ── Axes + sorting ───────────────────────────────────────────────────
  const axes: string[] = useMemo(() => {
    if (Array.isArray(product.variationAxes) && product.variationAxes.length > 0) return product.variationAxes
    const seen = new Set<string>()
    for (const c of children) {
      const attrs = (c.variantAttributes as Record<string, unknown> | null) ?? (c.variations as Record<string, string> | null) ?? {}
      for (const k of Object.keys(attrs)) seen.add(k)
    }
    return Array.from(seen)
  }, [product.variationAxes, children])

  const sortedRows = useMemo(() => {
    if (!sortBy) return children
    return [...children].sort((a, b) => {
      let av = 0, bv = 0
      if (sortBy === 'basePrice') { av = readNumber(a.basePrice); bv = readNumber(b.basePrice) }
      else if (sortBy === 'totalStock') { av = readNumber(a.totalStock); bv = readNumber(b.totalStock) }
      else if (sortBy.startsWith('cp:')) { const mp = sortBy.slice(3); av = getChannelPrice(a.id, mp); bv = getChannelPrice(b.id, mp) }
      else if (sortBy.startsWith('lq:')) { const mp = sortBy.slice(3); av = getListedQty(a.id, mp); bv = getListedQty(b.id, mp) }
      else { av = String(getAttr(a, sortBy) ?? '').localeCompare(String(getAttr(b, sortBy) ?? '')); return sortDir === 'asc' ? av : -av }
      return sortDir === 'asc' ? av - bv : bv - av
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children, channelData, invData, sortBy, sortDir, selectedMarket])

  function toggleSort(col: string) {
    if (sortBy === col) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortBy(col); setSortDir('asc') }
  }

  // ── Bulk apply ───────────────────────────────────────────────────────
  async function applyBulk() {
    setBulkApplying(true)
    try {
      const updates: any[] = []
      if (bulkMode === 'price') {
        const price = parseFloat(bulkValue); if (isNaN(price)) return
        for (const c of children) updates.push({ variantId: c.id, marketplace: selectedMarket, channel: 'AMAZON', price })
      } else if (bulkMode === 'qty') {
        const qty = parseInt(bulkValue, 10); if (isNaN(qty)) return
        for (const c of children) updates.push({ variantId: c.id, marketplace: selectedMarket, channel: 'AMAZON', quantity: qty })
      } else if (bulkMode === 'pct') {
        const pct = parseFloat(bulkValue); if (isNaN(pct)) return
        const factor = 1 + pct / 100
        for (const c of children) {
          const cur = getChannelPrice(c.id, selectedMarket)
          if (cur) updates.push({ variantId: c.id, marketplace: selectedMarket, channel: 'AMAZON', price: Math.round(cur * factor * 100) / 100 })
        }
      } else if (bulkMode === 'copy') {
        for (const c of children) {
          const src = getChannelPrice(c.id, bulkSrc)
          if (src) updates.push({ variantId: c.id, marketplace: bulkDst, channel: 'AMAZON', price: src })
        }
      }
      if (!updates.length) return
      const res = await fetch(`${backend}/api/products/${product.id}/channel-pricing`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      })
      if (!res.ok) throw new Error('Bulk save failed')
      emitInvalidation({ type: 'channel-pricing.updated', id: product.id })
      void refetch()
      setBulkMode('none'); setBulkValue('')
    } finally {
      setBulkApplying(false)
    }
  }

  // ── Delete variant ───────────────────────────────────────────────────
  async function openDelete(child: ChildRow) {
    setDeleteTarget(child); setDeleteLoading(true)
    try {
      const res = await fetch(`${backend}/api/products/${child.id}/all-listings`)
      const d = await res.json()
      setDeleteListings(d.channelCounts ?? {})
    } catch { setDeleteListings({}) }
    finally { setDeleteLoading(false) }
  }
  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleteLoading(true)
    try {
      await fetch(`${backend}/api/catalog/products/${product.id}/children/${deleteTarget.id}`, { method: 'DELETE' })
      setChildren((ch) => ch.filter((c) => c.id !== deleteTarget.id))
      setDeleteTarget(null)
      emitInvalidation({ type: 'product.updated', meta: { productIds: [deleteTarget.id] } })
    } finally {
      setDeleteLoading(false)
    }
  }

  // ── Sort header button ────────────────────────────────────────────────
  function SortTh({ col, children: label, className }: { col: string; children: React.ReactNode; className?: string }) {
    return (
      <th onClick={() => toggleSort(col)}
        className={cn('px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 select-none whitespace-nowrap', className)}>
        <span className="flex items-center gap-0.5">
          {label}
          <ArrowUpDown className={cn('w-3 h-3 opacity-30', sortBy === col && 'opacity-100 text-blue-500')} />
        </span>
      </th>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────

  // Non-parent products have no variant grid — show the channel
  // pricing + inventory sections which handle their own fetching.
  if (!product.isParent) {
    return (
      <div className="space-y-4">
        <ChannelPricingSection productId={product.id} isParent={false} />
        <ChannelInventorySection productId={product.id} isParent={false} />
      </div>
    )
  }

  if (loading) return (
    <div className="flex items-center gap-2 text-sm text-slate-400 py-8 px-4">
      <Loader2 className="w-4 h-4 animate-spin" /> Loading matrix…
    </div>
  )

  return (
    <div className="space-y-3">
      {/* Stats strip */}
      <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400 flex-wrap">
        <span className="flex items-center gap-1"><Layers className="w-3.5 h-3.5" />{axes.join(' × ') || 'No axes'}</span>
        <span className="text-slate-300 dark:text-slate-600">·</span>
        <span>{children.length} variants</span>
        <span className="text-slate-300 dark:text-slate-600">·</span>
        <span>{children.reduce((s, c) => s + readNumber(c.totalStock), 0).toLocaleString()} physical</span>
      </div>

      {error && (
        <div className="border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-sm text-rose-700 dark:text-rose-300 flex gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />{error}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Market pills */}
        <div className="flex gap-1">
          {ALL_MARKETS.map((mp) => (
            <button key={mp} type="button" onClick={() => setSelectedMarket(mp)}
              className={cn('px-2.5 py-1 text-xs font-medium rounded border transition-colors',
                selectedMarket === mp
                  ? MARKET_COLORS[mp] + ' border-transparent'
                  : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-400')}>
              {mp}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-slate-200 dark:bg-slate-700" />

        {/* Bulk action buttons */}
        {(['price', 'qty', 'pct', 'copy'] as const).map((mode) => (
          <button key={mode} type="button" onClick={() => setBulkMode(bulkMode === mode ? 'none' : mode)}
            className={cn('px-2 py-1 text-xs rounded border transition-colors',
              bulkMode === mode ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-400 text-blue-700 dark:text-blue-300'
                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 hover:border-slate-400')}>
            {mode === 'price' && `€ Set ${selectedMarket} price`}
            {mode === 'qty'   && `# Set ${selectedMarket} qty`}
            {mode === 'pct'   && <><Percent className="w-3 h-3 inline mr-0.5" />Adjust %</>}
            {mode === 'copy'  && <><Copy className="w-3 h-3 inline mr-0.5" />Copy market</>}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => void refetch()} className="p-1.5 text-slate-400 hover:text-slate-600 rounded border border-slate-200 dark:border-slate-700">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <Button size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setAddOpen(true)}>
            Add variant
          </Button>
        </div>
      </div>

      {/* Bulk panel */}
      {bulkMode !== 'none' && (
        <div className="flex items-center gap-3 px-3 py-2 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg text-sm flex-wrap">
          {(bulkMode === 'price' || bulkMode === 'qty') && (<>
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
              {bulkMode === 'price' ? `Set price for all variants on ${selectedMarket}` : `Set listed qty for all variants on ${selectedMarket}`}
            </span>
            <div className="flex items-center gap-1">
              {bulkMode === 'price' && <span className="text-xs text-slate-400">€</span>}
              <input type="number" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}
                placeholder={bulkMode === 'price' ? '89.99' : '50'}
                className="w-24 px-2 py-1 text-xs border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800" />
            </div>
          </>)}
          {bulkMode === 'pct' && (<>
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Adjust {selectedMarket} prices by</span>
            <div className="flex items-center gap-1">
              <input type="number" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)} placeholder="±5"
                className="w-16 px-2 py-1 text-xs border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800" />
              <span className="text-xs text-slate-400">%</span>
            </div>
          </>)}
          {bulkMode === 'copy' && (<>
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Copy prices from</span>
            <select value={bulkSrc} onChange={(e) => setBulkSrc(e.target.value)} className="px-2 py-1 text-xs border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800">
              {ALL_MARKETS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <span className="text-xs text-slate-400">→</span>
            <select value={bulkDst} onChange={(e) => setBulkDst(e.target.value)} className="px-2 py-1 text-xs border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800">
              {ALL_MARKETS.filter((m) => m !== bulkSrc).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </>)}
          <Button size="sm" loading={bulkApplying} onClick={applyBulk}>Apply</Button>
          <button type="button" onClick={() => { setBulkMode('none'); setBulkValue('') }} className="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
        </div>
      )}

      {/* Grid */}
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700 sticky top-0">
            <tr>
              {axes.map((ax) => <SortTh key={ax} col={ax}>{ax}</SortTh>)}
              <SortTh col="sku">SKU</SortTh>
              <SortTh col="basePrice" className="text-right">Base price</SortTh>
              <SortTh col={`cp:${selectedMarket}`} className="text-right">
                <span className={cn('px-1 rounded text-xs', MARKET_COLORS[selectedMarket])}>
                  {selectedMarket}
                </span> price
              </SortTh>
              <SortTh col={`lq:${selectedMarket}`} className="text-right">Listed qty</SortTh>
              <th className="px-2 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">Physical</th>
              <th className="px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">Status</th>
              <th className="px-2 py-2 w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {sortedRows.length === 0 && (
              <tr><td colSpan={axes.length + 7} className="py-10 text-center text-sm text-slate-400">
                No variants yet. Click "Add variant" to create the first one.
              </td></tr>
            )}
            {sortedRows.map((child) => {
              const basePriceAddr: MasterAddr = { kind: 'master', childId: child.id, field: 'basePrice' }
              const chanPriceAddr: ChanAddr   = { kind: 'chan', childId: child.id, field: 'price', marketplace: selectedMarket }
              const listedQtyAddr: ChanAddr   = { kind: 'chan', childId: child.id, field: 'quantity', marketplace: selectedMarket }
              const isActiveMaster = activeEdit ? cellKey(activeEdit) === cellKey(basePriceAddr) : false
              const isActiveChanP  = activeEdit ? cellKey(activeEdit) === cellKey(chanPriceAddr) : false
              const isActiveChanQ  = activeEdit ? cellKey(activeEdit) === cellKey(listedQtyAddr) : false
              const status = getListingStatus(child.id, selectedMarket)
              return (
                <tr key={child.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 group/row">
                  {axes.map((ax) => (
                    <td key={ax} className="px-2 py-1.5 text-sm font-medium text-slate-700 dark:text-slate-300 whitespace-nowrap">
                      {getAttr(child, ax) ?? <span className="text-slate-300">—</span>}
                    </td>
                  ))}
                  <td className="px-2 py-1.5 font-mono text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">{child.sku}</td>
                  <EditCell
                    addr={basePriceAddr} value={readNumber(child.basePrice)} prefix="€"
                    active={isActiveMaster}
                    onActivate={() => setActiveEdit(basePriceAddr)}
                    onCommit={(v) => commitCell(basePriceAddr, v)}
                    onDeactivate={() => setActiveEdit(null)}
                    cellState={cellState} drag={drag}
                    onDragStart={startDrag} onDragEnter={enterDrag}
                  />
                  <EditCell
                    addr={chanPriceAddr} value={getChannelPrice(child.id, selectedMarket)} prefix="€"
                    active={isActiveChanP}
                    onActivate={() => setActiveEdit(chanPriceAddr)}
                    onCommit={(v) => commitCell(chanPriceAddr, v)}
                    onDeactivate={() => setActiveEdit(null)}
                    cellState={cellState} drag={drag}
                    onDragStart={startDrag} onDragEnter={enterDrag}
                  />
                  <EditCell
                    addr={listedQtyAddr} value={getListedQty(child.id, selectedMarket)}
                    active={isActiveChanQ}
                    onActivate={() => setActiveEdit(listedQtyAddr)}
                    onCommit={(v) => commitCell(listedQtyAddr, v)}
                    onDeactivate={() => setActiveEdit(null)}
                    cellState={cellState} drag={drag}
                    onDragStart={startDrag} onDragEnter={enterDrag}
                  />
                  <EditCell
                    addr={{ kind: 'master', childId: child.id, field: 'totalStock' }}
                    value={getPhysicalStock(child.id)} readOnly
                    active={false} onActivate={() => {}} onCommit={() => {}} onDeactivate={() => {}}
                    cellState={cellState} drag={drag}
                    onDragStart={startDrag} onDragEnter={enterDrag}
                  />
                  <td className="px-2 py-1.5">
                    <span className={cn('text-xs',
                      (status === 'ACTIVE' || status === 'BUYABLE') && 'text-green-600',
                      (status === 'INACTIVE' || status === 'DRAFT' || status === '—') && 'text-gray-400',
                      (status === 'ERROR' || status === 'SUPPRESSED') && 'text-red-500',
                    )}>{status}</span>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity">
                      <button type="button" onClick={() => setEditTarget(child)}
                        className="p-1 text-slate-400 hover:text-slate-600 rounded">
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                      <button type="button" onClick={() => openDelete(child)}
                        className="p-1 text-slate-400 hover:text-red-500 rounded">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400 dark:text-slate-500">
        Click any price or quantity cell to edit. Drag the blue handle to fill down a column.
        Base price cascades to all channel listings. Channel price + listed qty update per-market only.
      </p>

      {/* Modals */}
      {(addOpen || editTarget) && (
        <VariantFormModal
          mode={addOpen ? 'create' : 'edit'}
          parent={product}
          variationAxes={axes}
          existing={children}
          initial={editTarget ?? undefined}
          onClose={() => { setAddOpen(false); setEditTarget(null) }}
          onSaved={async () => { setAddOpen(false); setEditTarget(null); await refetch(); emitInvalidation({ type: 'product.updated', id: product.id }) }}
          backend={backend}
        />
      )}
      {deleteTarget && (
        <DeleteConfirmModal
          child={deleteTarget}
          listings={deleteListings}
          loading={deleteLoading}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  )
}

// ── VariantFormModal ───────────────────────────────────────────────────────

function VariantFormModal({
  mode, parent, variationAxes, existing, initial, onClose, onSaved, backend,
}: {
  mode: 'create' | 'edit'; parent: any; variationAxes: string[]
  existing: ChildRow[]; initial?: ChildRow; onClose: () => void
  onSaved: () => Promise<void>; backend: string
}) {
  const [sku, setSku] = useState(initial?.sku ?? '')
  const [name, setName] = useState((initial as any)?.name ?? '')
  const [basePrice, setBasePrice] = useState(initial?.basePrice != null ? String(initial.basePrice) : '')
  const [axisValues, setAxisValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    if (initial) for (const ax of variationAxes) { const v = getAttr(initial, ax); if (v) out[ax] = v }
    return out
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idKey = useRef(`vc:${Date.now()}`)

  const existingSkus = new Set(existing.filter((c) => c.id !== initial?.id).map((c) => c.sku))
  const skuTrimmed = sku.trim()
  const isDuplicateSku = !!skuTrimmed && existingSkus.has(skuTrimmed)
  const canSave = !!skuTrimmed && !!name.trim() && !isDuplicateSku && !saving

  async function handleSubmit() {
    if (!canSave) return
    setSaving(true); setError(null)
    try {
      const variantAttrs: Record<string, string> = { ...axisValues }
      if (mode === 'create') {
        await fetch(`${backend}/api/catalog/products/${parent.id}/children`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idKey.current },
          body: JSON.stringify({ sku: skuTrimmed, name: name.trim(), basePrice: parseFloat(basePrice) || 0, variantAttributes: variantAttrs }),
        })
      } else if (initial) {
        await Promise.all([
          fetch(`${backend}/api/products/bulk`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [initial.id], changes: { sku: skuTrimmed, name: name.trim(), basePrice: parseFloat(basePrice) || 0 } }),
          }),
          fetch(`${backend}/api/catalog/products/${initial.id}/variant-attributes`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ variantAttributes: variantAttrs }),
          }),
        ])
      }
      await onSaved()
    } catch (e: any) {
      setError(e.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={mode === 'create' ? 'Add variant' : 'Edit variant'} onClose={onClose} open>
      <div className="space-y-3">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Input label="SKU" value={sku} onChange={(e) => setSku(e.target.value)} mono
          error={isDuplicateSku ? 'SKU already exists' : undefined} />
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input label="Base price" type="number" value={basePrice} onChange={(e) => setBasePrice(e.target.value)} />
        {variationAxes.map((ax) => (
          <Input key={ax} label={ax} value={axisValues[ax] ?? ''} onChange={(e) => setAxisValues((p) => ({ ...p, [ax]: e.target.value }))} />
        ))}
      </div>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!canSave} loading={saving} onClick={handleSubmit}>
          {mode === 'create' ? 'Add variant' : 'Save'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// ── DeleteConfirmModal ─────────────────────────────────────────────────────

function DeleteConfirmModal({ child, listings, loading, onCancel, onConfirm }: {
  child: ChildRow; listings: Record<string, number>; loading: boolean
  onCancel: () => void; onConfirm: () => Promise<void>
}) {
  const totalListings = Object.values(listings).reduce((a, b) => a + b, 0)
  return (
    <Modal title="Delete variant" onClose={onCancel} open>
      <div className="space-y-3">
        <p className="text-sm text-slate-700 dark:text-slate-300">
          Delete variant <span className="font-mono font-medium">{child.sku}</span>?
        </p>
        {totalListings > 0 && (
          <div className="border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 rounded-md px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            <AlertCircle className="w-3.5 h-3.5 inline mr-1" />
            This will also delete {totalListings} channel listing{totalListings !== 1 ? 's' : ''} across{' '}
            {Object.entries(listings).filter(([, n]) => n > 0).map(([ch]) => ch).join(', ')}.
          </div>
        )}
        <p className="text-sm text-slate-500">This action cannot be undone.</p>
      </div>
      <ModalFooter>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant="danger" loading={loading} onClick={onConfirm}>Delete</Button>
      </ModalFooter>
    </Modal>
  )
}
