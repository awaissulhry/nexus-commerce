'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import {
  Sparkles,
  Loader2,
  ThumbsUp,
  ThumbsDown,
  TrendingUp,
  Wrench,
  AlertTriangle,
} from 'lucide-react'

interface SpotlightContent {
  sentiment: {
    positive: number
    neutral: number
    negative: number
    total: number
    avgRating: number | null
  }
  complaints: { theme: string; count: number; severity: 'high' | 'medium' | 'low'; quotes: string[] }[]
  praises: { theme: string; count: number; quotes: string[] }[]
  emerging: { theme: string; note: string }[]
  recommendations: { title: string; detail: string; area: string; sku?: string }[]
}

export interface Spotlight {
  id: string
  productId: string | null
  marketplace: string | null
  windowDays: number
  reviewCount: number
  headline: string | null
  content: SpotlightContent
  model: string | null
  usedAi: boolean
  generatedAt: string
}

const SEVERITY_TONE: Record<string, string> = {
  high: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900',
  medium: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  low: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
}

const AREA_TONE: Record<string, string> = {
  listing: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900',
  content: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-900',
  product: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
  ops: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
}

export function SpotlightClient({ initial }: { initial: Spotlight | null }) {
  const [spotlight, setSpotlight] = useState<Spotlight | null>(initial)
  const [windowDays, setWindowDays] = useState(initial?.windowDays ?? 30)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generate = useCallback(async () => {
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch('/api/reviews/spotlight/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowDays }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.message || 'Generation failed')
      setSpotlight(json.spotlight as Spotlight)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }, [windowDays])

  const c = spotlight?.content
  const s = c?.sentiment

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs text-slate-500 dark:text-slate-400">
          Window
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            className="ml-1.5 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>
        <button
          type="button"
          onClick={generate}
          disabled={generating}
          className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md ring-1 ring-inset bg-violet-600 text-white ring-violet-600 hover:bg-violet-700 disabled:opacity-40"
        >
          {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {spotlight ? 'Regenerate brief' : 'Generate brief'}
        </button>
        {spotlight && (
          <span className="text-xs text-slate-400">
            {spotlight.usedAi ? 'AI' : 'heuristic'} · {spotlight.reviewCount} reviews ·{' '}
            {new Date(spotlight.generatedAt).toLocaleString()}
          </span>
        )}
        {error && (
          <span className="inline-flex items-center gap-1 text-xs text-rose-600 dark:text-rose-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            {error}
          </span>
        )}
      </div>

      {!spotlight ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-10 text-center">
          <Sparkles className="h-6 w-6 mx-auto text-violet-400 mb-2" />
          <div className="text-sm text-slate-600 dark:text-slate-300">
            No brief yet. Generate one to see the Voice of the Customer.
          </div>
        </div>
      ) : (
        <>
          {/* Headline + sentiment mix */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md p-3">
            <div className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-2">
              {spotlight.headline}
            </div>
            {s && s.total > 0 && (
              <>
                <div className="flex h-2 rounded-full overflow-hidden mb-1">
                  <div className="bg-emerald-500" style={{ width: `${(s.positive / s.total) * 100}%` }} />
                  <div className="bg-slate-300 dark:bg-slate-600" style={{ width: `${(s.neutral / s.total) * 100}%` }} />
                  <div className="bg-rose-500" style={{ width: `${(s.negative / s.total) * 100}%` }} />
                </div>
                <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                  <span className="text-emerald-600 dark:text-emerald-400">{s.positive} positive</span>
                  <span>{s.neutral} neutral</span>
                  <span className="text-rose-600 dark:text-rose-400">{s.negative} negative</span>
                  {s.avgRating != null && <span className="ml-auto">avg {s.avgRating.toFixed(2)}★</span>}
                </div>
              </>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {/* Complaints */}
            <Section icon={<ThumbsDown className="h-4 w-4 text-rose-500" />} title="Top complaints">
              {c!.complaints.length === 0 ? (
                <Empty>No dominant complaints 🎉</Empty>
              ) : (
                c!.complaints.map((x, i) => (
                  <div key={i} className="py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{x.theme}</span>
                      <span className="text-xs text-slate-400">{x.count}</span>
                      <span className={`ml-auto text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset ${SEVERITY_TONE[x.severity]}`}>
                        {x.severity}
                      </span>
                    </div>
                    {x.quotes.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {x.quotes.map((q, j) => (
                          <li key={j} className="text-xs italic text-slate-500 dark:text-slate-400">“{q}”</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))
              )}
            </Section>

            {/* Praises */}
            <Section icon={<ThumbsUp className="h-4 w-4 text-emerald-500" />} title="What customers love">
              {c!.praises.length === 0 ? (
                <Empty>No clear praise themes yet.</Empty>
              ) : (
                c!.praises.map((x, i) => (
                  <div key={i} className="py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{x.theme}</span>
                      <span className="text-xs text-slate-400">{x.count}</span>
                    </div>
                    {x.quotes.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {x.quotes.map((q, j) => (
                          <li key={j} className="text-xs italic text-slate-500 dark:text-slate-400">“{q}”</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))
              )}
            </Section>

            {/* Emerging */}
            {c!.emerging.length > 0 && (
              <Section icon={<TrendingUp className="h-4 w-4 text-amber-500" />} title="Emerging issues">
                {c!.emerging.map((x, i) => (
                  <div key={i} className="py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{x.theme}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{x.note}</div>
                  </div>
                ))}
              </Section>
            )}

            {/* Recommendations */}
            <Section icon={<Wrench className="h-4 w-4 text-blue-500" />} title="Recommended actions">
              {c!.recommendations.length === 0 ? (
                <Empty>No actions needed right now.</Empty>
              ) : (
                c!.recommendations.map((x, i) => (
                  <div key={i} className="py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{x.title}</span>
                      <span className={`ml-auto text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset ${AREA_TONE[x.area] ?? AREA_TONE.product}`}>
                        {x.area}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{x.detail}</div>
                  </div>
                ))
              )}
            </Section>
          </div>

          <div className="text-[11px] text-slate-400">
            <Link href="/marketing/reviews/desk" className="text-blue-600 dark:text-blue-400 hover:underline">
              Open the Response Desk
            </Link>{' '}
            to act on the negative reviews behind these themes.
          </div>
        </>
      )}
    </div>
  )
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
        {icon}
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{title}</div>
      </div>
      <div className="px-3 py-1">{children}</div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-slate-500 dark:text-slate-400 py-3">{children}</div>
}
