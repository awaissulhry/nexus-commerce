'use client'

// C.17 — eBay markdown manager.
//
// CRUD UI on top of EbayMarkdown (C.14 schema). Mirror of the campaign
// manager pattern (C.16): list, create modal, status transitions,
// honest "eBay push pending" banner since promotion API push lands
// behind NEXUS_ENABLE_EBAY_PUBLISH in a follow-up commit.
//
// Best Offer + auto-relist — the spec calls these out as part of
// Wave 5, but they're per-listing settings on the eBay side rather
// than discrete events. They need new ChannelListing columns
// (bestOfferEnabled, autoRelistCount) before there's anything for
// a UI to read or write. Surfaced as placeholders at the bottom of
// this page so operators see the gap; real implementation defers
// to a follow-up commit when the schema bump lands.

import { useState, useMemo, useEffect } from 'react'
import { Plus, Square, Trash2, AlertCircle, Tag, Repeat, MessageCircle } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { usePolledList } from '@/lib/sync/use-polled-list'

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

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-600 border-slate-200',
  SCHEDULED: 'bg-blue-50 text-blue-700 border-blue-200',
  ACTIVE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  ENDED: 'bg-slate-50 text-slate-400 border-slate-200',
  CANCELLED: 'bg-slate-50 text-slate-400 border-slate-200',
  FAILED: 'bg-rose-50 text-rose-700 border-rose-200',
}

