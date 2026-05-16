/**
 * SR.2 — Per-product sentiment drill-down.
 *
 * Server-rendered. Shows:
 *   - product header + SKU link
 *   - 90d daily-totals sparkline (positive/neutral/negative stacked)
 *   - 30d category breakdown (with negative tilt color)
 *   - last 30 review cards
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft, Star } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsNav, CATEGORY_LABEL } from '../../_shared/ReviewsNav'

export const dynamic = 'force-dynamic'

interface TimelineDay {
  date: string
  total: number
  positive: number
  neutral: number
  negative: number
}

interface CategoryAgg {
  category: string
  total: number
  positive: number
  neutral: number
  negative: number
}

interface RecentReview {
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
}

interface TimelinePayload {
  product: { id: string; sku: string; name: string; productType: string | null } | null
  timeline: TimelineDay[]
  categories: CategoryAgg[]
  recent: RecentReview[]
  sinceDays: number
  marketplace: string | null
}

async function fetchPayload(id: string): Promise<TimelinePayload | null> {
  try {
    const res = await fetch(
      `${getBackendUrl()}/api/reviews/products/${id}/timeline?sinceDays=90`,
      { cache: 'no-store' },
    )
    if (!res.ok) return null
    return (await res.json()) as TimelinePayload
  } catch {
    return null
  }
}

export default async function ProductReviewDrillDown({
  params,
}: {
  params: { id: string }
}) {
  const data = await fetchPayload(params.id)
  if (!data?.product) notFound()
  const p = data.product

  // 30d aggregates from the timeline tail.
  const last30 = data.timeline.filter((d) => {
    const dd = new Date(d.date)
    return Date.now() - dd.getTime() < 30 * 24 * 60 * 60 * 1000
  })
  const t30 = last30.reduce(
    (a, d) => {
      a.total += d.total
      a.positive += d.positive
      a.neutral += d.neutral
      a.negative += d.negative
      return a
    },
    { total: 0, positive: 0, neutral: 0, negative: 0 },
  )
  const negativePct = t30.total > 0 ? t30.negative / t30.total : 0

  const maxDayTotal = Math.max(1, ...data.timeline.map((d) => d.total))

  return (
    <div className="px-4 py-4">
      <div className="mb-2">
        <Link
          href="/marketing/reviews/by-product"
          className="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
        >
          <ChevronLeft className="h-3 w-3" /> Per prodotto
        </Link>
      </div>
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
        <Star className="h-5 w-5 text-amber-500" />
        {p.name}
      </h1>
      <div className="text-xs text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-2 flex-wrap">
        <Link
          href={`/products/${p.id}`}
          className="font-mono text-blue-600 dark:text-blue-400 hover:underline"
        >
          {p.sku}
        </Link>
        {p.productType && (
          <>
            <span>·</span>
            <span className="font-mono">{p.productType}</span>
          </>
        )}
      </div>
      <ReviewsNav />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <Stat label="Reviews 30d" value={t30.total} />
        <Stat label="Positive" value={t30.positive} tone="emerald" />
        <Stat label="Negative" value={t30.negative} tone={t30.negative > 0 ? 'rose' : null} />
        <Stat
          label="% negative"
          value={t30.total > 0 ? `${(negativePct * 100).toFixed(1)}%` : '—'}
          tone={negativePct > 0.15 ? 'rose' : negativePct > 0.05 ? 'amber' : null}
        />
        <Stat label="Period" value={`${data.sinceDays}d`} />
      </div>

      {/* Timeline sparkline */}
      <section className="mb-6">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Timeline (daily volume {data.sinceDays}d)
        </h2>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md p-3 overflow-x-auto">
          {data.timeline.length === 0 ? (
            <div className="text-sm text-slate-500 py-4 text-center">
              No daily data for this product in {data.sinceDays}d.
            </div>
          ) : (
            <div className="flex items-end gap-0.5 min-w-[600px] h-32">
              {data.timeline.map((d) => {
                const h = Math.max(2, (d.total / maxDayTotal) * 120)
                const posH = d.total > 0 ? (d.positive / d.total) * h : 0
                const negH = d.total > 0 ? (d.negative / d.total) * h : 0
                const neuH = h - posH - negH
                return (
                  <div
                    key={d.date}
                    className="flex flex-col-reverse items-stretch min-w-[10px] flex-1"
                    title={`${d.date} · total ${d.total} · pos ${d.positive} · neu ${d.neutral} · neg ${d.negative}`}
                  >
                    <div
                      className="bg-rose-500 dark:bg-rose-600"
                      style={{ height: `${negH}px` }}
                    />
                    <div
                      className="bg-slate-300 dark:bg-slate-600"
                      style={{ height: `${neuH}px` }}
                    />
                    <div
                      className="bg-emerald-500 dark:bg-emerald-600"
                      style={{ height: `${posH}px` }}
                    />
                  </div>
                )
              })}
            </div>
          )}
          <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-4">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-sm bg-emerald-500" />
              Positive
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-sm bg-slate-300 dark:bg-slate-600" />
              Neutral
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-sm bg-rose-500" />
              Negative
            </span>
          </div>
        </div>
      </section>

      {/* Category breakdown */}
      <section className="mb-6">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Categories (last 30d)
        </h2>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
          {data.categories.length === 0 ? (
            <div className="px-3 py-4 text-sm text-slate-500 text-center">
              No categorization available.
            </div>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {data.categories.map((c) => {
                const rate = c.total > 0 ? c.negative / c.total : 0
                return (
                  <li key={c.category} className="px-3 py-2 flex items-center gap-3 flex-wrap">
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {CATEGORY_LABEL[c.category] ?? c.category}
                    </span>
                    <span className="text-xs text-slate-500 tabular-nums">
                      {c.total} total ({c.positive}/{c.neutral}/{c.negative})
                    </span>
                    <span
                      className={`ml-auto text-[11px] tabular-nums px-1.5 py-0.5 rounded ring-1 ring-inset ${
                        rate >= 0.3
                          ? 'bg-rose-100 text-rose-800 ring-rose-300 dark:bg-rose-950/60 dark:text-rose-200 dark:ring-rose-800'
                          : rate >= 0.15
                            ? 'bg-amber-100 text-amber-800 ring-amber-300 dark:bg-amber-950/60 dark:text-amber-200 dark:ring-amber-800'
                            : 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900'
                      }`}
                    >
                      {(rate * 100).toFixed(0)}% negative
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </section>

      {/* Recent reviews */}
      <section>
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Recent reviews ({data.recent.length})
        </h2>
        <ul className="space-y-2">
          {data.recent.map((r) => (
            <li
              key={r.id}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md p-3"
            >
              <div className="flex items-center gap-2 flex-wrap mb-1">
                {r.sentiment && (
                  <span
                    className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset ${
                      r.sentiment.label === 'POSITIVE'
                        ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900'
                        : r.sentiment.label === 'NEGATIVE'
                          ? 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900'
                          : 'bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700'
                    }`}
                  >
                    {r.sentiment.label === 'POSITIVE'
                      ? 'Positive'
                      : r.sentiment.label === 'NEGATIVE'
                        ? 'Negative'
                        : 'Neutral'}
                  </span>
                )}
                {r.rating != null && (
                  <span className="inline-flex items-center gap-0.5">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Star
                        key={i}
                        className={`h-3 w-3 ${
                          i < (r.rating ?? 0)
                            ? 'text-amber-500 fill-amber-500'
                            : 'text-slate-300 dark:text-slate-700'
                        }`}
                      />
                    ))}
                  </span>
                )}
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                  {r.channel} · {r.marketplace ?? '—'}
                </span>
                <span className="ml-auto text-xs text-slate-500">
                  {new Date(r.postedAt).toLocaleDateString('en-GB', {
                    month: '2-digit',
                    day: '2-digit',
                  })}
                </span>
              </div>
              {r.title && (
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {r.title}
                </div>
              )}
              <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap mt-1">
                {r.body}
              </p>
              {r.sentiment?.categories && r.sentiment.categories.length > 0 && (
                <div className="mt-2 flex items-center gap-1 flex-wrap">
                  {r.sentiment.categories.map((c) => (
                    <span
                      key={c}
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900"
                    >
                      {CATEGORY_LABEL[c] ?? c}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
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
