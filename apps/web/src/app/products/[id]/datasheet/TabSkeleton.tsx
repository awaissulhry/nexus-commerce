/**
 * EH.6 — Generic skeleton shown inside the Datasheet tab Suspense
 * boundary while the active tab's server component runs its Prisma
 * queries. Matches the dimensions of the smallest tab body so it
 * neither over- nor under-claims space; real tab content replaces
 * it without visible CLS in the common case.
 *
 * Kept intentionally generic: every tab has its own shape, but they
 * all open with a heading + a card grid or a single column of rows.
 * The skeleton mimics that broad pattern so it reads as "loading"
 * without trying to predict the specific tab.
 */

import { Skeleton } from '@/components/ui/Skeleton'

export default function TabSkeleton() {
  return (
    <div className="space-y-4">
      {/* Section heading */}
      <Skeleton variant="block" width={220} height={18} />

      {/* 2×2 card grid — matches OverviewTab / ChannelsTab opener */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Skeleton variant="card" />
        <Skeleton variant="card" />
        <Skeleton variant="card" />
        <Skeleton variant="card" />
      </div>
    </div>
  )
}
