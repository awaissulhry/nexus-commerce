'use client'

/**
 * UX.3 — Reviews Overview (the kid-simple hero).
 *
 * One screen, channel + market scoped (from the global filter in ReviewsNav):
 *   • big star rating + distribution + trend (RatingPanel)
 *   • "What customers love" / "What needs fixing" — Amazon official review THEMES
 *     with customer snippets (Amazon shares themes, not full text)
 *   • recent individual reviews (eBay / imported) below
 *   • an honest data-source banner when a channel needs setup (e.g. Amazon needs
 *     the Brand Analytics role) — never a fake "0 reviews".
 *
 * Client component: the global filter updates the URL client-side, so this reads
 * useSearchParams and re-fetches /reviews/overview on change. The 8 power-tools
 * (spikes, heatmap, automation, …) live under Advanced.
 */

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Star, ThumbsUp, ThumbsDown, Info } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsList } from './ReviewsList'
import { RatingPanel, type RatingsPayload } from './RatingPanel'
import { ReviewsNav } from './_shared/ReviewsNav'

interface Topic { topic: string; mentionCount: number | null; ratingImpact: number | null; snippets: string[] }
interface Overview {
  channel: string
  marketplace: string
  insights: { starRating: number | null; reviewCount: number; positiveTopics: Topic[]; negativeTopics: Topic[]; accessStatus: string; asins: number } | null
  reviews: { average: number | null; count: number; distribution: Record<string, number>; trend: { date: string; avg: number | null; count: number }[]; total: number }
  status: { amazonInsights: string | null; ebayLiveEnabled: boolean; mode: string }
}

export default function ReviewsOverviewPage() {
  const params = useSearchParams()
  const channel = params.get('channel') ?? 'ALL'
  const market = params.get('market') ?? 'ALL'
  const [data, setData] = useState<Overview | null>(null)

  useEffect(() => {
    let alive = true
    const qs = new URLSearchParams()
    if (channel !== 'ALL') qs.set('channel', channel)
    if (market !== 'ALL') qs.set('market', market)
    void fetch(`${getBackendUrl()}/api/reviews/overview?${qs.toString()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive) setData(d) })
      .catch(() => {})
    return () => { alive = false }
  }, [channel, market])

  const showAmazon = channel === 'ALL' || channel === 'AMAZON'
  const insights = data?.insights ?? null
  const access = insights?.accessStatus
  const needsRole = access === 'NEEDS_BRAND_ANALYTICS_ROLE'
  const insightsOff = access === 'OFF' || access === 'PENDING'
  const ebayOff = channel === 'EBAY' && data ? !data.status.ebayLiveEnabled : false

  // RatingPanel: Amazon-only → use the official insight rating; otherwise the
  // individual-review rating (eBay/imported).
  const ratings: RatingsPayload = {
    sinceDays: 90,
    marketplace: market === 'ALL' ? null : market,
    average: channel === 'AMAZON' && insights?.starRating != null ? insights.starRating : data?.reviews.average ?? null,
    count: channel === 'AMAZON' && insights ? insights.reviewCount : data?.reviews.count ?? 0,
    distribution: data?.reviews.distribution ?? { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    trend: data?.reviews.trend ?? [],
  }

  return (
    <div className="px-4 py-4">
      <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2 flex items-center gap-2">
        <Star className="h-5 w-5 text-amber-500" aria-hidden="true" /> Reviews
      </h1>
      <ReviewsNav />

      {(needsRole || insightsOff || ebayOff) && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          <Info className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {needsRole
              ? 'Amazon review insights need the Brand Analytics role on your SP-API app. Once granted, the rating and “what customers love / needs fixing” populate automatically — official, no scraping.'
              : insightsOff
                ? 'Amazon review insights are off. Enable them (set NEXUS_ENABLE_AMAZON_REVIEW_INSIGHTS=1) once the Brand Analytics role is granted.'
                : 'eBay feedback sync is off. Turn it on (NEXUS_EBAY_REAL_API=true) to pull buyer feedback automatically.'}
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 mb-3">
        <RatingPanel ratings={ratings} />
        {showAmazon && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <TopicCard kind="love" topics={insights?.positiveTopics ?? []} ok={access === 'OK'} />
            <TopicCard kind="fix" topics={insights?.negativeTopics ?? []} ok={access === 'OK'} />
          </div>
        )}
      </div>

      {showAmazon && (
        <p className="text-xs text-tertiary dark:text-slate-500 mb-4">
          Amazon shares review <em>themes</em>, not full text. For individual reviews, enable eBay or import from Advanced.
        </p>
      )}

      <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Recent reviews</h2>
      <ReviewsList initial={[]} />
    </div>
  )
}

function TopicCard({ kind, topics, ok }: { kind: 'love' | 'fix'; topics: Topic[]; ok: boolean }) {
  const isLove = kind === 'love'
  return (
    <div className="rounded-lg border border-default dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
      <div className={`flex items-center gap-1.5 mb-2 text-sm font-medium ${isLove ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}>
        {isLove ? <ThumbsUp className="h-4 w-4" aria-hidden="true" /> : <ThumbsDown className="h-4 w-4" aria-hidden="true" />}
        {isLove ? 'What customers love' : 'What needs fixing'}
      </div>
      {!ok || topics.length === 0 ? (
        <p className="text-xs text-tertiary">{ok ? 'No themes yet.' : 'Needs Amazon Brand Analytics access.'}</p>
      ) : (
        <ul className="space-y-2">
          {topics.map((t) => (
            <li key={t.topic} className="text-sm">
              <span className="font-medium text-slate-800 dark:text-slate-200">{t.topic}</span>
              {t.mentionCount != null && <span className="text-xs text-tertiary ml-1">· {t.mentionCount}</span>}
              {t.snippets[0] && <span className="block text-xs text-slate-500 dark:text-slate-400 italic truncate">“{t.snippets[0]}”</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
