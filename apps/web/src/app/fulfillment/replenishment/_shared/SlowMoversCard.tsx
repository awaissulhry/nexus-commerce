'use client'

/**
 * W6.1 — Slow-mover / dead-stock card.
 *
 * The audit found 264 D-class SKUs going unused — capital just sitting
 * on shelves with no UI surface. This card ranks dormant inventory
 * by EUR-cents tied up so the operator sees the biggest write-off /
 * markdown candidates first.
 *
 * Default view: DORMANT bucket (no movement >180 days OR never).
 * Operator can switch to SLOW (>90 days), OK (<=90), or ALL.
 *
 * v0 is read-only visibility. The action handles ("Suggest markdown",
 * "Mark for write-off") land in W6.2 once the markdown handoff to
 * /pricing exists.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Snowflake, Clock, ExternalLink } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

type Bucket = 'DORMANT' | 'SLOW' | 'OK' | 'ALL'

interface SlowMoverRow {
  id: string
  sku: string
  name: string | null
  abcClass: string | null
  totalStock: number
  unitCostCents: number | null
  capitalTiedUpCents: number
  lastMovementAt: string | null
  daysSinceLastMovement: number | null
  bucket: 'DORMANT' | 'SLOW' | 'OK'
}

interface SlowMoverResponse {
  totals: {
    rows: number
    totalCapitalTiedUpCents: number
    totalUnits: number
  }
  rows: SlowMoverRow[]
}

function formatEur(cents: number): string {
  if (!Number.isFinite(cents)) return '—'
  if (cents >= 100_000_00) return `€${(cents / 100_000_00).toFixed(1)}M`
  if (cents >= 1_000_00) return `€${(cents / 100_000).toFixed(1)}K`
  return `€${(cents / 100).toFixed(0)}`
}

const BUCKET_TONES: Record<SlowMoverRow['bucket'], string> = {
  DORMANT:
    'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900',
  SLOW: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  OK: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
}

export function SlowMoversCard() {
  const { t } = useTranslations()
  const [bucket, setBucket] = useState<Bucket>('DORMANT')
  const [data, setData] = useState<SlowMoverResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/slow-movers?bucket=${bucket}&limit=50`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled) setData(json)
      })
      .catch(() => {
        if (!cancelled) setData(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [bucket])

  if (loading && !data) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 text-xs text-slate-500">
        {t('replenishment.slowMovers.loading')}
      </div>
    )
  }

  if (!data || data.totals.rows === 0) {
    // Don't show the card at all if nothing's slow — no need to
    // clutter the workspace with empty good-news state.
    if (bucket === 'DORMANT') return null
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 text-xs text-slate-500">
        {t('replenishment.slowMovers.noneInBucket')}
      </div>
    )
  }

  const buckets: Array<{ key: Bucket; label: string }> = [
    { key: 'DORMANT', label: t('replenishment.slowMovers.bucket.dormant') },
    { key: 'SLOW', label: t('replenishment.slowMovers.bucket.slow') },
    { key: 'OK', label: t('replenishment.slowMovers.bucket.ok') },
    { key: 'ALL', label: t('replenishment.slowMovers.bucket.all') },
  ]

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 flex-wrap">
        <Snowflake
          className="h-4 w-4 text-slate-500 dark:text-slate-400"
          aria-hidden="true"
        />
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('replenishment.slowMovers.header.title')}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {t('replenishment.slowMovers.header.summary', {
            rows: data.totals.rows,
            capital: formatEur(data.totals.totalCapitalTiedUpCents),
            units: data.totals.totalUnits.toLocaleString(),
          })}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {buckets.map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => setBucket(b.key)}
              className={cn(
                'text-xs px-2 py-1 rounded ring-1 ring-inset',
                bucket === b.key
                  ? 'bg-slate-900 dark:bg-slate-700 text-white border-slate-900 dark:border-slate-700'
                  : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700',
              )}
              aria-pressed={bucket === b.key}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
            <tr>
              <th className="text-left px-3 py-1.5 font-semibold">
                {t('replenishment.slowMovers.col.sku')}
              </th>
              <th className="text-left px-3 py-1.5 font-semibold">
                {t('replenishment.slowMovers.col.abc')}
              </th>
              <th className="text-right px-3 py-1.5 font-semibold">
                {t('replenishment.slowMovers.col.stock')}
              </th>
              <th className="text-right px-3 py-1.5 font-semibold">
                {t('replenishment.slowMovers.col.capital')}
              </th>
              <th className="text-right px-3 py-1.5 font-semibold">
                {t('replenishment.slowMovers.col.dormancy')}
              </th>
              <th className="text-right px-3 py-1.5 font-semibold">
                {t('replenishment.slowMovers.col.bucket')}
              </th>
              <th className="text-right px-3 py-1.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {data.rows.map((r) => (
              <tr
                key={r.id}
                className="hover:bg-slate-50 dark:hover:bg-slate-950/50"
              >
                <td className="px-3 py-1.5">
                  <div className="font-medium text-slate-900 dark:text-slate-100">
                    {r.sku}
                  </div>
                  {r.name && (
                    <div className="text-[10px] text-slate-500 dark:text-slate-400 line-clamp-1">
                      {r.name}
                    </div>
                  )}
                </td>
                <td className="px-3 py-1.5 text-slate-600 dark:text-slate-400">
                  {r.abcClass ?? '—'}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-slate-900 dark:text-slate-100">
                  {r.totalStock.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums font-medium text-slate-900 dark:text-slate-100">
                  {formatEur(r.capitalTiedUpCents)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-400">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3" aria-hidden="true" />
                    {r.daysSinceLastMovement == null
                      ? t('replenishment.slowMovers.never')
                      : t('replenishment.slowMovers.daysAgo', {
                          d: r.daysSinceLastMovement,
                        })}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right">
                  <span
                    className={cn(
                      'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset font-medium',
                      BUCKET_TONES[r.bucket],
                    )}
                  >
                    {t(`replenishment.slowMovers.bucket.${r.bucket.toLowerCase()}`)}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right">
                  <Link
                    href={`/products/${r.id}`}
                    className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
                    title={t('replenishment.slowMovers.openProduct')}
                  >
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
