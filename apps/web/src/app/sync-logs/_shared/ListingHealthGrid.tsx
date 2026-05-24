'use client'

/**
 * PIM E.1 — Listing health rollup grid.
 *
 * Compact traffic-light view of every (channel × marketplace) tuple
 * the catalog touches. Each cell shows the dominant status bucket
 * (green/amber/red/gray), total count, and a tiny stacked bar so
 * operators can spot which marketplace is bleeding.
 *
 * Sources /api/sync-logs/listing-health which groups ChannelListing
 * rows by listingStatus in one query. Cells are click-through to
 * /sync-logs/errors (filtered later in E.2) or, for green cells,
 * to /listings.
 *
 * Pure: parent owns refresh cadence. Component re-fetches on mount
 * + when refreshKey prop changes (parent bumps it from its 30s
 * polling timer).
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  Minus,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

type Bucket = 'green' | 'amber' | 'red' | 'gray' | 'other'

interface HealthCell {
  channel: string
  marketplace: string
  total: number
  buckets: Record<Bucket, number>
  byStatus: Record<string, number>
}

interface Props {
  refreshKey?: number
  className?: string
}

export default function ListingHealthGrid({ refreshKey = 0, className }: Props) {
  const [cells, setCells] = useState<HealthCell[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/sync-logs/listing-health`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as { cells: HealthCell[] }
      })
      .then((d) => {
        if (cancelled) return
        setCells(d.cells)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message ?? 'Failed to load')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  if (loading) {
    return (
      <section className={cn('rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4', className)}>
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading listing health…
        </div>
      </section>
    )
  }
  if (error) {
    return (
      <section className={cn('rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 p-4', className)}>
        <div className="flex items-center gap-2 text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      </section>
    )
  }
  if (cells.length === 0) {
    return (
      <section className={cn('rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4', className)}>
        <div className="text-sm text-zinc-500 italic">
          No channel listings yet. Once products publish to marketplaces, this grid lights up.
        </div>
      </section>
    )
  }

  const totalListings = cells.reduce((acc, c) => acc + c.total, 0)
  const totalRed = cells.reduce((acc, c) => acc + c.buckets.red, 0)

  return (
    <section
      className={cn(
        'rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950',
        className,
      )}
    >
      <header className="px-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Listing health
          </h3>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            {totalListings} listings across {cells.length} marketplaces
            {totalRed > 0 && (
              <span className="text-red-600 dark:text-red-400 font-medium">
                {' · '}
                {totalRed} need attention
              </span>
            )}
          </p>
        </div>
        <Legend />
      </header>
      <div className="p-3 grid gap-2 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
        {cells.map((c) => (
          <Cell key={`${c.channel}::${c.marketplace}`} cell={c} />
        ))}
      </div>
    </section>
  )
}

function Cell({ cell }: { cell: HealthCell }) {
  const dominant: Bucket = (() => {
    const order: Bucket[] = ['red', 'amber', 'gray', 'other', 'green']
    for (const b of order) {
      if (cell.buckets[b] > 0 && b !== 'green') return b
    }
    return 'green'
  })()

  // Click-through: red cells go to errors view, green cells to listings.
  const href =
    dominant === 'red'
      ? `/sync-logs/errors?channel=${encodeURIComponent(cell.channel)}&marketplace=${encodeURIComponent(cell.marketplace)}`
      : `/listings?channel=${encodeURIComponent(cell.channel)}&marketplace=${encodeURIComponent(cell.marketplace)}`

  return (
    <Link
      href={href}
      className={cn(
        'block rounded border p-2.5 transition-all hover:shadow-sm',
        toneClasses(dominant),
      )}
      title={`${Object.entries(cell.byStatus)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · ')}`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <DominantIcon bucket={dominant} />
          <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">
            {cell.channel}
          </span>
          <span className="text-[10px] text-zinc-500 font-mono">{cell.marketplace}</span>
        </div>
        <span className="text-xs font-mono text-zinc-700 dark:text-zinc-300 tabular-nums">
          {cell.total}
        </span>
      </div>
      <StackedBar cell={cell} />
    </Link>
  )
}

function StackedBar({ cell }: { cell: HealthCell }) {
  const all: Array<{ b: Bucket; n: number }> = [
    { b: 'green', n: cell.buckets.green },
    { b: 'amber', n: cell.buckets.amber },
    { b: 'red', n: cell.buckets.red },
    { b: 'gray', n: cell.buckets.gray },
    { b: 'other', n: cell.buckets.other },
  ]
  const segs = all.filter((s) => s.n > 0)
  return (
    <div className="flex h-1.5 rounded-full overflow-hidden bg-zinc-100 dark:bg-zinc-800">
      {segs.map((s) => (
        <div
          key={s.b}
          className={cn('h-full', barColor(s.b))}
          style={{ width: `${(s.n / cell.total) * 100}%` }}
          title={`${s.b}: ${s.n}`}
        />
      ))}
    </div>
  )
}

function Legend() {
  const items: Array<{ b: Bucket; label: string }> = [
    { b: 'green', label: 'Active' },
    { b: 'amber', label: 'Pending' },
    { b: 'red', label: 'Failed' },
    { b: 'gray', label: 'Inactive' },
  ]
  return (
    <div className="flex items-center gap-2.5 text-[10px]">
      {items.map(({ b, label }) => (
        <span key={b} className="inline-flex items-center gap-1">
          <span className={cn('w-2 h-2 rounded-full', barColor(b))} />
          <span className="text-zinc-500">{label}</span>
        </span>
      ))}
    </div>
  )
}

function DominantIcon({ bucket }: { bucket: Bucket }) {
  if (bucket === 'red') return <AlertCircle className="w-3 h-3 text-red-600" />
  if (bucket === 'amber') return <Clock className="w-3 h-3 text-amber-600" />
  if (bucket === 'gray') return <Minus className="w-3 h-3 text-zinc-400" />
  return <CheckCircle2 className="w-3 h-3 text-emerald-600" />
}

function toneClasses(bucket: Bucket): string {
  switch (bucket) {
    case 'red':
      return 'border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-900/10 hover:bg-red-50 dark:hover:bg-red-900/20'
    case 'amber':
      return 'border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-900/10 hover:bg-amber-50 dark:hover:bg-amber-900/20'
    case 'gray':
      return 'border-zinc-200 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-900/30 hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
    case 'other':
      return 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 hover:bg-zinc-50 dark:hover:bg-zinc-900/50'
    case 'green':
    default:
      return 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-900/10 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
  }
}

function barColor(bucket: Bucket): string {
  switch (bucket) {
    case 'green':
      return 'bg-emerald-500'
    case 'amber':
      return 'bg-amber-500'
    case 'red':
      return 'bg-red-500'
    case 'gray':
      return 'bg-zinc-400'
    case 'other':
    default:
      return 'bg-zinc-300'
  }
}
