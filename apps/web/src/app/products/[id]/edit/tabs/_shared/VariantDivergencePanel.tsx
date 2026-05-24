'use client'

/**
 * PIM B.4 — Variant divergence summary for the per-product MatrixTab.
 *
 * Variants are full Product rows with their own values (no schema-
 * level inheritance), so "inherited" here is a value-equality
 * heuristic: a variant whose basePrice matches the parent's basePrice
 * is rendered as "matches parent" — diverging variants surface so
 * the operator can spot outliers.
 *
 * Pure read-only summary: counts, ranges, and a tiny "X of N diverge"
 * bar per field. No edits here — the matrix below is where actual
 * changes happen. Pairs with C.5 (variant inheritance overlay on the
 * catalog-wide grid) for the same concept on a different surface.
 */

import { useMemo } from 'react'
import { Layers, Equal, ArrowUpDown, AlertTriangle } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'

interface ChildRow {
  id: string
  sku: string
  basePrice: number | string | null
  totalStock: number | null
  status?: string | null
}

interface ParentRef {
  basePrice: number | string | null
  totalStock: number | null
  status?: string | null
}

interface Props {
  parent: ParentRef
  children: ChildRow[]
  className?: string
}

type FieldKey = 'basePrice' | 'totalStock' | 'status'

interface FieldStats {
  field: FieldKey
  label: string
  parentValue: unknown
  matchCount: number
  divergeCount: number
  /** For numeric fields: [min, max] across variants. Null when not
   *  applicable (status). */
  range: [number, number] | null
  /** Distinct overriding values, capped at 5 for display. */
  divergentSamples: string[]
}

export default function VariantDivergencePanel({ parent, children, className }: Props) {
  const stats = useMemo<FieldStats[]>(() => {
    if (children.length === 0) return []
    return (['basePrice', 'totalStock', 'status'] as const).map((field) => {
      const parentValue = (parent as unknown as Record<string, unknown>)[field]
      const numericField = field !== 'status'
      let matchCount = 0
      let divergeCount = 0
      let min = Infinity
      let max = -Infinity
      const divergent = new Set<string>()

      for (const c of children) {
        const v = (c as unknown as Record<string, unknown>)[field]
        const matches = numericField
          ? Number(v ?? 0) === Number(parentValue ?? 0)
          : String(v ?? '') === String(parentValue ?? '')
        if (matches) matchCount++
        else {
          divergeCount++
          if (divergent.size < 5) divergent.add(formatValue(v))
        }
        if (numericField && v != null) {
          const n = Number(v)
          if (Number.isFinite(n)) {
            if (n < min) min = n
            if (n > max) max = n
          }
        }
      }

      const range: [number, number] | null =
        numericField && min !== Infinity ? [min, max] : null

      return {
        field,
        label: field === 'basePrice' ? 'Price' : field === 'totalStock' ? 'Stock' : 'Status',
        parentValue,
        matchCount,
        divergeCount,
        range,
        divergentSamples: Array.from(divergent),
      }
    })
  }, [parent, children])

  if (children.length === 0) {
    return null
  }

  const totalDiverge = stats.reduce((acc, s) => acc + s.divergeCount, 0)

  return (
    <Card className={className}>
      <header className="px-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-zinc-400" />
            Variant divergence ({children.length} variants)
          </h3>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            {totalDiverge === 0
              ? 'Every variant matches the parent across all editable fields.'
              : 'Variants whose value differs from the parent — outliers to review before publish.'}
          </p>
        </div>
      </header>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-0 divide-y sm:divide-y-0 sm:divide-x divide-zinc-100 dark:divide-zinc-800">
        {stats.map((s) => (
          <StatCell key={s.field} stats={s} totalVariants={children.length} />
        ))}
      </div>
    </Card>
  )
}

function StatCell({ stats, totalVariants }: { stats: FieldStats; totalVariants: number }) {
  const pct =
    totalVariants === 0 ? 0 : Math.round((stats.matchCount / totalVariants) * 100)
  const Icon = stats.divergeCount === 0 ? Equal : ArrowUpDown
  const tone =
    stats.divergeCount === 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-amber-600 dark:text-amber-400'

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {stats.label}
        </span>
        <span className={cn('inline-flex items-center gap-1 text-[10px]', tone)}>
          <Icon className="w-2.5 h-2.5" />
          {stats.divergeCount === 0
            ? 'all match parent'
            : `${stats.divergeCount} diverge / ${totalVariants}`}
        </span>
      </div>
      <div className="text-[10px] text-zinc-500 mb-1.5">
        Parent: <code className="font-mono text-zinc-700 dark:text-zinc-300">
          {formatValue(stats.parentValue)}
        </code>
        {stats.range && (
          <span className="ml-2">
            · Variant range:{' '}
            <code className="font-mono">
              {stats.range[0]} – {stats.range[1]}
            </code>
          </span>
        )}
      </div>
      {/* Tiny match/diverge bar */}
      <div className="h-1.5 flex rounded-full overflow-hidden bg-zinc-100 dark:bg-zinc-800">
        {stats.matchCount > 0 && (
          <div
            className="h-full bg-emerald-500"
            style={{ width: `${(stats.matchCount / totalVariants) * 100}%` }}
            title={`${stats.matchCount} match`}
          />
        )}
        {stats.divergeCount > 0 && (
          <div
            className="h-full bg-amber-500"
            style={{ width: `${(stats.divergeCount / totalVariants) * 100}%` }}
            title={`${stats.divergeCount} diverge`}
          />
        )}
      </div>
      <div className="flex items-center justify-between mt-1 text-[10px] text-zinc-400">
        <span>{pct}% match parent</span>
      </div>
      {stats.divergentSamples.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          <AlertTriangle className="w-2.5 h-2.5 text-amber-500 mt-0.5" />
          {stats.divergentSamples.map((v, i) => (
            <code
              key={i}
              className="text-[10px] px-1 py-0.5 rounded bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 font-mono"
            >
              {v}
            </code>
          ))}
          {stats.divergeCount > stats.divergentSamples.length && (
            <span className="text-[10px] text-zinc-400">
              +{stats.divergeCount - stats.divergentSamples.length} more
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function formatValue(v: unknown): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
