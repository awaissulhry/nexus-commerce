'use client'

// C.15 — Path B eBay deep view.
//
// Mirror of AmazonListingsClient pattern: marketplace tabs (IT/DE/ES/
// FR/UK), KPI strip with engagement aggregates (avg watchers, total
// views, active markdowns, active campaigns), and the proven
// ListingsWorkspace below.
//
// The composition pattern keeps every workspace investment (grid,
// matrix, drafts, drawer with tabs, bulk bar) intact — eBay depth
// renders ABOVE it. Markdown manager (C.17) and Promoted Listings
// campaign manager (C.16) are separate surfaces that the operator
// reaches via dedicated nav items; this file is focused on the
// per-marketplace overview.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Megaphone } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { Tabs } from '@/components/ui/Tabs'
import { COUNTRY_NAMES } from '@/lib/country-names'
import { usePolledList } from '@/lib/sync/use-polled-list'
import ListingsWorkspace from '../ListingsWorkspace'

// eBay's seeded marketplaces from the audit (5 countries) — IT first
// because it's Xavia's primary. Others appended left-to-right by
// EU geography. Adding markets later (NL/PL/etc.) requires both an
// EBAY_<CC> constant in the eBay APIs and a Marketplace seed row.
const EBAY_MARKETS = ['IT', 'DE', 'ES', 'FR', 'UK']

interface EbayOverview {
  marketplace: string | null
  counts: { total: number; live: number; draft: number; error: number }
  engagement: {
    coverage: number       // % of listings that have at least one stats snapshot
    avgWatchers: number | null
    totalWatchers: number
    totalHits: number
    totalQuestions: number
  }
  markdowns: { activeListingCount: number }
  campaigns: { activeCount: number }
  marketplaceBreakdown: Array<{ marketplace: string; count: number }>
}

interface Props {
  /** When set, locks to a specific eBay marketplace (per-market route). */
  lockMarketplace?: string
  breadcrumbs?: Array<{ label: string; href?: string }>
}

export default function EbayListingsClient({
  lockMarketplace,
  breadcrumbs,
}: Props) {
  const [activeMarket, setActiveMarket] = useState<string>(
    lockMarketplace ?? 'IT',
  )

  const overviewUrl = useMemo(
    () => `/api/listings/ebay/overview?marketplace=${activeMarket}`,
    [activeMarket],
  )
  const { data: overview, loading } = usePolledList<EbayOverview>({
    url: overviewUrl,
    intervalMs: 30_000,
    invalidationTypes: [
      'listing.updated',
      'listing.created',
      'listing.deleted',
      'bulk-job.completed',
      'wizard.submitted',
    ],
  })

  // Marketplace tab counts come from the marketplaceBreakdown which
  // is unfiltered (intentional — the strip shows all-eBay counts).
  const marketCount = (mp: string): number =>
    overview?.marketplaceBreakdown.find((b) => b.marketplace === mp)?.count ?? 0

  const tabs = useMemo(
    () =>
      EBAY_MARKETS.map((mp) => ({
        id: mp,
        label: (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-mono text-xs">{mp}</span>
            <span className="text-xs text-slate-400">{COUNTRY_NAMES[mp] ?? mp}</span>
          </span>
        ),
        count: marketCount(mp) || undefined,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overview?.marketplaceBreakdown],
  )

  return (
    <div className="space-y-4">
      {/* Marketplace tab strip — only when route is /listings/ebay
          (not /listings/ebay/[market]); locked routes already encode
          the choice in the URL. */}
      {!lockMarketplace && (
        <Tabs
          tabs={tabs}
          activeTab={activeMarket}
          onChange={(mp) => setActiveMarket(mp)}
          className="bg-white border-b-0"
        />
      )}

      {/* KPI strip — eBay-specific overview metrics */}
      <EbayKpiStrip overview={overview} loading={loading} />

      {/* Workspace below — grid / health / matrix / drafts / drawer /
          bulk bar all unchanged. lockChannel + lockMarketplace filter
          to the active eBay market. */}
      <ListingsWorkspace
        lockChannel="EBAY"
        lockMarketplace={activeMarket}
        breadcrumbs={breadcrumbs}
      />
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// EbayKpiStrip — KPI tiles using eBay-specific aggregates.
//
// Layout matches Amazon's 5-tile grid for visual consistency between
// the two Path B surfaces. Tiles: Live, Avg watchers, Total views,
// Active markdowns, Active campaigns. Empty / no-data states surface
// '—' with an honest sub-text so the operator doesn't mistake
// "engagement coverage 0%" for "engagement = 0".
// ────────────────────────────────────────────────────────────────────
function EbayKpiStrip({
  overview,
  loading,
}: {
  overview: EbayOverview | null
  loading: boolean
}) {
  if (loading && !overview) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}>
            <Skeleton variant="text" lines={2} />
          </Card>
        ))}
      </div>
    )
  }
  if (!overview) return null

  const { counts, engagement, markdowns, campaigns } = overview

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <KpiTile
        label="Live"
        value={counts.live}
        sub={`${counts.total} total`}
        tone="success"
      />
      <KpiTile
        label="Avg watchers"
        value={
          engagement.avgWatchers != null
            ? engagement.avgWatchers.toFixed(1)
            : '—'
        }
        sub={
          engagement.coverage === 0
            ? 'no snapshots yet'
            : `${engagement.coverage}% coverage`
        }
        tone="default"
      />
      <KpiTile
        label="Total views"
        value={engagement.totalHits.toLocaleString()}
        sub={
          engagement.totalQuestions > 0
            ? `${engagement.totalQuestions} unanswered Q`
            : 'no open questions'
        }
        tone={engagement.totalQuestions > 0 ? 'warning' : 'default'}
      />
      <Link
        href="/listings/ebay/markdowns"
        className="block hover:shadow-sm rounded transition"
        aria-label="Manage markdowns"
      >
        <Card>
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1">
            Active markdowns
          </div>
          <div
            className={`text-[24px] font-semibold tabular-nums leading-none ${
              markdowns.activeListingCount > 0 ? 'text-amber-700' : 'text-slate-900'
            }`}
          >
            {markdowns.activeListingCount}
          </div>
          <div className="text-sm text-blue-600 mt-1">manage markdowns →</div>
        </Card>
      </Link>
      <Link
        href="/listings/ebay/campaigns"
        className="block hover:shadow-sm rounded transition"
        aria-label="Manage Promoted Listings campaigns"
      >
        <Card>
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1 inline-flex items-center gap-1">
            <Megaphone size={11} className="text-slate-400" /> Promoted campaigns
          </div>
          <div
            className={`text-[24px] font-semibold tabular-nums leading-none ${
              campaigns.activeCount > 0 ? 'text-emerald-700' : 'text-slate-900'
            }`}
          >
            {campaigns.activeCount}
          </div>
          <div className="text-sm text-blue-600 mt-1">manage campaigns →</div>
        </Card>
      </Link>
    </div>
  )
}

function KpiTile({
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
