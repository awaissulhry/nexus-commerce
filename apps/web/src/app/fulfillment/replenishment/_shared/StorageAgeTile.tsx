'use client'

/**
 * AD.1 — Storage Age tile. Surfaces FBA SKUs facing long-term storage
 * fees within the next 30 days. Hides itself when zero rows match —
 * clean accounts / fresh inventory get no clutter.
 *
 * Click-through deep-links to /marketing/advertising/storage-age
 * (lands in AD.2; AD.1 ships the landing as a basic list).
 *
 * Italian-first strings inline (i18n catalog migration deferred to
 * AD.2 polish wave, mirrors the cannibalization-card precedent).
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Warehouse, AlertTriangle, ExternalLink } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface StorageAgeRow {
  id: string
  sku: string
  asin: string | null
  marketplace: string
  daysToLtsThreshold: number | null
  projectedLtsFee30dCents: number
  quantityInAge181_270: number
  quantityInAge271_365: number
  quantityInAge365Plus: number
}

interface StorageAgeResponse {
  items: StorageAgeRow[]
  count: number
}

function formatEur(cents: number): string {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

export function StorageAgeTile() {
  const [data, setData] = useState<StorageAgeResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`${getBackendUrl()}/api/advertising/fba-storage-age?bucket=aging&limit=50`, {
      cache: 'no-store',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: StorageAgeResponse | null) => {
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
  }, [])

  if (loading && !data) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 text-xs text-slate-500">
        Caricamento stock invecchiato…
      </div>
    )
  }

  if (!data || data.count === 0) return null

  // Group rows into "critical (≤14d)" and "aging (15-30d)" bands.
  const critical = data.items.filter(
    (r) => r.daysToLtsThreshold != null && r.daysToLtsThreshold <= 14,
  )
  const aging = data.items.filter(
    (r) =>
      r.daysToLtsThreshold != null &&
      r.daysToLtsThreshold > 14 &&
      r.daysToLtsThreshold <= 30,
  )
  if (critical.length === 0 && aging.length === 0) return null

  const totalFee30dCents = data.items.reduce(
    (acc, r) => acc + r.projectedLtsFee30dCents,
    0,
  )

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 flex-wrap">
        <Warehouse
          className="h-4 w-4 text-amber-500 dark:text-amber-400"
          aria-hidden="true"
        />
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          Stock FBA invecchiato
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {data.count} SKU · {critical.length} critici · costi LTS stimati 30g{' '}
          {formatEur(totalFee30dCents)}
        </div>
        <Link
          href="/marketing/advertising/storage-age"
          className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          Apri Trading Desk
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </Link>
      </div>

      {critical.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2 mb-1.5">
            <AlertTriangle
              className="h-3.5 w-3.5 text-rose-500 dark:text-rose-400"
              aria-hidden="true"
            />
            <span className="text-xs font-medium text-rose-700 dark:text-rose-300">
              Critici · ≤14 giorni alla soglia LTS
            </span>
          </div>
          <ul className="space-y-0.5">
            {critical.slice(0, 5).map((r) => (
              <li
                key={r.id}
                className="text-xs text-slate-700 dark:text-slate-300 flex items-center gap-2 flex-wrap"
              >
                <span className="font-mono text-slate-900 dark:text-slate-100">
                  {r.sku}
                </span>
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
                  {r.marketplace}
                </span>
                <span className="text-slate-500 dark:text-slate-400">
                  {r.daysToLtsThreshold}g all'addebito
                </span>
                <span className="text-slate-500 dark:text-slate-400">
                  · {r.quantityInAge181_270 + r.quantityInAge271_365 + r.quantityInAge365Plus}{' '}
                  unità a rischio
                </span>
              </li>
            ))}
            {critical.length > 5 && (
              <li className="text-[11px] text-slate-500 dark:text-slate-400 pl-2">
                + {critical.length - 5} altri
              </li>
            )}
          </ul>
        </div>
      )}

      {aging.length > 0 && (
        <div className="px-3 py-2">
          <div className="text-xs font-medium text-amber-700 dark:text-amber-300 mb-1.5">
            Da monitorare · 15-30 giorni
          </div>
          <ul className="space-y-0.5">
            {aging.slice(0, 4).map((r) => (
              <li
                key={r.id}
                className="text-xs text-slate-700 dark:text-slate-300 flex items-center gap-2 flex-wrap"
              >
                <span className="font-mono text-slate-900 dark:text-slate-100">
                  {r.sku}
                </span>
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
                  {r.marketplace}
                </span>
                <span className="text-slate-500 dark:text-slate-400">
                  {r.daysToLtsThreshold}g
                </span>
              </li>
            ))}
            {aging.length > 4 && (
              <li className="text-[11px] text-slate-500 dark:text-slate-400 pl-2">
                + {aging.length - 4} altri
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
