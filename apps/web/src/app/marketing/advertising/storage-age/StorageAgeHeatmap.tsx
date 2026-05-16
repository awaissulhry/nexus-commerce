'use client'

/**
 * AD.2 — Storage-age heatmap (client component for interactivity).
 *
 * Marketplace × age-bucket grid. Each cell shows unit count + projected
 * LTS fee in the selected horizon. Click → expands to SKU list.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { formatEur, formatNumber } from '../_shared/formatters'

interface StorageAgeRow {
  id: string
  sku: string
  asin: string | null
  marketplace: string
  productId: string | null
  quantityInAge0_90: number
  quantityInAge91_180: number
  quantityInAge181_270: number
  quantityInAge271_365: number
  quantityInAge365Plus: number
  projectedLtsFee30dCents: number
  projectedLtsFee60dCents: number
  projectedLtsFee90dCents: number
  daysToLtsThreshold: number | null
}

type Bucket = '0_90' | '91_180' | '181_270' | '271_365' | '365_plus'
type Horizon = '30' | '60' | '90'

const BUCKETS: { key: Bucket; label: string; quantityField: keyof StorageAgeRow }[] = [
  { key: '0_90', label: '0-90 g', quantityField: 'quantityInAge0_90' },
  { key: '91_180', label: '91-180 g', quantityField: 'quantityInAge91_180' },
  { key: '181_270', label: '181-270 g', quantityField: 'quantityInAge181_270' },
  { key: '271_365', label: '271-365 g', quantityField: 'quantityInAge271_365' },
  { key: '365_plus', label: '365+ g', quantityField: 'quantityInAge365Plus' },
]

function cellTone(units: number, bucket: Bucket): string {
  if (units === 0) return 'bg-slate-50 dark:bg-slate-950/40 text-slate-400 dark:text-slate-600'
  if (bucket === '365_plus' || bucket === '271_365') {
    return 'bg-rose-100 dark:bg-rose-950/60 text-rose-900 dark:text-rose-200'
  }
  if (bucket === '181_270') {
    return 'bg-amber-100 dark:bg-amber-950/60 text-amber-900 dark:text-amber-200'
  }
  if (bucket === '91_180') {
    return 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-300'
  }
  return 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-200'
}

export function StorageAgeHeatmap({ rows }: { rows: StorageAgeRow[] }) {
  const [horizon, setHorizon] = useState<Horizon>('30')
  const [selected, setSelected] = useState<{ marketplace: string; bucket: Bucket } | null>(null)

  const marketplaces = useMemo(
    () => Array.from(new Set(rows.map((r) => r.marketplace))).sort(),
    [rows],
  )

  // Pre-aggregate the grid.
  const grid = useMemo(() => {
    const map = new Map<string, { units: number; feeCents: number; skus: StorageAgeRow[] }>()
    for (const r of rows) {
      for (const bucket of BUCKETS) {
        const units = r[bucket.quantityField] as number
        if (units === 0) continue
        const key = `${r.marketplace}::${bucket.key}`
        const cell = map.get(key) ?? { units: 0, feeCents: 0, skus: [] }
        cell.units += units
        // LTS fee allocation is approximate — apportion projected fee
        // by share of aged units in critical brackets. Cheap heuristic.
        if (bucket.key === '271_365' || bucket.key === '365_plus') {
          const fee = horizon === '30' ? r.projectedLtsFee30dCents : horizon === '60' ? r.projectedLtsFee60dCents : r.projectedLtsFee90dCents
          cell.feeCents += fee
        }
        cell.skus.push(r)
        map.set(key, cell)
      }
    }
    return map
  }, [rows, horizon])

  const selectedRows = useMemo(() => {
    if (!selected) return []
    const bucket = BUCKETS.find((b) => b.key === selected.bucket)
    if (!bucket) return []
    return rows
      .filter((r) => r.marketplace === selected.marketplace)
      .filter((r) => (r[bucket.quantityField] as number) > 0)
      .sort((a, b) => (a.daysToLtsThreshold ?? 9999) - (b.daysToLtsThreshold ?? 9999))
  }, [rows, selected])

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Proiezione LTS:
        </span>
        {(['30', '60', '90'] as Horizon[]).map((h) => (
          <button
            key={h}
            type="button"
            onClick={() => setHorizon(h)}
            className={`text-xs px-2 py-1 rounded ring-1 ring-inset ${
              horizon === h
                ? 'bg-blue-600 text-white ring-blue-600'
                : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 ring-slate-300 dark:ring-slate-700'
            }`}
          >
            {h} giorni
          </button>
        ))}
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-950/50 border-b border-slate-200 dark:border-slate-800">
            <tr>
              <th className="px-3 py-2 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 w-16">
                Mkt
              </th>
              {BUCKETS.map((b) => (
                <th
                  key={b.key}
                  className="px-3 py-2 text-center text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400"
                >
                  {b.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {marketplaces.map((mp) => (
              <tr key={mp}>
                <td className="px-3 py-2 text-xs font-mono text-slate-700 dark:text-slate-300">
                  {mp}
                </td>
                {BUCKETS.map((b) => {
                  const cell = grid.get(`${mp}::${b.key}`)
                  const isSelected = selected?.marketplace === mp && selected.bucket === b.key
                  if (!cell) {
                    return (
                      <td key={b.key} className="px-1 py-1">
                        <div className="bg-slate-50 dark:bg-slate-950/40 rounded text-center py-3 text-[10px] text-slate-400">
                          —
                        </div>
                      </td>
                    )
                  }
                  return (
                    <td key={b.key} className="px-1 py-1">
                      <button
                        type="button"
                        onClick={() => setSelected(isSelected ? null : { marketplace: mp, bucket: b.key })}
                        className={`w-full rounded py-2 text-center transition-all ${cellTone(cell.units, b.key)} ${
                          isSelected ? 'ring-2 ring-blue-500' : 'hover:opacity-80'
                        }`}
                      >
                        <div className="text-sm font-semibold tabular-nums">
                          {formatNumber(cell.units)}
                        </div>
                        {cell.feeCents > 0 && (
                          <div className="text-[10px] tabular-nums opacity-75">
                            {formatEur(cell.feeCents)}
                          </div>
                        )}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="mt-3 bg-white dark:bg-slate-900 border border-blue-200 dark:border-blue-900 rounded-md">
          <div className="px-3 py-2 border-b border-blue-200 dark:border-blue-900 flex items-center gap-2">
            <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
              {selected.marketplace} · {BUCKETS.find((b) => b.key === selected.bucket)?.label}
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {selectedRows.length} SKU
            </span>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="ml-auto text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            >
              Chiudi
            </button>
          </div>
          <ul className="divide-y divide-slate-200 dark:divide-slate-800 max-h-[400px] overflow-y-auto">
            {selectedRows.map((r) => {
              const bucket = BUCKETS.find((b) => b.key === selected.bucket)!
              const units = r[bucket.quantityField] as number
              return (
                <li
                  key={r.id}
                  className="px-3 py-2 text-xs flex items-center gap-3 flex-wrap"
                >
                  {r.productId ? (
                    <Link
                      href={`/products/${r.productId}`}
                      className="text-blue-600 dark:text-blue-400 hover:underline font-mono"
                    >
                      {r.sku}
                    </Link>
                  ) : (
                    <span className="font-mono text-slate-900 dark:text-slate-100">{r.sku}</span>
                  )}
                  {r.asin && (
                    <span className="text-[10px] font-mono text-slate-500">{r.asin}</span>
                  )}
                  <span className="text-slate-600 dark:text-slate-400">
                    {formatNumber(units)} unità
                  </span>
                  {r.daysToLtsThreshold != null && (
                    <span
                      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset ${
                        r.daysToLtsThreshold <= 14
                          ? 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900'
                          : r.daysToLtsThreshold <= 30
                            ? 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900'
                            : 'bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700'
                      }`}
                    >
                      {r.daysToLtsThreshold} g al LTS
                    </span>
                  )}
                  <span className="ml-auto tabular-nums text-slate-500">
                    LTS 30g {formatEur(r.projectedLtsFee30dCents)}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
