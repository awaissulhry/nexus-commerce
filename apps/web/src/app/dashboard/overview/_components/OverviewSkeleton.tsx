'use client'

import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'

/**
 * DO.35 — full-page skeleton matching the live dashboard's section
 * grid. Replaces the previous single big spinner so the operator
 * sees the layout shape from the first byte; less jarring when
 * real content arrives. Vercel/Linear pattern.
 *
 * Structure mirrors OverviewClient's grid:
 *   - 4 + 4 KPI cards (two rows)
 *   - left column: 4 large stacked cards
 *   - right column: 4 stacked side-cards
 */
export default function OverviewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      {/* KPI strip — financial row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <KpiSkeleton key={i} />
        ))}
      </div>
      {/* KPI strip — operational row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <KpiSkeleton key={i} />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <ChartSkeleton />
          <ChartSkeleton />
          <ListSkeleton title rows={3} />
          <ListSkeleton title rows={4} />
        </div>
        <div className="space-y-4">
          <ListSkeleton title rows={4} />
          <ListSkeleton title rows={6} />
          <ListSkeleton title rows={3} />
          <ListSkeleton title rows={5} />
        </div>
      </div>
    </div>
  )
}

function KpiSkeleton() {
  // Mirrors the KpiCard internal structure: label, value, sparkline,
  // prev. Same dimensions so the swap-in is invisible.
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 px-4 py-3 space-y-2">
      <Skeleton variant="text" width="40%" />
      <Skeleton variant="text" width="60%" className="h-6" />
      <Skeleton variant="block" height="24px" />
      <Skeleton variant="text" width="35%" />
    </div>
  )
}

function ChartSkeleton() {
  return (
    <Card>
      <Skeleton variant="block" height="180px" />
    </Card>
  )
}

function ListSkeleton({ title, rows }: { title: boolean; rows: number }) {
  return (
    <Card title={title ? <Skeleton variant="text" width="40%" /> : undefined}>
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton variant="text" className="flex-1" />
            <Skeleton variant="text" width="20%" />
          </div>
        ))}
      </div>
    </Card>
  )
}
