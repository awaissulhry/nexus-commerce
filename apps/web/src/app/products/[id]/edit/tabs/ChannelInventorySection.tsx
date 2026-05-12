'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, ArrowUpDown, ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────────────────

interface MarketInventory {
  marketplace: string
  channel: string
  listedQty: number | null
  buffer: number
  listingStatus: string
  lastSyncedAt: string | null
}

interface VariantInventory {
  variantId: string
  sku: string
  attributes: Record<string, string>
  physicalStock: number
  markets: MarketInventory[]
}

interface ChannelInventoryData {
  productId: string
  channel: string
  product: { physicalStock: number; markets: MarketInventory[] }
  variants: VariantInventory[]
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

type SortKey = 'variant' | 'market' | 'listed' | 'physical' | 'lastSynced'
type SortDir = 'asc' | 'desc'

// ── Main component ─────────────────────────────────────────────────────────

interface Props {
  productId: string
  isParent: boolean
  channel?: string
}

export default function ChannelInventorySection({ productId, isParent, channel = 'AMAZON' }: Props) {
  const backend = getBackendUrl()

  const [data, setData] = useState<ChannelInventoryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [sortKey, setSortKey] = useState<SortKey>('variant')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const fetch_ = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`${backend}/api/products/${productId}/channel-inventory?channel=${channel}`)
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

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const SortBtn = ({ col, children }: { col: SortKey; children: React.ReactNode }) => (
    <button type="button" onClick={() => toggleSort(col)}
      className="flex items-center gap-0.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 group">
      {children}
      <ArrowUpDown className={cn('w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity', sortKey === col && 'opacity-100 text-blue-500')} />
    </button>
  )

  if (loading) return (
    <div className="flex items-center gap-2 text-sm text-slate-400 py-4">
      <Loader2 className="w-4 h-4 animate-spin" /> Loading channel inventory…
    </div>
  )

  if (error) return (
    <div className="flex items-center gap-2 text-sm text-red-500 py-4">
      <AlertCircle className="w-4 h-4" />{error}
    </div>
  )

  if (!data) return null

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Channel inventory</h3>
          <Badge variant="default" size="sm">{channel}</Badge>
          <span className="text-xs text-slate-400">Listed qty syncs from flat file · physical stock from warehouse</span>
        </div>
        <button type="button" onClick={fetch_} className="p-1 text-slate-400 hover:text-slate-600 rounded">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
            <tr>
              {isParent && <th className="px-3 py-2 text-left w-8" />}
              {isParent && <th className="px-3 py-2 text-left"><SortBtn col="variant">Variant</SortBtn></th>}
              <th className="px-3 py-2 text-left"><SortBtn col="market">Market</SortBtn></th>
              <th className="px-3 py-2 text-left"><SortBtn col="listed">Listed qty</SortBtn></th>
              <th className="px-3 py-2 text-left"><SortBtn col="physical">Physical stock</SortBtn></th>
              <th className="px-3 py-2 text-left text-xs text-slate-400 font-medium">Buffer</th>
              <th className="px-3 py-2 text-left text-xs text-slate-400 font-medium">Status</th>
              <th className="px-3 py-2 text-left"><SortBtn col="lastSynced">Synced</SortBtn></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {isParent ? (
              data.variants.map((variant) => {
                const isCollapsed = collapsed.has(variant.variantId)
                const sortedMarkets = [...variant.markets].sort((a, b) => {
                  if (sortKey === 'market') return sortDir === 'asc' ? a.marketplace.localeCompare(b.marketplace) : b.marketplace.localeCompare(a.marketplace)
                  if (sortKey === 'listed') return sortDir === 'asc' ? (a.listedQty ?? 0) - (b.listedQty ?? 0) : (b.listedQty ?? 0) - (a.listedQty ?? 0)
                  if (sortKey === 'lastSynced') return sortDir === 'asc' ? (a.lastSyncedAt ?? '').localeCompare(b.lastSyncedAt ?? '') : (b.lastSyncedAt ?? '').localeCompare(a.lastSyncedAt ?? '')
                  return 0
                })
                return (
                  <>
                    <tr key={`${variant.variantId}-hdr`}
                      className="bg-slate-50 dark:bg-slate-800/30 hover:bg-slate-100 dark:hover:bg-slate-800/50 cursor-pointer"
                      onClick={() => setCollapsed((prev) => { const n = new Set(prev); if (n.has(variant.variantId)) n.delete(variant.variantId); else n.add(variant.variantId); return n })}>
                      <td className="px-3 py-2">
                        {isCollapsed ? <ChevronRight className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
                      </td>
                      <td className="px-3 py-2 font-medium text-slate-700 dark:text-slate-300 text-xs" colSpan={6}>
                        {attrLabel(variant.attributes)}
                        <span className="ml-2 font-normal text-slate-400 font-mono">{variant.sku}</span>
                        <span className="ml-3 text-slate-500 dark:text-slate-400 font-normal">
                          Physical: <strong>{variant.physicalStock}</strong>
                        </span>
                      </td>
                    </tr>
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
                        <td className="px-3 py-2 tabular-nums font-medium text-slate-700 dark:text-slate-300">
                          {m.listedQty ?? '—'}
                        </td>
                        <td className="px-3 py-2 tabular-nums text-slate-500">{variant.physicalStock}</td>
                        <td className="px-3 py-2 tabular-nums text-slate-400">{m.buffer}</td>
                        <td className="px-3 py-2">
                          <span className={cn('text-xs', STATUS_COLORS[m.listingStatus] ?? 'text-slate-400')}>{m.listingStatus}</span>
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-400">{fmtTime(m.lastSyncedAt)}</td>
                      </tr>
                    ))}
                  </>
                )
              })
            ) : (
              [...data.product.markets].sort((a, b) => {
                if (sortKey === 'market') return sortDir === 'asc' ? a.marketplace.localeCompare(b.marketplace) : b.marketplace.localeCompare(a.marketplace)
                if (sortKey === 'listed') return sortDir === 'asc' ? (a.listedQty ?? 0) - (b.listedQty ?? 0) : (b.listedQty ?? 0) - (a.listedQty ?? 0)
                if (sortKey === 'lastSynced') return sortDir === 'asc' ? (a.lastSyncedAt ?? '').localeCompare(b.lastSyncedAt ?? '') : (b.lastSyncedAt ?? '').localeCompare(a.lastSyncedAt ?? '')
                return 0
              }).map((m) => (
                <tr key={m.marketplace} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="px-3 py-2">
                    <span className={cn('px-1.5 py-0.5 rounded text-xs font-medium', MARKET_COLORS[m.marketplace] ?? 'bg-gray-100 text-gray-600')}>
                      {m.marketplace}
                    </span>
                  </td>
                  <td className="px-3 py-2 tabular-nums font-medium text-slate-700 dark:text-slate-300">
                    {m.listedQty ?? '—'}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-500">{data.product.physicalStock}</td>
                  <td className="px-3 py-2 tabular-nums text-slate-400">{m.buffer}</td>
                  <td className="px-3 py-2">
                    <span className={cn('text-xs', STATUS_COLORS[m.listingStatus] ?? 'text-slate-400')}>{m.listingStatus}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-400">{fmtTime(m.lastSyncedAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {(isParent ? data.variants.length === 0 : data.product.markets.length === 0) && (
          <div className="py-8 text-center text-sm text-slate-400">
            No channel listings yet — save the flat file for this product first.
          </div>
        )}
      </div>
    </div>
  )
}
