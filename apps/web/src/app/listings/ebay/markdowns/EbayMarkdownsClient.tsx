'use client'

// C.17 — eBay markdown manager.
//
// CRUD UI on top of EbayMarkdown (C.14 schema). Mirror of the campaign
// manager pattern (C.16): list, create modal, status transitions,
// honest "eBay push pending" banner.
//
// G.4 — table replaced with SharedVirtualizedGrid so column-resize,
// keyboard nav, density, and all future GridLens features apply here
// automatically.

import { useState, useMemo, useEffect, useCallback } from 'react'
import { Plus, Square, Trash2, AlertCircle, Tag, Repeat, MessageCircle, AlignJustify, Menu as MenuIcon, Equal } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { COUNTRY_NAMES } from '@/lib/country-names'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { usePolledList } from '@/lib/sync/use-polled-list'
import { VirtualizedGrid, GridFooter } from '@/app/_shared/grid-lens'
import type { GridLensColumn, GridLensRow } from '@/app/_shared/grid-lens'
import { type Density, DENSITY_CELL_CLASS } from '@/lib/products/theme'

// ── Constants ────────────────────────────────────────────────────────

const EBAY_MARKET_CODES = ['IT', 'DE', 'ES', 'FR', 'GB']

const MARKDOWN_COLUMNS: GridLensColumn[] = [
  { key: 'listing',  label: 'Listing',  subLabel: 'SKU · Name',    width: 280 },
  { key: 'market',   label: 'Market',   subLabel: 'Marketplace',   width: 90  },
  { key: 'discount', label: 'Discount', subLabel: 'Type · Value',  width: 130 },
  { key: 'original', label: 'Original', subLabel: 'Price',         width: 90  },
  { key: 'sale',     label: 'Sale',     subLabel: 'Markdown price',width: 110 },
  { key: 'window',   label: 'Window',   subLabel: 'Start → End',   width: 190 },
  { key: 'status',   label: 'Status',   subLabel: 'State',         width: 110 },
  { key: 'actions',  label: '',                                     width: 90  },
]

const MARKDOWN_SORT_KEYS: Record<string, string> = {
  listing: 'listing', market: 'market', status: 'status',
  original: 'original', sale: 'sale',
}

const STORAGE_KEY = 'ebay-markdowns'
const _EMPTY_SET = new Set<string>()
const _EMPTY_MAP = {}
const _NOOP = () => {}

// ── Types ─────────────────────────────────────────────────────────────

interface EbayMarkdown {
  id: string
  channelListingId: string
  externalPromotionId: string | null
  discountType: 'PERCENTAGE' | 'FIXED_PRICE'
  discountValue: number
  originalPrice: number
  markdownPrice: number
  currency: string
  status: 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'ENDED' | 'CANCELLED' | 'FAILED'
  startDate: string
  endDate: string | null
  lastSyncedAt: string | null
  lastSyncStatus: string | null
  lastSyncError: string | null
  listing: {
    id: string
    marketplace: string
    externalListingId: string | null
    listingStatus: string
    product: { id: string; sku: string; name: string }
  }
  createdAt: string
  updatedAt: string
}

interface ListingRow {
  id: string
  channel: string
  marketplace: string
  product: { sku: string; name: string }
  price: number | null
}

type MarkdownRow = EbayMarkdown & GridLensRow

const STATUS_TONE: Record<string, string> = {
  DRAFT:     'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700',
  SCHEDULED: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900',
  ACTIVE:    'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
  ENDED:     'bg-slate-50 dark:bg-slate-800 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-700',
  CANCELLED: 'bg-slate-50 dark:bg-slate-800 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-700',
  FAILED:    'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900',
}

// ── Component ─────────────────────────────────────────────────────────