export default function EbayMarkdownsClient() {
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [createOpen, setCreateOpen] = useState(false)
  const { toast } = useToast()
  const askConfirm = useConfirm()

  const url = useMemo(() => {
    const qs = new URLSearchParams()
    if (statusFilter) qs.set('status', statusFilter)
    return `/api/listings/ebay/markdowns?${qs.toString()}`
  }, [statusFilter])

  const { data, loading, error, refetch } = usePolledList<{
    markdowns: EbayMarkdown[]
  }>({
    url,
    intervalMs: 30_000,
  })

  const markdowns = data?.markdowns ?? []

  const transition = async (id: string, nextStatus: 'CANCELLED' | 'ENDED') => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listings/ebay/markdowns/${id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: nextStatus }),
        },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      toast.success(`Markdown ${nextStatus.toLowerCase()}`)
      refetch()
    } catch (e: any) {
      toast.error(`Update failed: ${e?.message ?? String(e)}`)
    }
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
      const res = await fetch(
        `${getBackendUrl()}/api/listings/ebay/markdowns/${m.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      toast.success('Markdown deleted')
      refetch()
    } catch (e: any) {
      toast.error(`Delete failed: ${e?.message ?? String(e)}`)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Markdowns + sale events"
        description="Schedule discounts on individual eBay listings. PERCENTAGE discounts compute against the listing's current price; FIXED_PRICE sets an absolute sale price."
        breadcrumbs={[
          { label: 'Listings', href: '/listings' },
          { label: 'eBay', href: '/listings/ebay' },
          { label: 'Markdowns' },
        ]}
      />

      <Card>
        <div className="flex items-start gap-2 text-sm">
          <AlertCircle size={14} className="mt-0.5 text-amber-600 flex-shrink-0" />
          <div className="text-slate-600">
            <span className="font-semibold text-slate-700">eBay push pending —</span>{' '}
            markdowns are stored in Nexus only. Schedule the sale on eBay&apos;s
            Seller Hub side, then flip status to <code className="px-1 bg-slate-100 rounded text-xs">ACTIVE</code> here so the
            engagement metrics line up. Direct push to eBay&apos;s promotion API
            lands behind <code className="px-1 bg-slate-100 rounded text-xs">NEXUS_ENABLE_EBAY_PUBLISH</code> in a follow-up.
          </div>
        </div>
      </Card>

      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-8 px-2 text-base bg-white border border-slate-200 rounded text-slate-700 hover:border-slate-300 focus:outline-none focus:border-blue-500"
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
        <span className="text-sm text-slate-500 ml-2">
          {markdowns.length} markdown{markdowns.length === 1 ? '' : 's'}
        </span>
        <button
          onClick={() => setCreateOpen(true)}
          className="ml-auto h-8 px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1.5"
        >
          <Plus size={12} /> New markdown
        </button>
      </div>

      {loading && !data ? (
        <Card>
          <Skeleton variant="text" lines={4} />
        </Card>
      ) : error && !data ? (
        <Card>
          <div className="text-rose-600 text-sm">Failed to load: {error}</div>
        </Card>
      ) : markdowns.length === 0 ? (
        <Card>
          <div className="text-center py-8 text-sm text-slate-500">
            No markdowns yet.{' '}
            <button
              onClick={() => setCreateOpen(true)}
              className="text-blue-600 hover:underline"
            >
              Schedule your first markdown
            </button>
            .
          </div>
        </Card>
      ) : (
        <Card noPadding>
          <table className="w-full text-base">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-3 py-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">Listing</th>
                <th className="text-left px-3 py-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">Discount</th>
                <th className="text-right px-3 py-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">Original</th>
                <th className="text-right px-3 py-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">Markdown</th>
                <th className="text-left px-3 py-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">Window</th>
                <th className="text-left px-3 py-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">Status</th>
                <th className="text-right px-3 py-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {markdowns.map((m) => (
                <tr key={m.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900 truncate max-w-xs">
                      {m.listing.product.name}
                    </div>
                    <div className="text-xs text-slate-500 font-mono">
                      {m.listing.product.sku} · {m.listing.marketplace}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-sm">
                    {m.discountType === 'PERCENTAGE' ? (
                      <span className="tabular-nums">−{m.discountValue}%</span>
                    ) : (
                      <span className="tabular-nums">
                        {m.discountValue.toFixed(2)} {m.currency} fixed
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-sm text-slate-500">
                    {m.originalPrice.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-sm font-semibold">
                    {m.markdownPrice.toFixed(2)} {m.currency}
                  </td>
                  <td className="px-3 py-2 text-sm text-slate-600 whitespace-nowrap">
                    {new Date(m.startDate).toLocaleDateString()} →{' '}
                    {m.endDate ? new Date(m.endDate).toLocaleDateString() : 'open'}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${STATUS_TONE[m.status] ?? ''}`}>
                      {m.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      {(m.status === 'DRAFT' || m.status === 'SCHEDULED') && (
                        <button
                          onClick={() => transition(m.id, 'CANCELLED')}
                          title="Cancel"
                          className="h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:bg-slate-100 rounded"
                        >
                          <Square size={12} />
                        </button>
                      )}
                      {m.status === 'ACTIVE' && (
                        <button
                          onClick={() => transition(m.id, 'ENDED')}
                          title="End now"
                          className="h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:bg-slate-100 rounded"
                        >
                          <Square size={12} />
                        </button>
                      )}
                      {m.status === 'DRAFT' && (
                        <button
                          onClick={() => remove(m)}
                          title="Delete"
                          className="h-7 w-7 inline-flex items-center justify-center text-rose-500 hover:bg-rose-50 rounded"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* C.17 — Best Offer + auto-relist placeholders. Both are
          per-listing settings on the eBay side, but Nexus doesn't yet
          have backing columns (ChannelListing.bestOfferEnabled,
          autoRelistCount) so there's nothing for a UI to read/write.
          Surfaced honestly so operators see the roadmap gap. */}
      <Card>
        <div className="text-sm font-semibold text-slate-700 mb-2">
          Coming soon
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm text-slate-600">
          <div className="flex items-start gap-2">
            <MessageCircle size={14} className="mt-0.5 text-slate-400 flex-shrink-0" />
            <div>
              <span className="font-medium text-slate-700">Best Offer manager —</span>{' '}
              per-listing toggle + auto-accept/decline thresholds. Needs a{' '}
              <code className="px-1 bg-slate-100 rounded text-xs">bestOfferEnabled</code>{' '}
              column on ChannelListing; tracked in the roadmap as a follow-up.
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Repeat size={14} className="mt-0.5 text-slate-400 flex-shrink-0" />
            <div>
              <span className="font-medium text-slate-700">Auto-relist controls —</span>{' '}
              eBay re-lists ENDED items automatically when configured. Needs an{' '}
              <code className="px-1 bg-slate-100 rounded text-xs">autoRelistCount</code>{' '}
              column on ChannelListing; tracked in the roadmap as a follow-up.
            </div>
          </div>
        </div>
      </Card>

      {createOpen && (
        <CreateMarkdownModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false)
            refetch()
          }}
        />
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// CreateMarkdownModal — listing search + discount + window
// ────────────────────────────────────────────────────────────────────
function CreateMarkdownModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const [listings, setListings] = useState<ListingRow[]>([])
  const [selectedListingId, setSelectedListingId] = useState<string>('')
  const [discountType, setDiscountType] = useState<'PERCENTAGE' | 'FIXED_PRICE'>('PERCENTAGE')
  const [discountValue, setDiscountValue] = useState('15')
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [endDate, setEndDate] = useState('')
  const [busy, setBusy] = useState(false)

  // Search ACTIVE eBay listings to pick from. 250ms debounce so
  // typing doesn't hammer the endpoint; the search endpoint already
  // hits indexed columns (sku / name / externalListingId).
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({
          channel: 'EBAY',
          listingStatus: 'ACTIVE',
          pageSize: '20',
        })
        if (search.trim()) qs.set('search', search.trim())
        const res = await fetch(
          `${getBackendUrl()}/api/listings?${qs.toString()}`,
          { cache: 'no-store' },
        )
        if (!res.ok) return
        const data = await res.json()
        setListings(data.listings ?? [])
      } catch {
        /* swallow — empty list is informative enough */
      }
    }, 250)
    return () => clearTimeout(t)
  }, [search])

  const selectedListing = listings.find((l) => l.id === selectedListingId)

  const submit = async () => {
    if (!selectedListingId) {
      toast.error('Pick a listing first')
      return
    }
    const value = Number(discountValue)
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Discount value must be a positive number')
      return
    }
    if (discountType === 'PERCENTAGE' && value > 100) {
      toast.error('Percentage discount must be ≤ 100')
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/ebay/markdowns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelListingId: selectedListingId,
          discountType,
          discountValue: value,
          startDate,
          endDate: endDate || null,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
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
    if (discountType === 'PERCENTAGE') {
      return Math.max(0, selectedListing.price * (1 - v / 100))
    }
    return Math.max(0, v)
  })()

  return (
    <Modal open onClose={onClose} title="Schedule a markdown" size="md">
      <ModalBody>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">
              eBay listing
            </label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search SKU, name, or eBay item ID…"
              autoFocus
            />
            <div className="mt-2 max-h-48 overflow-y-auto border border-slate-200 rounded">
              {listings.length === 0 ? (
                <div className="text-sm text-slate-400 p-3 text-center">
                  No matching ACTIVE eBay listings
                </div>
              ) : (
                <ul>
                  {listings.map((l) => (
                    <li
                      key={l.id}
                      onClick={() => setSelectedListingId(l.id)}
                      className={`px-3 py-2 cursor-pointer flex items-center gap-2 border-b border-slate-100 last:border-b-0 ${
                        selectedListingId === l.id
                          ? 'bg-blue-50'
                          : 'hover:bg-slate-50'
                      }`}
                    >
                      <Tag size={11} className="text-slate-400" />
                      <span className="font-mono text-xs text-slate-500">{l.product.sku}</span>
                      <span className="text-sm text-slate-700 truncate flex-1">{l.product.name}</span>
                      <span className="text-xs text-slate-400 font-mono">{l.marketplace}</span>
                      {l.price != null && (
                        <span className="text-sm tabular-nums text-slate-700">
                          {l.price.toFixed(2)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">
              Discount type
            </label>
            <div className="space-y-1.5 text-sm text-slate-700">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="discount"
                  value="PERCENTAGE"
                  checked={discountType === 'PERCENTAGE'}
                  onChange={() => setDiscountType('PERCENTAGE')}
                />
                Percentage off (e.g. 15% off current price)
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="discount"
                  value="FIXED_PRICE"
                  checked={discountType === 'FIXED_PRICE'}
                  onChange={() => setDiscountType('FIXED_PRICE')}
                />
                Fixed sale price (absolute number)
              </label>
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">
              {discountType === 'PERCENTAGE' ? 'Discount %' : 'Sale price'}
            </label>
            <Input
              type="number"
              step={discountType === 'PERCENTAGE' ? '1' : '0.01'}
              min="0.01"
              max={discountType === 'PERCENTAGE' ? '100' : undefined}
              value={discountValue}
              onChange={(e) => setDiscountValue(e.target.value)}
            />
            {previewPrice != null && (
              <div className="text-xs text-slate-500 mt-1 tabular-nums">
                Preview:{' '}
                <span className="font-semibold text-slate-700">
                  {previewPrice.toFixed(2)}
                </span>{' '}
                (vs current{' '}
                {selectedListing?.price?.toFixed(2)})
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">
                Start date
              </label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">
                End date <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          onClick={onClose}
          disabled={busy}
          className="h-8 px-3 text-base text-slate-700 border border-slate-200 rounded hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={busy || !selectedListingId}
          className="h-8 px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Schedule markdown'}
        </button>
      </ModalFooter>
    </Modal>
  )
}
