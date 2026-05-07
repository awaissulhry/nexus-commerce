'use client'

// C.19 — Path A WooCommerce overlay.
//
// Same shape as the Shopify overlay (C.18): single-marketplace, no
// campaigns / markdown depth. The 4-tile KPI strip surfaces what a
// WooCommerce store operator cares about: total listings, published
// (visible to shoppers), on-sale (with regular_price + sale_price
// shown), and distinct categories assigned across the catalog.

import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { usePolledList } from '@/lib/sync/use-polled-list'
import ListingsWorkspace from '../ListingsWorkspace'

interface PathAOverview {
  channel: string
  counts: { total: number; live: number; draft: number; error: number }
  published: { count: number }
  onSale: { count: number }
  woocommerce: { categoryCount: number } | null
}

interface Props {
  breadcrumbs?: Array<{ label: string; href?: string }>
}

export default function WooCommerceListingsClient({ breadcrumbs }: Props) {
  const { data: overview, loading } = usePolledList<PathAOverview>({
    url: '/api/listings/path-a/overview?channel=WOOCOMMERCE',
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
      <WooKpiStrip overview={overview} loading={loading} />
      <ListingsWorkspace lockChannel="WOOCOMMERCE" breadcrumbs={breadcrumbs} />
    </div>
  )
}

function WooKpiStrip({
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

  const { counts, published, onSale, woocommerce } = overview

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Tile
        label="Live"
        value={counts.live}
        sub={`${counts.total} total`}
        tone="success"
      />
      <Tile
        label="Published"
        value={published.count}
        sub={
          counts.total === 0
            ? 'no listings yet'
            : `${counts.total - published.count} draft / private`
        }
        tone={
          counts.total > 0 && published.count < counts.total ? 'warning' : 'default'
        }
      />
      <Tile
        label="On sale"
        value={onSale.count}
        sub={onSale.count === 0 ? 'no sale prices set' : 'with regular + sale price'}
        tone={onSale.count > 0 ? 'success' : 'default'}
      />
      <Tile
        label="Distinct categories"
        value={woocommerce?.categoryCount ?? 0}
        sub={
          woocommerce?.categoryCount === 0
            ? 'no category assigned'
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
