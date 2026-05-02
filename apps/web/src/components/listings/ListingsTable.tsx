'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'

export interface Listing {
  id: string
  productId: string
  channel: string
  marketplace: string
  listingStatus: string
  price: number | null
  quantity: number | null
  currency: string | null
  externalListingId: string | null
  lastSyncedAt: string | null
  product: {
    id: string
    sku: string
    name: string
    amazonAsin: string | null
  }
}

const STATUS_VARIANT: Record<
  string,
  'success' | 'warning' | 'danger' | 'default' | 'info'
> = {
  ACTIVE: 'success',
  PUBLISHED: 'success',
  DRAFT: 'default',
  PENDING: 'warning',
  PENDING_REVIEW: 'warning',
  SUPPRESSED: 'danger',
  ENDED: 'default',
  ERROR: 'danger',
  INACTIVE: 'default',
}

interface Props {
  listings: Listing[]
  /**
   * If true, hides the channel filter and channel column (the table is
   * already scoped to one channel by the page wrapper).
   */
  scopedToChannel?: boolean
  /**
   * If true, hides the market column (the table is already scoped to
   * one channel + marketplace).
   */
  scopedToMarket?: boolean
}

export function ListingsTable({ listings, scopedToChannel, scopedToMarket }: Props) {
  const [search, setSearch] = useState('')
  const [channelFilter, setChannelFilter] = useState<string>('ALL')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return listings.filter((l) => {
      if (!scopedToChannel && channelFilter !== 'ALL' && l.channel !== channelFilter) {
        return false
      }
      if (!q) return true
      return (
        l.product.sku.toLowerCase().includes(q) ||
        l.product.name.toLowerCase().includes(q) ||
        (l.externalListingId?.toLowerCase().includes(q) ?? false)
      )
    })
  }, [listings, search, channelFilter, scopedToChannel])

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex-1 min-w-[240px] max-w-md">
            <Input
              placeholder="Search by SKU, product name, or external ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {!scopedToChannel && (
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
              className="h-8 px-3 text-[13px] border border-slate-200 rounded-md bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            >
              <option value="ALL">All channels</option>
              <option value="AMAZON">Amazon</option>
              <option value="EBAY">eBay</option>
              <option value="SHOPIFY">Shopify</option>
              <option value="WOOCOMMERCE">WooCommerce</option>
              <option value="ETSY">Etsy</option>
            </select>
          )}
          <div className="text-[12px] text-slate-500 ml-auto tabular-nums">
            {filtered.length} of {listings.length} listing{listings.length === 1 ? '' : 's'}
          </div>
        </div>
      </Card>

      <Card noPadding>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <Th>Product</Th>
                {!scopedToChannel && <Th>Channel</Th>}
                {!scopedToMarket && <Th>Market</Th>}
                <Th>Status</Th>
                <Th align="right">Price</Th>
                <Th align="right">Stock</Th>
                <Th>Last Sync</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="px-4 py-6 text-center text-[12px] text-slate-400"
                  >
                    No listings match the current filters.
                  </td>
                </tr>
              )}
              {filtered.map((l) => (
                <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2.5">
                    <div className="text-[13px] font-medium text-slate-900 truncate max-w-md">
                      {l.product.name}
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      {l.product.sku}
                    </div>
                  </td>
                  {!scopedToChannel && (
                    <td className="px-4 py-2.5 text-[13px] text-slate-700">
                      {l.channel}
                    </td>
                  )}
                  {!scopedToMarket && (
                    <td className="px-4 py-2.5">
                      <span className="font-mono text-[11px] font-semibold bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
                        {l.marketplace}
                      </span>
                    </td>
                  )}
                  <td className="px-4 py-2.5">
                    <Badge variant={STATUS_VARIANT[l.listingStatus] ?? 'default'} size="sm">
                      {l.listingStatus}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-[13px] text-slate-700 text-right tabular-nums">
                    {l.price != null
                      ? `${l.currency ?? ''} ${Number(l.price).toFixed(2)}`.trim()
                      : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-[13px] text-slate-700 text-right tabular-nums">
                    {l.quantity ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-[12px] text-slate-500">
                    {l.lastSyncedAt
                      ? new Date(l.lastSyncedAt).toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                        })
                      : 'Never'}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Link
                      href={`/products/${l.productId}/edit?channel=${l.channel}&marketplace=${l.marketplace}`}
                      className="text-[12px] text-blue-600 hover:underline"
                    >
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode
  align?: 'left' | 'right'
}) {
  return (
    <th
      className={`px-4 py-2 text-[11px] font-semibold text-slate-700 uppercase tracking-wider ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  )
}
