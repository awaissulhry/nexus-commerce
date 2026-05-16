/**
 * CE.5 — Cross-RMN Feed Export: Feed Status Dashboard.
 *
 * Google Shopping (GMC) + Meta Product Catalog feeds, inventory-aware.
 * Products below stock threshold are suppressed (availability=out_of_stock).
 * Feed transform rules (CE.1) are applied before export so titles, descriptions,
 * and custom labels match the channel-optimized versions.
 */

import { Rss, Download } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { FeedsClient } from './FeedsClient'

export const dynamic = 'force-dynamic'

interface FeedPreviewSummary {
  gmc: {
    summary: { total: number; inStock: number; outOfStock: number; generatedAt: string }
    sampleItems?: unknown[]
  }
  meta: {
    summary: { total: number; inStock: number; outOfStock: number; generatedAt: string }
    sampleItems?: unknown[]
  }
}

async function fetchPreview(): Promise<FeedPreviewSummary | null> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/feed-export/preview`, {
      cache: 'no-store',
    })
    if (!res.ok) return null
    return (await res.json()) as FeedPreviewSummary
  } catch {
    return null
  }
}

export default async function FeedsPage() {
  const preview = await fetchPreview()

  return (
    <div className="px-4 py-4 max-w-4xl">
      <div className="flex items-start gap-3 mb-5">
        <Rss className="h-6 w-6 text-violet-600 dark:text-violet-400 mt-0.5 shrink-0" />
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Cross-RMN Feeds
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Google Merchant Center (GMC) and Meta Product Catalog feeds. CE.1 transform
            rules are applied at export time — out-of-stock products are automatically
            suppressed. Feeds are generated fresh on each request.
          </p>
        </div>
      </div>

      {/* Feed cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <FeedCard
          title="Google Merchant Center"
          subtitle="RSS/XML feed for Google Shopping"
          format="GMC XML"
          endpoint="/api/feed-export/gmc.xml"
          summary={preview?.gmc.summary ?? null}
          downloadLabel="Download GMC XML"
        />
        <FeedCard
          title="Meta Product Catalog"
          subtitle="JSON feed for Facebook & Instagram Shopping"
          format="Meta JSON"
          endpoint="/api/feed-export/meta.json"
          summary={preview?.meta.summary ?? null}
          downloadLabel="Download Meta JSON"
        />
      </div>

      <FeedsClient />

      {/* How it works */}
      <section className="mt-6">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          How feeds are generated
        </h2>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-3 text-sm text-slate-600 dark:text-slate-400 space-y-2">
          <div className="flex items-start gap-2">
            <span className="font-mono text-violet-600 dark:text-violet-400 text-xs mt-0.5">1</span>
            <span>
              <strong className="text-slate-900 dark:text-slate-100">Transform</strong> — CE.1
              FeedTransformRule rules are evaluated per-product. Title, description, and custom
              label fields use the channel-optimized values.
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className="font-mono text-violet-600 dark:text-violet-400 text-xs mt-0.5">2</span>
            <span>
              <strong className="text-slate-900 dark:text-slate-100">Suppress</strong> — Products
              with{' '}
              <code className="text-[11px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
                totalStock ≤ 0
              </code>{' '}
              are included with{' '}
              <code className="text-[11px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
                availability=out_of_stock
              </code>
              {' '}so Google/Meta can pause bids automatically.
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className="font-mono text-violet-600 dark:text-violet-400 text-xs mt-0.5">3</span>
            <span>
              <strong className="text-slate-900 dark:text-slate-100">Export</strong> — Feed is
              generated fresh on each request. The daily cron (06:00 UTC) logs summary stats.
              Point Google Merchant Center + Meta Catalog to the{' '}
              <code className="text-[11px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
                /api/feed-export/
              </code>{' '}
              endpoints for automatic scheduled fetches.
            </span>
          </div>
        </div>
      </section>

      {/* Env config */}
      <section className="mt-4">
        <div className="bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-3 text-xs text-slate-600 dark:text-slate-400 space-y-1.5">
          <div className="flex items-start gap-2 flex-wrap">
            <code className="shrink-0 px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-300">
              NEXUS_FEED_EXPORT_SCHEDULE=0 6 * * *
            </code>
            <span className="text-slate-500">Override the daily generation cron schedule</span>
          </div>
        </div>
      </section>
    </div>
  )
}

function FeedCard({
  title,
  subtitle,
  format,
  endpoint,
  summary,
  downloadLabel,
}: {
  title: string
  subtitle: string
  format: string
  endpoint: string
  summary: { total: number; inStock: number; outOfStock: number; generatedAt: string } | null
  downloadLabel: string
}) {
  const backend = getBackendUrl()
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md p-4">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>
        </div>
        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700 font-medium">
          {format}
        </span>
      </div>

      {summary && (
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Total</div>
            <div className="text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">{summary.total}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">In stock</div>
            <div className="text-base font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">{summary.inStock}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Suppressed</div>
            <div className="text-base font-semibold tabular-nums text-amber-700 dark:text-amber-400">{summary.outOfStock}</div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <a
          href={`${backend}${endpoint}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded ring-1 ring-inset ring-slate-300 dark:ring-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          <Download className="h-3.5 w-3.5" />
          {downloadLabel}
        </a>
        {summary?.generatedAt && (
          <span className="text-[10px] text-slate-400">
            {new Date(summary.generatedAt).toLocaleDateString('en-GB', {
              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            })}
          </span>
        )}
      </div>
    </div>
  )
}
