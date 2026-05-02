import Link from 'next/link'
import { ShoppingBag } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { COUNTRY_NAMES } from '@/lib/country-names'
import { getBackendUrl } from '@/lib/backend-url'
import type { Listing } from './ListingsTable'

interface Marketplace {
  code: string
  name: string
  channel: string
  region: string
  currency: string
  language: string
}

interface Props {
  channel: 'AMAZON' | 'EBAY'
  /** Display label, e.g. "Amazon" / "eBay" */
  label: string
}

const STATUS_VARIANT: Record<string, 'success' | 'default' | 'warning' | 'danger'> = {
  ACTIVE: 'success',
  PUBLISHED: 'success',
  DRAFT: 'default',
  PENDING: 'warning',
  SUPPRESSED: 'danger',
  ENDED: 'default',
  ERROR: 'danger',
}

/**
 * Channel-level dashboard server component used by both /listings/amazon
 * and /listings/ebay. Fetches:
 *   - all listings (filtered to this channel client-side from /api/listings/all
 *     since we already have the join logic there)
 *   - the channel's marketplaces (?channel=AMAZON|EBAY)
 * and renders a marketplace cards grid + recent activity feed.
 */
export default async function ChannelDashboard({ channel, label }: Props) {
  const backend = getBackendUrl()
  const [listingsRes, marketplacesRes] = await Promise.all([
    fetch(`${backend}/api/listings/all`, { cache: 'no-store' }),
    fetch(`${backend}/api/marketplaces?channel=${channel}`, { cache: 'no-store' }),
  ])

  const all: Listing[] = listingsRes.ok ? (await listingsRes.json()).listings ?? [] : []
  const channelListings = all.filter((l) => l.channel === channel)

  const marketplaces: Marketplace[] = marketplacesRes.ok
    ? await marketplacesRes.json()
    : []

  // Group listings by marketplace
  const byMarket = new Map<string, Listing[]>()
  for (const l of channelListings) {
    const arr = byMarket.get(l.marketplace) ?? []
    arr.push(l)
    byMarket.set(l.marketplace, arr)
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={`${label} Listings`}
        description={`Manage listings across all ${label} marketplaces`}
        breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label }]}
      />

      {marketplaces.length === 0 ? (
        <EmptyState
          icon={ShoppingBag}
          title={`No ${label} marketplaces configured`}
          description="Run /api/marketplaces/seed to populate the lookup."
          action={{ label: 'Open settings', href: '/settings/channels' }}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {marketplaces.map((mp) => {
            const count = byMarket.get(mp.code)?.length ?? 0
            return (
              <Link
                key={mp.code}
                href={`/listings/${channel.toLowerCase()}/${mp.code.toLowerCase()}`}
                className="block group"
              >
                <Card className="group-hover:border-slate-300 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] font-semibold bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
                          {mp.code}
                        </span>
                        <span className="text-[14px] font-semibold text-slate-900 truncate">
                          {COUNTRY_NAMES[mp.code] ?? mp.name}
                        </span>
                      </div>
                      <div className="text-[12px] text-slate-500 mt-1">
                        {mp.currency} · {mp.language.toUpperCase()}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-[20px] font-semibold text-slate-900 tabular-nums">
                        {count}
                      </div>
                      <div className="text-[10px] text-slate-500 uppercase tracking-wider">
                        listing{count === 1 ? '' : 's'}
                      </div>
                    </div>
                  </div>
                </Card>
              </Link>
            )
          })}
        </div>
      )}

      <Card title="Recent Activity" description={`Latest changes across all ${label} markets`}>
        {channelListings.length === 0 ? (
          <EmptyState
            icon={ShoppingBag}
            title={`No ${label} listings yet`}
            description={`Publish products to ${label} marketplaces to see them here.`}
            action={{ label: 'Go to Catalog', href: '/products' }}
          />
        ) : (
          <ul className="space-y-1 -my-1">
            {channelListings.slice(0, 10).map((l) => (
              <li key={l.id}>
                <Link
                  href={`/products/${l.productId}/edit?channel=${l.channel}&marketplace=${l.marketplace}`}
                  className="flex items-center justify-between gap-3 py-2 px-3 -mx-3 rounded-md hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-mono text-[11px] font-semibold bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
                      {l.marketplace}
                    </span>
                    <div className="min-w-0">
                      <div className="text-[13px] text-slate-900 truncate">
                        {l.product.name}
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono">
                        {l.product.sku}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <Badge variant={STATUS_VARIANT[l.listingStatus] ?? 'default'} size="sm">
                      {l.listingStatus}
                    </Badge>
                    <div className="text-[12px] text-slate-500 tabular-nums w-20 text-right">
                      {l.price != null
                        ? `${l.currency ?? ''} ${Number(l.price).toFixed(2)}`.trim()
                        : '—'}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
