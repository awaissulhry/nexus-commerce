'use client'

// C.20 — Path A Etsy overlay.
//
// Same shape as Shopify (C.18) and WooCommerce (C.19): single-shop
// channel, no campaigns / markdown depth. The 4-tile KPI strip
// surfaces what an Etsy seller cares about: total listings, active
// (Etsy-specific term for "live"), on-sale (when sale_price is set),
// and distinct sections assigned (Etsy's storefront grouping).
//
// Etsy-specific concerns deferred to follow-ups: tags coverage
// (13-max constraint), materials coverage (13-max), production
// partner assignment, renewal status (auto vs manual; expires every
// 4 months), Star Seller badge eligibility. Each needs either new
// ChannelListing columns or platformAttributes JSON conventions
// before a UI can read them; surfaced as the surface itself
// matures.

import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { usePolledList } from '@/lib/sync/use-polled-list'
import ListingsWorkspace from '../ListingsWorkspace'

interface PathAOverview {
  channel: string
  counts: { total: number; live: number; draft: number; error: number }
  published: { count: number }
  onSale: { count: number }
  etsy: { sectionCount: number } | null
}

interface Props {
  breadcrumbs?: Array<{ label: string; href?: string }>
}

export default function EtsyListingsClient({ breadcrumbs }: Props) {
  const { data: overview, loading } = usePolledList<PathAOverview>({
    url: '/api/listings/path-a/overview?channel=ETSY',
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
      <EtsyKpiStrip overview={overview} loading={loading} />
      <ListingsWorkspace lockChannel="ETSY" breadcrumbs={breadcrumbs} />
    </div>
  )
}

function EtsyKpiStrip({
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

  const { counts, published, onSale, etsy } = overview

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Tile
        label="Active"
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
            : `${counts.total - published.count} draft / inactive`
        }
        tone={
          counts.total > 0 && published.count < counts.total ? 'warning' : 'default'
        }
      />
      <Tile
        label="On sale"
        value={onSale.count}
        sub={onSale.count === 0 ? 'no sale prices set' : 'with sale_price set'}
        tone={onSale.count > 0 ? 'success' : 'default'}
      />
      <Tile
        label="Sections used"
        value={etsy?.sectionCount ?? 0}
        sub={
          etsy?.sectionCount === 0
            ? 'no section assigned'
            : 'storefront groupings'
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
