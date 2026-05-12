'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowUpDown, ChevronDown, ChevronRight, Copy, Loader2, Percent, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────────────────

interface MarketPricing {
  marketplace: string
  channel: string
  price: number | null
  salePrice: number | null
  listingStatus: string
  lastSyncedAt: string | null
  asin: string | null
  source: 'variant' | 'product'
}

interface VariantRow {
  variantId: string
  sku: string
  attributes: Record<string, string>
  basePrice: number | null
  markets: MarketPricing[]
}

interface ChannelPricingData {
  productId: string
  channel: string
  product: { markets: MarketPricing[] }
  variants: VariantRow[]
}

// ── Helpers ────────────────────────────────────────────────────────────────

const MARKET_COLORS: Record<string, string> = {
  IT: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  DE: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  FR: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  ES: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  UK: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: 'text-green-600', BUYABLE: 'text-green-600',
  INACTIVE: 'text-gray-400', DRAFT: 'text-gray-400',
  ERROR: 'text-red-500', SUPPRESSED: 'text-red-500',
}

function fmtTime(iso: string | null) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' +
      d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  } catch { return '—' }
}

function attrLabel(attrs: Record<string, string>) {
  return Object.entries(attrs).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'
}

type SortKey = 'variant' | 'market' | 'price' | 'salePrice' | 'lastSynced'
type SortDir = 'asc' | 'desc'

// ── Inline price cell ──────────────────────────────────────────────────────

