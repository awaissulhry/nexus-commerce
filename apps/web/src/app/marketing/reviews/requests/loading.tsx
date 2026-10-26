// /marketing/reviews/requests — while the Queue loads: the header, the sending banner, the tiles and the grid, in the
// page's own layout.
import { Skeleton } from '@/design-system/primitives'
import s from './_queue/queue.module.css'

export default function RequestsQueueLoading() {
  return (
    <div className={s.page} aria-busy="true" aria-label="Loading the review requests">
      <div className={s.headerSkeleton}>
        <Skeleton width={220} height={12} />
        <Skeleton width={140} height={26} />
        <Skeleton width={420} height={14} />
      </div>
      <Skeleton height={58} />
      <Skeleton height={74} />
      <Skeleton height={44} />
      <Skeleton height={420} />
    </div>
  )
}
