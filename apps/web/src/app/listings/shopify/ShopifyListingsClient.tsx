'use client'

// C.18 — Path A Shopify overlay.
//
// Lighter than Amazon/eBay Path B: no marketplace tabs (Shopify is
// single-marketplace from Nexus's POV — one shop = one channel
// connection), no campaigns / markdown depth. Just a 4-tile KPI
// strip and the proven workspace below.
//
// Channel-specific facets come from platformAttributes JSON on
// ChannelListing rows: vendor count for Shopify (Shopify allows
// per-product "Vendor" assignment that surfaces in storefront
// filtering). Online-store visibility maps to isPublished — when
// false, Shopify hides the product from the storefront even if it
// exists in admin.

import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { usePolledList } from '@/lib/sync/use-polled-list'
import ListingsWorkspace from '../ListingsWorkspace'

interface PathAOverview {
  channel: string
  counts: { total: number; live: number; draft: number; error: number }
  published: { count: number }
  onSale: { count: number }
  shopify: { vendorCount: number } | null
}

interface Props {
  breadcrumbs?: Array<{ label: string; href?: string }>
}

export default function ShopifyListingsClient({ breadcrumbs }: Props) {
  const { data: overview, loading } = usePolledList<PathAOverview>({
    url: '/api/listings/path-a/overview?channel=SHOPIFY',
    intervalMs: 30_000,
    invalidationTypes: [
      'listing.updated',
      'listing.created',
      'listing.deleted',
      'bulk-job.completed',
      'wizard.submitted',
    ],
  })

  return (
    <div className="space-y-4">
      <ShopifyKpiStrip overview={overview} loading={loading} />
      <ListingsWorkspace lockChannel="SHOPIFY" breadcrumbs={breadcrumbs} />
    </div>
  )
}

function ShopifyKpiStrip({
  overview,
  loading,
}: {
  overview: PathAOverview | null
  loading: boolean
}) {
  if (loading && !overview) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}><Skeleton variant="text" lines={2} /></Card>
        ))}
      </div>
    )
  }
  if (!overview) return null

  const { counts, published, onSale, shopify } = overview

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Tile
        label="Live"
        value={counts.live}
        sub={`${counts.total} total`}
        tone="success"
      />
      <Tile
        label="Online store visible"
        value={published.count}
        sub={
          counts.total === 0
            ? 'no listings yet'
            : `${counts.total - published.count} hidden from storefront`
        }
        tone={
          counts.total > 0 && published.count < counts.total ? 'warning' : 'default'
        }
      />
      <Tile
        label="On sale"
        value={onSale.count}
        sub={onSale.count === 0 ? 'no compare-at prices set' : 'with compare-at price'}
        tone={onSale.count > 0 ? 'success' : 'default'}
      />
      <Tile
        label="Distinct vendors"
        value={shopify?.vendorCount ?? 0}
        sub={
          shopify?.vendorCount === 0
            ? 'no Vendor assigned'
            : 'across catalog'
        }
        tone="default"
      />
    </div>
  )
}

function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string | number
  sub?: string
  tone: 'default' | 'success' | 'warning' | 'danger'
}) {
  const toneClass =
    tone === 'success'
      ? 'text-emerald-700'
      : tone === 'warning'
        ? 'text-amber-700'
        : tone === 'danger'
          ? 'text-rose-700'
          : 'text-slate-900'
  return (
    <Card>
      <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1">
        {label}
      </div>
      <div className={`text-[24px] font-semibold tabular-nums leading-none ${toneClass}`}>
        {value}
      </div>
      {sub && <div className="text-sm text-slate-500 mt-1">{sub}</div>}
    </Card>
  )
}
