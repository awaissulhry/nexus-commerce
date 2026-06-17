/**
 * EH.2 — Skeleton for the recover (listing recovery) page.
 *
 * Mimics the back link + title + per-listing picker cards so the
 * operator sees structure immediately while /api/products/:id/health
 * runs (200–500 ms on cold cache; the slowest of the 3 EH routes).
 */

import { Skeleton } from '@/components/ui/Skeleton'

export default function RecoverLoading() {
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-4xl mx-auto p-6">
        <header className="mb-6 space-y-3">
          <Skeleton variant="block" width={120} height={14} />
          <Skeleton variant="block" width="40%" height={26} />
          <Skeleton variant="block" width="55%" height={14} />
        </header>

        {/* Section heading */}
        <div className="mb-3">
          <Skeleton variant="block" width={180} height={16} />
        </div>

        {/* Listing picker cards */}
        <div className="grid gap-2 mb-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="w-full rounded-md border border-default bg-white px-4 py-3 flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <Skeleton variant="thumbnail" width={32} height={32} />
                <div className="space-y-1.5 flex-1">
                  <Skeleton variant="block" width="40%" height={14} />
                  <Skeleton variant="block" width="60%" height={12} />
                </div>
              </div>
              <Skeleton variant="pill" width={70} />
            </div>
          ))}
        </div>

        {/* Action picker section */}
        <div className="mb-3">
          <Skeleton variant="block" width={150} height={16} />
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} variant="card" />
          ))}
        </div>
      </div>
    </div>
  )
}
