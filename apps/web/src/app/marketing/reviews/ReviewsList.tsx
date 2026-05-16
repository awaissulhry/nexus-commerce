'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, MinusCircle, AlertCircle, Star } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

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
  product: { id: string; sku: string; name: string } | null
}

const CATEGORY_LABEL: Record<string, string> = {
  FIT_SIZING: 'Vestibilità',
  DURABILITY: 'Durabilità',
  SHIPPING: 'Spedizione',
  VALUE: 'Prezzo',
  DESIGN: 'Design',
  QUALITY: 'Qualità',
  SAFETY: 'Sicurezza',
  COMFORT: 'Comfort',
  OTHER: 'Altro',
}

export function ReviewsList({ initial }: { initial: ReviewRow[] }) {
  const [items, setItems] = useState<ReviewRow[]>(initial)
  const [labelFilter, setLabelFilter] = useState<string>('')
  const [categoryFilter, setCategoryFilter] = useState<string>('')
  const [marketplaceFilter, setMarketplaceFilter] = useState<string>('')

  useEffect(() => {
    const url = new URL(`${getBackendUrl()}/api/reviews`)
    url.searchParams.set('sinceDays', '30')
    url.searchParams.set('limit', '100')
    if (labelFilter) url.searchParams.set('label', labelFilter)
    if (categoryFilter) url.searchParams.set('category', categoryFilter)
    if (marketplaceFilter) url.searchParams.set('marketplace', marketplaceFilter)
    fetch(url.toString(), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { items: ReviewRow[] } | null) => {
        if (json) setItems(json.items)
      })
      .catch(() => {})
  }, [labelFilter, categoryFilter, marketplaceFilter])

  const marketplaces = useMemo(
    () =>
      Array.from(new Set(initial.map((r) => r.marketplace).filter((m): m is string => !!m))).sort(),
    [initial],
  )
  const categories = useMemo(
    () =>
      Array.from(
        new Set(
          initial
            .flatMap((r) => r.sentiment?.categories ?? [])
            .filter((c): c is string => !!c),
        ),
      ).sort(),
    [initial],
  )

  return (
    <div>
      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <select
          value={labelFilter}
          onChange={(e) => setLabelFilter(e.target.value)}
          className="text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
        >
          <option value="">Tutti i sentimenti</option>
          <option value="POSITIVE">Positive</option>
          <option value="NEUTRAL">Neutre</option>
          <option value="NEGATIVE">Negative</option>
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
        >
          <option value="">Tutte le categorie</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c] ?? c}
            </option>
          ))}
        </select>
        <select
          value={marketplaceFilter}
          onChange={(e) => setMarketplaceFilter(e.target.value)}
          className="text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
        >
          <option value="">Tutti i marketplace</option>
          {marketplaces.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
          {items.length} recensioni
        </span>
      </div>

      {items.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-6 text-center text-sm text-slate-500">
          Nessuna recensione. Esegui l&apos;ingest:{' '}
          <code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
            POST /api/reviews/cron/ingest/trigger
          </code>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((r) => (
            <li
              key={r.id}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md p-3"
            >
              <div className="flex items-start gap-2 flex-wrap">
                <SentimentBadge label={r.sentiment?.label ?? 'NEUTRAL'} score={r.sentiment?.score} />
                {r.rating != null && (
                  <span className="inline-flex items-center gap-0.5 text-xs text-slate-700 dark:text-slate-300">
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
                {r.product ? (
                  <Link
                    href={`/products/${r.product.id}`}
                    className="text-xs font-mono text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {r.product.sku}
                  </Link>
                ) : (
                  <span className="text-xs text-slate-500">SKU non risolto</span>
                )}
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                  {r.channel} · {r.marketplace ?? '—'}
                </span>
                {r.verifiedPurchase && (
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900">
                    Verificato
                  </span>
                )}
                <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
                  {new Date(r.postedAt).toLocaleDateString('it-IT', {
                    month: '2-digit',
                    day: '2-digit',
                  })}
                </span>
              </div>
              {r.title && (
                <div className="mt-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                  {r.title}
                </div>
              )}
              <p className="mt-1 text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
                {r.body}
              </p>
              {r.sentiment && r.sentiment.categories.length > 0 && (
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
              {r.authorName && (
                <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                  — {r.authorName}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SentimentBadge({ label, score }: { label: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'; score?: string }) {
  const tone =
    label === 'POSITIVE'
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900'
      : label === 'NEGATIVE'
        ? 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900'
        : 'bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700'
  const Icon =
    label === 'POSITIVE' ? CheckCircle2 : label === 'NEGATIVE' ? AlertCircle : MinusCircle
  const labelText =
    label === 'POSITIVE' ? 'Positiva' : label === 'NEGATIVE' ? 'Negativa' : 'Neutra'
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset ${tone}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {labelText}
      {score && <span className="font-mono">{Number(score).toFixed(2)}</span>}
    </span>
  )
}
