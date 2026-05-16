/**
 * SR.1 — Sentient Review Loop workspace.
 *
 * Three-column layout:
 *   - left/main: review feed with sentiment + category chips, filters
 *   - top: KPI strip (counts, top categories, open spikes)
 *   - right rail (md+): open-spike feed with acknowledge/resolve
 *
 * AD-pattern compliance: sandbox/live mode chip, Italian-first strings,
 * Salesforce density.
 */

import { Star, AlertTriangle, Sparkles } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsList } from './ReviewsList'
import { SpikeFeed } from './SpikeFeed'
import { ReviewsNav } from './_shared/ReviewsNav'

export const dynamic = 'force-dynamic'

interface SummaryPayload {
  sinceDays: number
  marketplace: string | null
  totalReviews: number
  pendingExtract: number
  counts: { POSITIVE: number; NEUTRAL: number; NEGATIVE: number }
  negativePct: number | null
  topCategories: { category: string; count: number }[]
  openSpikes: number
}

interface ReviewRow {
  id: string
  channel: string
  marketplace: string | null
  rating: number | null
  title: string | null
  body: string
  authorName: string | null
  verifiedPurchase: boolean
  postedAt: string
  sentiment: {
    label: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
    score: string
    categories: string[]
    topPhrases: string[]
  } | null
  product: { id: string; sku: string; name: string; productType: string | null } | null
}

interface SpikeRow {
  id: string
  marketplace: string
  category: string
  rate7dNumerator: number
  rate7dDenominator: number
  rate28dNumerator: number
  rate28dDenominator: number
  spikeMultiplier: string | null
  sampleTopPhrases: string[]
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'
  detectedAt: string
  acknowledgedAt: string | null
  product: { id: string; sku: string; name: string } | null
}

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

const CATEGORY_LABEL: Record<string, string> = {
  FIT_SIZING: 'Fit / Sizing',
  DURABILITY: 'Durability',
  SHIPPING: 'Shipping',
  VALUE: 'Value',
  DESIGN: 'Design',
  QUALITY: 'Quality',
  SAFETY: 'Safety',
  COMFORT: 'Comfort',
  OTHER: 'Other',
}

export default async function ReviewsPage() {
  const backend = getBackendUrl()
  const [summary, reviews, spikes] = await Promise.all([
    fetchJson<SummaryPayload>(`${backend}/api/reviews/summary?sinceDays=30`, {
      sinceDays: 30,
      marketplace: null,
      totalReviews: 0,
      pendingExtract: 0,
      counts: { POSITIVE: 0, NEUTRAL: 0, NEGATIVE: 0 },
      negativePct: null,
      topCategories: [],
      openSpikes: 0,
    }),
    fetchJson<{ items: ReviewRow[] }>(`${backend}/api/reviews?sinceDays=30&limit=100`, {
      items: [],
    }),
    fetchJson<{ items: SpikeRow[] }>(`${backend}/api/reviews/spikes?status=OPEN&limit=20`, {
      items: [],
    }),
  ])

  return (
    <div className="px-4 py-4">
      <div className="flex items-start gap-3 mb-3">
        <Star className="h-6 w-6 text-amber-500 dark:text-amber-400 mt-0.5" />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Sentient Review Loop
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            AI sentiment + categorization (Anthropic Haiku with prompt caching) on every
            review. The spike detector compares the last 7d vs 28d baseline per category —
            spikes feed the automation rule engine (SR.3+).
          </p>
        </div>
        <span className="text-[10px] uppercase tracking-wider px-2 py-1 rounded ring-1 ring-inset bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900">
          Sandbox
        </span>
      </div>

      <ReviewsNav />

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <Stat
          label="Reviews 30d"
          value={summary.totalReviews}
        />
        <Stat
          label="Positive"
          value={summary.counts.POSITIVE}
          tone="emerald"
        />
        <Stat
          label="Negative"
          value={summary.counts.NEGATIVE}
          tone={summary.counts.NEGATIVE > 0 ? 'rose' : null}
        />
        <Stat
          label="% negative"
          value={
            summary.negativePct != null ? `${(summary.negativePct * 100).toFixed(1)}%` : '—'
          }
          tone={
            summary.negativePct != null && summary.negativePct > 0.15
              ? 'rose'
              : summary.negativePct != null && summary.negativePct > 0.05
                ? 'amber'
                : null
          }
        />
        <Stat
          label="Open Spikes"
          value={summary.openSpikes}
          tone={summary.openSpikes > 0 ? 'rose' : null}
        />
      </div>

      {/* Top negative categories strip */}
      {summary.topCategories.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 mb-4">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
            Top negative categories (30d)
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {summary.topCategories.map((c) => (
              <span
                key={c.category}
                className="text-xs px-2 py-0.5 rounded ring-1 ring-inset bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900"
              >
                {CATEGORY_LABEL[c.category] ?? c.category} · {c.count}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        {/* Reviews feed */}
        <section>
          <ReviewsList initial={reviews.items} />
        </section>

        {/* Spike feed (right rail) */}
        <aside className="space-y-3">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
            <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-rose-500 dark:text-rose-400" />
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Open Spikes
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {spikes.items.length}
              </span>
            </div>
            <SpikeFeed initial={spikes.items} />
          </div>
          <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-md px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              <div className="text-xs font-medium text-blue-900 dark:text-blue-200">
                Coming up
              </div>
            </div>
            <ul className="text-[11px] text-blue-800 dark:text-blue-200 space-y-1 list-disc pl-4">
              <li>SR.2 — dashboard heatmap (day × category)</li>
              <li>
                SR.3 — REVIEW_SPIKE_DETECTED actions → create_aplus_module_from_review +
                update_product_bullets_from_review
              </li>
              <li>SR.4 — post-purchase email + optimal send time per productType</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone?: 'emerald' | 'amber' | 'rose' | null
}) {
  const valueClass =
    tone === 'emerald'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'amber'
        ? 'text-amber-700 dark:text-amber-300'
        : tone === 'rose'
          ? 'text-rose-700 dark:text-rose-300'
          : 'text-slate-900 dark:text-slate-100'
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className={`text-base font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  )
}