export default function EbayMarkdownsClient() {
  const [marketplaceFilter, setMarketplaceFilter] = useState<string>('')
  const [statusFilter, setStatusFilter]           = useState<string>('')
  const [createOpen, setCreateOpen]               = useState(false)
  const [selected, setSelected]                   = useState<Set<string>>(new Set())
  const [sortBy, setSortBy]                       = useState('listing')
  const [density, setDensity]                     = useState<Density>(() => {
    try { return (localStorage.getItem(`${STORAGE_KEY}.density`) as Density) ?? 'comfortable' } catch { return 'comfortable' }
  })
  const { toast } = useToast()
  const askConfirm = useConfirm()

  useEffect(() => {
    const country = marketplaceFilter ? (COUNTRY_NAMES[marketplaceFilter.replace('EBAY_', '')] ?? marketplaceFilter) : null
    document.title = country ? `eBay Markdowns · ${country}` : 'eBay Markdowns · Sale Events'
  }, [marketplaceFilter])

  useEffect(() => {
    try { localStorage.setItem(`${STORAGE_KEY}.density`, density) } catch {}
  }, [density])

  const url = useMemo(() => {
    const qs = new URLSearchParams()
    if (statusFilter) qs.set('status', statusFilter)
    return `/api/listings/ebay/markdowns?${qs.toString()}`
  }, [statusFilter])

  const { data, loading, error, refetch } = usePolledList<{ markdowns: EbayMarkdown[] }>({
    url,
    intervalMs: 30_000,
  })

  const allMarkdowns = data?.markdowns ?? []

  // Client-side marketplace filter + sort
  const rows = useMemo((): MarkdownRow[] => {
    const filtered = marketplaceFilter
      ? allMarkdowns.filter(m => m.listing.marketplace === marketplaceFilter)
      : allMarkdowns
    const base = filtered.map(m => ({ ...m, isParent: false as const, childCount: 0, parentId: null }))
    const [key, dir] = sortBy.endsWith('-asc') ? [sortBy.slice(0, -4), 'asc'] : [sortBy, 'desc']
    return [...base].sort((a, b) => {
      let av: any, bv: any
      switch (key) {
        case 'listing':  av = a.listing.product.name; bv = b.listing.product.name; break
        case 'market':   av = a.listing.marketplace;  bv = b.listing.marketplace;  break
        case 'status':   av = a.status;               bv = b.status;               break
        case 'original': av = a.originalPrice;        bv = b.originalPrice;        break
        case 'sale':     av = a.markdownPrice;        bv = b.markdownPrice;        break
        default: return 0
      }
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : ((av ?? 0) - (bv ?? 0))
      return dir === 'asc' ? cmp : -cmp
    })
  }, [allMarkdowns, marketplaceFilter, sortBy])

  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.id))
  const cellPad = DENSITY_CELL_CLASS[density] ?? DENSITY_CELL_CLASS.comfortable

  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }, [])

  const toggleSelectAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(rows.map(r => r.id)))
  }, [allSelected, rows])

  const onSort = useCallback((key: string) => {
    setSortBy(prev => {
      const base = key.replace(/-asc$/, '')
      if (prev === base) return `${base}-asc`
      if (prev === `${base}-asc`) return base
      return base
    })
  }, [])

  const transition = async (id: string, nextStatus: 'CANCELLED' | 'ENDED') => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/ebay/markdowns/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      toast.success(`Markdown ${nextStatus.toLowerCase()}`)
      refetch()
    } catch (e: any) { toast.error(`Update failed: ${e?.message ?? String(e)}`) }
  }

  const remove = async (m: EbayMarkdown) => {
    const ok = await askConfirm({
      title: `Delete markdown for "${m.listing.product.sku}"?`,
      description: 'DRAFT markdowns are removed permanently. Active markdowns must be cancelled or ended via the action buttons instead.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/ebay/markdowns/${m.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      toast.success('Markdown deleted')
      refetch()
    } catch (e: any) { toast.error(`Delete failed: ${e?.message ?? String(e)}`) }
  }

  const renderCell = useCallback((row: MarkdownRow, colKey: string) => {
    switch (colKey) {
      case 'listing':
        return (
          <div>
            <div className="font-medium text-slate-900 dark:text-slate-100 truncate">{row.listing.product.name}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">{row.listing.product.sku}</div>
          </div>
        )
      case 'market':
        return <span className="text-sm font-mono text-slate-600 dark:text-slate-400">{row.listing.marketplace.replace('EBAY_', '')}</span>
      case 'discount':
        return row.discountType === 'PERCENTAGE' ? (
          <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300">−{row.discountValue}%</span>
        ) : (
          <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300">{row.discountValue.toFixed(2)} {row.currency}</span>
        )
      case 'original':
        return <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400">{row.originalPrice.toFixed(2)}</span>
      case 'sale':
        return <span className="text-sm tabular-nums font-semibold text-slate-900 dark:text-slate-100">{row.markdownPrice.toFixed(2)} {row.currency}</span>
      case 'window':
        return (
          <span className="text-sm text-slate-600 dark:text-slate-400 whitespace-nowrap">
            {new Date(row.startDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
            {' → '}
            {row.endDate ? new Date(row.endDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'open'}
          </span>
        )
      case 'status':
        return (
          <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${STATUS_TONE[row.status] ?? ''}`}>
            {row.status}
          </span>
        )
      case 'actions':
        return (
          <div className="flex items-center gap-1 justify-end">
            {(row.status === 'DRAFT' || row.status === 'SCHEDULED') && (
              <button onClick={() => transition(row.id, 'CANCELLED')} title="Cancel" aria-label={`Cancel markdown for "${row.listing.product.sku}"`}
                className="h-7 w-7 inline-flex items-center justify-center text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded focus:outline-none focus:ring-2 focus:ring-slate-300">
                <Square size={12} />
              </button>
            )}
            {row.status === 'ACTIVE' && (
              <button onClick={() => transition(row.id, 'ENDED')} title="End now" aria-label={`End markdown now for "${row.listing.product.sku}"`}
                className="h-7 w-7 inline-flex items-center justify-center text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded focus:outline-none focus:ring-2 focus:ring-slate-300">
                <Square size={12} />
              </button>
            )}
            {row.status === 'DRAFT' && (
              <button onClick={() => remove(row)} title="Delete" aria-label={`Delete DRAFT markdown for "${row.listing.product.sku}"`}
                className="h-7 w-7 inline-flex items-center justify-center text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded focus:outline-none focus:ring-2 focus:ring-rose-300">
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )
      default:
        return null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const DENSITY_OPTIONS: { d: Density; icon: React.ReactNode; label: string }[] = [
    { d: 'compact',     icon: <AlignJustify size={13} />, label: 'Compact' },
    { d: 'comfortable', icon: <MenuIcon size={13} />,     label: 'Comfortable' },
    { d: 'spacious',    icon: <Equal size={13} />,        label: 'Spacious' },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title={(() => {
          const mp = marketplaceFilter.replace('EBAY_', '')
          const country = mp ? (COUNTRY_NAMES[mp] ?? mp) : null
          return country ? `eBay Markdowns · ${country}` : 'eBay Markdowns · Sale Events'
        })()}
        description="Schedule percentage or fixed-price discounts on eBay listings. PERCENTAGE computes against the listing's current price; FIXED_PRICE sets an absolute sale price."
        breadcrumbs={[
          { label: 'Listings', href: '/listings' },
          { label: 'eBay', href: '/listings/ebay' },
          { label: 'Markdowns' },
        ]}
      />

      {/* Marketplace tab strip */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => setMarketplaceFilter('')}
          className={`px-3 py-1.5 rounded border text-sm font-medium transition-colors ${marketplaceFilter === '' ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700 dark:hover:border-slate-500'}`}
        >
          All markets
        </button>
        {EBAY_MARKET_CODES.map(mp => (
          <button
            key={mp}
            onClick={() => setMarketplaceFilter(`EBAY_${mp}`)}
            className={`px-3 py-1.5 rounded border text-sm font-medium transition-colors ${marketplaceFilter === `EBAY_${mp}` ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700 dark:hover:border-slate-500'}`}
          >
            {COUNTRY_NAMES[mp] ?? mp}
          </button>
        ))}
      </div>

      {/* Honest banner */}
      <Card>
        <div className="flex items-start gap-2 text-sm">
          <AlertCircle size={14} className="mt-0.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <div className="text-slate-600 dark:text-slate-400">
            <span className="font-semibold text-slate-700 dark:text-slate-300">eBay push pending —</span>{' '}
            markdowns are stored in Nexus only. Schedule the sale on eBay&apos;s
            Seller Hub side, then flip status to <code className="px-1 bg-slate-100 dark:bg-slate-800 rounded text-xs">ACTIVE</code> here so the
            engagement metrics line up. Direct push to eBay&apos;s promotion API
            lands behind <code className="px-1 bg-slate-100 dark:bg-slate-800 rounded text-xs">NEXUS_ENABLE_EBAY_PUBLISH</code> in a follow-up.
          </div>
        </div>
      </Card>

      {/* Toolbar: status filter + density + count + create */}
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="h-8 px-2 text-base bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600 focus:outline-none focus:border-blue-500"
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="SCHEDULED">Scheduled</option>
          <option value="ACTIVE">Active</option>
          <option value="ENDED">Ended</option>
          <option value="CANCELLED">Cancelled</option>
          <option value="FAILED">Failed</option>
        </select>

        {/* Density toggle */}
        <div className="flex items-center gap-0.5 border border-slate-200 dark:border-slate-700 rounded p-0.5">
          {DENSITY_OPTIONS.map(({ d, icon, label }) => (
            <button
              key={d}
              onClick={() => setDensity(d)}
              title={label}
              aria-pressed={density === d}
              className={`h-6 w-6 inline-flex items-center justify-center rounded transition-colors ${
                density === d
                  ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {icon}
            </button>
          ))}
        </div>

        <span className="text-sm text-slate-500 dark:text-slate-400">
          {rows.length} markdown{rows.length === 1 ? '' : 's'}
        </span>
        <button
          onClick={() => setCreateOpen(true)}
          className="ml-auto h-8 px-3 text-base bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 inline-flex items-center gap-1.5"
        >
          <Plus size={12} /> New markdown
        </button>
      </div>

      {/* Grid */}
      {loading && !data ? (
        <Card><Skeleton variant="text" lines={4} /></Card>
      ) : error && !data ? (
        <Card><div className="text-rose-600 dark:text-rose-400 text-sm">Failed to load: {error}</div></Card>
      ) : rows.length === 0 ? (
        <Card>
          <div className="text-center py-8 text-sm text-slate-500 dark:text-slate-400">
            No markdowns yet.{' '}
            <button onClick={() => setCreateOpen(true)} className="text-blue-600 dark:text-blue-400 hover:underline">
              Schedule your first markdown
            </button>.
          </div>
        </Card>
      ) : (<>
        <VirtualizedGrid
          rows={rows}
          visible={MARKDOWN_COLUMNS}
          density={density}
          cellPad={cellPad}
          selected={selected}
          toggleSelect={toggleSelect}
          toggleSelectAll={toggleSelectAll}
          allSelected={allSelected}
          sortBy={sortBy}
          onSort={onSort}
          sortKeys={MARKDOWN_SORT_KEYS}
          expandedParents={_EMPTY_SET}
          childrenByParent={_EMPTY_MAP}
          loadingChildren={_EMPTY_SET}
          onToggleExpand={_NOOP}
          focusedRowId={null}
          searchTerm=""
          riskFlaggedSkus={_EMPTY_SET}
          storageKey={STORAGE_KEY}
          showExpandColumn={false}
          renderCell={renderCell}
        />
        <GridFooter count={rows.length} label="markdowns" />
      </>)}

      {/* C.17 — Best Offer + auto-relist placeholders */}
      <Card>
        <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Coming soon</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm text-slate-600 dark:text-slate-400">
          <div className="flex items-start gap-2">
            <MessageCircle size={14} className="mt-0.5 text-slate-400 dark:text-slate-500 flex-shrink-0" />
            <div>
              <span className="font-medium text-slate-700 dark:text-slate-300">Best Offer manager —</span>{' '}
              per-listing toggle + auto-accept/decline thresholds. Needs a{' '}
              <code className="px-1 bg-slate-100 dark:bg-slate-800 rounded text-xs">bestOfferEnabled</code>{' '}
              column on ChannelListing; tracked in the roadmap as a follow-up.
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Repeat size={14} className="mt-0.5 text-slate-400 dark:text-slate-500 flex-shrink-0" />
            <div>
              <span className="font-medium text-slate-700 dark:text-slate-300">Auto-relist controls —</span>{' '}
              eBay re-lists ENDED items automatically when configured. Needs an{' '}
              <code className="px-1 bg-slate-100 dark:bg-slate-800 rounded text-xs">autoRelistCount</code>{' '}
              column on ChannelListing; tracked in the roadmap as a follow-up.
            </div>
          </div>
        </div>
      </Card>

      {createOpen && (
        <CreateMarkdownModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); refetch() }}
        />
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// CreateMarkdownModal — listing search + discount + window
// ────────────────────────────────────────────────────────────────────
function CreateMarkdownModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { toast } = useToast()
  const [search, setSearch]                     = useState('')
  const [listings, setListings]                 = useState<ListingRow[]>([])
  const [selectedListingId, setSelectedListingId] = useState<string>('')
  const [discountType, setDiscountType]         = useState<'PERCENTAGE' | 'FIXED_PRICE'>('PERCENTAGE')
  const [discountValue, setDiscountValue]       = useState('15')
  const [startDate, setStartDate]               = useState(() => new Date().toISOString().slice(0, 10))
  const [endDate, setEndDate]                   = useState('')
  const [busy, setBusy]                         = useState(false)

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ channel: 'EBAY', listingStatus: 'ACTIVE', pageSize: '20' })
        if (search.trim()) qs.set('search', search.trim())
        const res = await fetch(`${getBackendUrl()}/api/listings?${qs.toString()}`, { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        setListings(data.listings ?? [])
      } catch { /* empty list is informative enough */ }
    }, 250)
    return () => clearTimeout(t)
  }, [search])

  const selectedListing = listings.find(l => l.id === selectedListingId)

  const submit = async () => {
    if (!selectedListingId) { toast.error('Pick a listing first'); return }
    const value = Number(discountValue)
    if (!Number.isFinite(value) || value <= 0) { toast.error('Discount value must be a positive number'); return }
    if (discountType === 'PERCENTAGE' && value > 100) { toast.error('Percentage discount must be ≤ 100'); return }
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/ebay/markdowns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelListingId: selectedListingId, discountType, discountValue: value, startDate, endDate: endDate || null }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      toast.success('Markdown scheduled (DRAFT)')
      onCreated()
    } catch (e: any) {
      toast.error(`Create failed: ${e?.message ?? String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const previewPrice = (() => {
    if (!selectedListing?.price) return null
    const v = Number(discountValue)
    if (!Number.isFinite(v) || v <= 0) return null
    return discountType === 'PERCENTAGE' ? Math.max(0, selectedListing.price * (1 - v / 100)) : Math.max(0, v)
  })()

  return (
    <Modal open onClose={onClose} title="Schedule a markdown" size="md">
      <ModalBody>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">eBay listing</label>
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKU, name, or eBay item ID…" autoFocus />
            <div className="mt-2 max-h-48 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded">
              {listings.length === 0 ? (
                <div className="text-sm text-slate-400 dark:text-slate-500 p-3 text-center">No matching ACTIVE eBay listings</div>
              ) : (
                <ul>
                  {listings.map(l => (
                    <li key={l.id} onClick={() => setSelectedListingId(l.id)}
                      className={`px-3 py-2 cursor-pointer flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 last:border-b-0 ${
                        selectedListingId === l.id ? 'bg-blue-50 dark:bg-blue-950/40' : 'hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}>
                      <Tag size={11} className="text-slate-400 dark:text-slate-500" />
                      <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{l.product.sku}</span>
                      <span className="text-sm text-slate-700 dark:text-slate-300 truncate flex-1">{l.product.name}</span>
                      <span className="text-xs text-slate-400 dark:text-slate-500 font-mono">{l.marketplace}</span>
                      {l.price != null && <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300">{l.price.toFixed(2)}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Discount type</label>
            <div className="space-y-1.5 text-sm text-slate-700 dark:text-slate-300">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="discount" value="PERCENTAGE" checked={discountType === 'PERCENTAGE'} onChange={() => setDiscountType('PERCENTAGE')} />
                Percentage off (e.g. 15% off current price)
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="discount" value="FIXED_PRICE" checked={discountType === 'FIXED_PRICE'} onChange={() => setDiscountType('FIXED_PRICE')} />
                Fixed sale price (absolute number)
              </label>
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">
              {discountType === 'PERCENTAGE' ? 'Discount %' : 'Sale price'}
            </label>
            <Input type="number" step={discountType === 'PERCENTAGE' ? '1' : '0.01'} min="0.01"
              max={discountType === 'PERCENTAGE' ? '100' : undefined}
              value={discountValue} onChange={e => setDiscountValue(e.target.value)} />
            {previewPrice != null && (
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 tabular-nums">
                Preview: <span className="font-semibold text-slate-700 dark:text-slate-300">{previewPrice.toFixed(2)}</span>{' '}
                (vs current {selectedListing?.price?.toFixed(2)})
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Start date</label>
              <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">
                End date <span className="text-slate-400 dark:text-slate-500 font-normal">(optional)</span>
              </label>
              <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <button onClick={onClose} disabled={busy}
          className="h-8 px-3 text-base text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800">
          Cancel
        </button>
        <button onClick={submit} disabled={busy || !selectedListingId}
          className="h-8 px-3 text-base bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 inline-flex items-center gap-1.5 disabled:opacity-50">
          {busy ? 'Creating…' : 'Schedule markdown'}
        </button>
      </ModalFooter>
    </Modal>
  )
}