function PriceCell({
  value, onSave, disabled,
}: { value: number | null; onSave: (v: number | null) => Promise<void>; disabled?: boolean }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function start() {
    if (disabled) return
    setDraft(value != null ? String(value) : '')
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  async function commit() {
    const parsed = draft.trim() === '' ? null : parseFloat(draft)
    if (parsed !== null && isNaN(parsed)) { setEditing(false); return }
    if (parsed === value) { setEditing(false); return }
    setSaving(true)
    await onSave(parsed)
    setSaving(false)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-xs text-slate-400">€</span>
        <input
          ref={inputRef}
          type="number"
          step="0.01"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
          className="w-20 px-1 py-0.5 text-xs border border-blue-400 rounded focus:outline-none"
          autoFocus
        />
        {saving && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={start}
      disabled={disabled}
      className={cn(
        'text-sm tabular-nums text-left w-full px-1 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors',
        disabled && 'cursor-default',
        value == null && 'text-slate-400 italic',
      )}
    >
      {value != null ? `€${value.toFixed(2)}` : '—'}
    </button>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

interface Props {
  productId: string
  isParent: boolean
  channel?: string
}

export default function ChannelPricingSection({ productId, isParent, channel = 'AMAZON' }: Props) {
  const backend = getBackendUrl()
  const { toast } = useToast()

  const [data, setData] = useState<ChannelPricingData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [sortKey, setSortKey] = useState<SortKey>('variant')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  // Bulk apply state
  const [bulkMode, setBulkMode] = useState<'none' | 'price' | 'pct' | 'copy'>('none')
  const [bulkMarket, setBulkMarket] = useState('IT')
  const [bulkValue, setBulkValue] = useState('')
  const [bulkSrcMarket, setBulkSrcMarket] = useState('IT')
  const [bulkDstMarket, setBulkDstMarket] = useState('DE')
  const [bulkApplying, setBulkApplying] = useState(false)

  const fetch_ = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`${backend}/api/products/${productId}/channel-pricing?channel=${channel}`)
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      setData(await res.json())
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [backend, productId, channel])

  useEffect(() => { void fetch_() }, [fetch_])

  // Re-fetch when flat file saves
  useInvalidationChannel('channel-pricing.updated', () => { void fetch_() })

  // Save a single price
  async function savePrice(variantId: string | null, marketplace: string, price: number | null, field: 'price' | 'salePrice' = 'price') {
    const res = await fetch(`${backend}/api/products/${productId}/channel-pricing`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: [{ variantId, marketplace, channel, [field]: price }] }),
    })
    if (!res.ok) { toast({ title: 'Save failed', tone: 'error' }); return }
    emitInvalidation({ type: 'channel-pricing.updated', id: productId })
    void fetch_()
  }

  // Bulk apply
  async function applyBulk() {
    if (!data) return
    setBulkApplying(true)
    try {
      let updates: any[] = []

      if (bulkMode === 'price') {
        const price = parseFloat(bulkValue)
        if (isNaN(price)) { toast({ title: 'Invalid price', tone: 'error' }); return }
        if (isParent) {
          updates = data.variants.map((v) => ({ variantId: v.variantId, marketplace: bulkMarket, channel, price }))
        } else {
          updates = [{ variantId: null, marketplace: bulkMarket, channel, price }]
        }
      } else if (bulkMode === 'pct') {
        const pct = parseFloat(bulkValue)
        if (isNaN(pct)) { toast({ title: 'Invalid %', tone: 'error' }); return }
        const factor = 1 + pct / 100
        if (isParent) {
          updates = data.variants.flatMap((v) =>
            v.markets.filter((m) => m.marketplace === bulkMarket && m.price != null).map((m) => ({
              variantId: v.variantId, marketplace: bulkMarket, channel, price: Math.round((m.price! * factor) * 100) / 100,
            })),
          )
        } else {
          const pm = data.product.markets.find((m) => m.marketplace === bulkMarket)
          if (pm?.price != null) updates = [{ variantId: null, marketplace: bulkMarket, channel, price: Math.round(pm.price * factor * 100) / 100 }]
        }
      } else if (bulkMode === 'copy') {
        if (isParent) {
          updates = data.variants.flatMap((v) => {
            const src = v.markets.find((m) => m.marketplace === bulkSrcMarket)
            return src?.price != null ? [{ variantId: v.variantId, marketplace: bulkDstMarket, channel, price: src.price }] : []
          })
        } else {
          const src = data.product.markets.find((m) => m.marketplace === bulkSrcMarket)
          if (src?.price != null) updates = [{ variantId: null, marketplace: bulkDstMarket, channel, price: src.price }]
        }
      }

      if (!updates.length) { toast({ title: 'Nothing to update', tone: 'error' }); return }

      const res = await fetch(`${backend}/api/products/${productId}/channel-pricing`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      })
      if (!res.ok) throw new Error('Bulk save failed')
      toast({ title: `Updated ${updates.length} price${updates.length !== 1 ? 's' : ''}` })
      emitInvalidation({ type: 'channel-pricing.updated', id: productId })
      void fetch_()
      setBulkMode('none'); setBulkValue('')
    } catch (e: any) {
      toast({ title: e.message ?? 'Bulk apply failed', tone: 'error' })
    } finally {
      setBulkApplying(false)
    }
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const allMarkets = useMemo(() => {
    if (!data) return []
    const s = new Set<string>()
    for (const v of data.variants) for (const m of v.markets) s.add(m.marketplace)
    for (const m of data.product.markets) s.add(m.marketplace)
    return [...s].sort()
  }, [data])

  const SortBtn = ({ col, children }: { col: SortKey; children: React.ReactNode }) => (
    <button type="button" onClick={() => toggleSort(col)}
      className="flex items-center gap-0.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 group">
      {children}
      <ArrowUpDown className={cn('w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity', sortKey === col && 'opacity-100 text-blue-500')} />
    </button>
  )

  if (loading) return (
    <div className="flex items-center gap-2 text-sm text-slate-400 py-4">
      <Loader2 className="w-4 h-4 animate-spin" /> Loading channel pricing…
    </div>
  )

  if (error) return (
    <div className="flex items-center gap-2 text-sm text-red-500 py-4">
      <AlertCircle className="w-4 h-4" />{error}
    </div>
  )

  if (!data) return null

  const rows = isParent ? data.variants : []

  return (
    <div className="mb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Channel pricing</h3>
          <Badge variant="default" size="sm">{channel}</Badge>
        </div>
        <div className="flex items-center gap-2">
          {/* Bulk toolbar */}
          <div className="flex items-center gap-1">
            {(['price', 'pct', 'copy'] as const).map((mode) => (
              <button key={mode} type="button"
                onClick={() => setBulkMode(bulkMode === mode ? 'none' : mode)}
                className={cn('px-2 py-1 text-xs rounded border transition-colors',
                  bulkMode === mode ? 'bg-blue-50 border-blue-400 text-blue-700 dark:bg-blue-900/30 dark:border-blue-600 dark:text-blue-300'
                    : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-400')}>
                {mode === 'price' && '€ Set price'}
                {mode === 'pct' && <><Percent className="w-3 h-3 inline mr-0.5" />Adjust %</>}
                {mode === 'copy' && <><Copy className="w-3 h-3 inline mr-0.5" />Copy market</>}
              </button>
            ))}
          </div>
          <button type="button" onClick={fetch_} className="p-1 text-slate-400 hover:text-slate-600 rounded">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Bulk panel */}
      {bulkMode !== 'none' && (
        <div className="mb-3 p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg flex items-center gap-3 flex-wrap text-sm">
          {(bulkMode === 'price' || bulkMode === 'pct') && (<>
            <span className="text-slate-600 dark:text-slate-300 text-xs font-medium">
              {bulkMode === 'price' ? 'Set price' : 'Adjust by %'} for all variants in
            </span>
            <select value={bulkMarket} onChange={(e) => setBulkMarket(e.target.value)}
              className="px-2 py-1 text-xs border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800">
              {allMarkets.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <div className="flex items-center gap-1">
              {bulkMode === 'price' && <span className="text-xs text-slate-400">€</span>}
              <input type="number" step={bulkMode === 'price' ? '0.01' : '1'} value={bulkValue}
                onChange={(e) => setBulkValue(e.target.value)}
                placeholder={bulkMode === 'price' ? '89.99' : '±5'}
                className="w-20 px-2 py-1 text-xs border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800" />
              {bulkMode === 'pct' && <span className="text-xs text-slate-400">%</span>}
            </div>
          </>)}
          {bulkMode === 'copy' && (<>
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Copy</span>
            <select value={bulkSrcMarket} onChange={(e) => setBulkSrcMarket(e.target.value)}
              className="px-2 py-1 text-xs border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800">
              {allMarkets.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <span className="text-xs text-slate-400">→</span>
            <select value={bulkDstMarket} onChange={(e) => setBulkDstMarket(e.target.value)}
              className="px-2 py-1 text-xs border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800">
              {allMarkets.filter((m) => m !== bulkSrcMarket).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </>)}
          <Button size="sm" loading={bulkApplying} onClick={applyBulk}>Apply</Button>
          <button type="button" onClick={() => { setBulkMode('none'); setBulkValue('') }}
            className="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
        </div>
      )}

      {/* Table */}
      {isParent ? (
        /* Variant-grouped view */
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="px-3 py-2 text-left w-8" />
                <th className="px-3 py-2 text-left"><SortBtn col="variant">Variant</SortBtn></th>
                <th className="px-3 py-2 text-left"><SortBtn col="market">Market</SortBtn></th>
                <th className="px-3 py-2 text-left"><SortBtn col="price">Price</SortBtn></th>
                <th className="px-3 py-2 text-left"><SortBtn col="salePrice">Sale</SortBtn></th>
                <th className="px-3 py-2 text-left text-xs text-slate-400 font-medium">Status</th>
                <th className="px-3 py-2 text-left"><SortBtn col="lastSynced">Synced</SortBtn></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((variant) => {
                const isCollapsed = collapsed.has(variant.variantId)
                const sortedMarkets = [...variant.markets].sort((a, b) => {
                  if (sortKey === 'market') return sortDir === 'asc' ? a.marketplace.localeCompare(b.marketplace) : b.marketplace.localeCompare(a.marketplace)
                  if (sortKey === 'price') return sortDir === 'asc' ? (a.price ?? 0) - (b.price ?? 0) : (b.price ?? 0) - (a.price ?? 0)
                  if (sortKey === 'salePrice') return sortDir === 'asc' ? (a.salePrice ?? 0) - (b.salePrice ?? 0) : (b.salePrice ?? 0) - (a.salePrice ?? 0)
                  if (sortKey === 'lastSynced') return sortDir === 'asc' ? (a.lastSyncedAt ?? '').localeCompare(b.lastSyncedAt ?? '') : (b.lastSyncedAt ?? '').localeCompare(a.lastSyncedAt ?? '')
                  return 0
                })
                return (
                  <>
                    {/* Variant header row */}
                    <tr key={`${variant.variantId}-hdr`}
                      className="bg-slate-50 dark:bg-slate-800/30 hover:bg-slate-100 dark:hover:bg-slate-800/50 cursor-pointer"
                      onClick={() => setCollapsed((prev) => { const n = new Set(prev); if (n.has(variant.variantId)) n.delete(variant.variantId); else n.add(variant.variantId); return n })}>
                      <td className="px-3 py-2">
                        {isCollapsed ? <ChevronRight className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
                      </td>
                      <td className="px-3 py-2 font-medium text-slate-700 dark:text-slate-300 text-xs" colSpan={6}>
                        {attrLabel(variant.attributes)}
                        <span className="ml-2 font-normal text-slate-400 font-mono">{variant.sku}</span>
                      </td>
                    </tr>
                    {/* Market rows */}
                    {!isCollapsed && sortedMarkets.map((m) => (
                      <tr key={`${variant.variantId}-${m.marketplace}`}
                        className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                        <td className="px-3 py-2" />
                        <td className="px-3 py-2" />
                        <td className="px-3 py-2">
                          <span className={cn('px-1.5 py-0.5 rounded text-xs font-medium', MARKET_COLORS[m.marketplace] ?? 'bg-gray-100 text-gray-600')}>
                            {m.marketplace}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <PriceCell
                            value={m.price}
                            onSave={(v) => savePrice(variant.variantId, m.marketplace, v)}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <PriceCell
                            value={m.salePrice}
                            onSave={(v) => savePrice(variant.variantId, m.marketplace, v, 'salePrice')}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <span className={cn('text-xs', STATUS_COLORS[m.listingStatus] ?? 'text-slate-400')}>
                            {m.listingStatus}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-400">{fmtTime(m.lastSyncedAt)}</td>
                      </tr>
                    ))}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        /* Flat product view (no variants) */
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="px-3 py-2 text-left"><SortBtn col="market">Market</SortBtn></th>
                <th className="px-3 py-2 text-left"><SortBtn col="price">Price</SortBtn></th>
                <th className="px-3 py-2 text-left"><SortBtn col="salePrice">Sale</SortBtn></th>
                <th className="px-3 py-2 text-left text-xs text-slate-400 font-medium">Status</th>
                <th className="px-3 py-2 text-left"><SortBtn col="lastSynced">Synced</SortBtn></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {[...data.product.markets].sort((a, b) => {
                if (sortKey === 'market') return sortDir === 'asc' ? a.marketplace.localeCompare(b.marketplace) : b.marketplace.localeCompare(a.marketplace)
                if (sortKey === 'price') return sortDir === 'asc' ? (a.price ?? 0) - (b.price ?? 0) : (b.price ?? 0) - (a.price ?? 0)
                if (sortKey === 'lastSynced') return sortDir === 'asc' ? (a.lastSyncedAt ?? '').localeCompare(b.lastSyncedAt ?? '') : (b.lastSyncedAt ?? '').localeCompare(a.lastSyncedAt ?? '')
                return 0
              }).map((m) => (
                <tr key={m.marketplace} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="px-3 py-2">
                    <span className={cn('px-1.5 py-0.5 rounded text-xs font-medium', MARKET_COLORS[m.marketplace] ?? 'bg-gray-100 text-gray-600')}>
                      {m.marketplace}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <PriceCell value={m.price} onSave={(v) => savePrice(null, m.marketplace, v)} />
                  </td>
                  <td className="px-3 py-2">
                    <PriceCell value={m.salePrice} onSave={(v) => savePrice(null, m.marketplace, v, 'salePrice')} />
                  </td>
                  <td className="px-3 py-2">
                    <span className={cn('text-xs', STATUS_COLORS[m.listingStatus] ?? 'text-slate-400')}>{m.listingStatus}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-400">{fmtTime(m.lastSyncedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.product.markets.length === 0 && (
            <div className="py-8 text-center text-sm text-slate-400">
              No channel listings yet — save the flat file for this product first.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
