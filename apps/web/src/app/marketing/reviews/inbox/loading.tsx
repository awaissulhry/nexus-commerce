// /marketing/reviews/inbox — while the Inbox loads: the header line, the tabs, the six tiles and skeleton rows, in the
// page's own layout.
import { Skeleton } from '@/design-system/primitives'
import s from './inbox.module.css'

export default function ReviewsInboxLoading() {
  return (
    <div className={s.page} aria-busy="true" aria-label="Loading the Inbox">
      <div className={s.skeletonHead}>
        <Skeleton width={180} height={12} />
        <Skeleton width={120} height={26} />
        <Skeleton width={300} height={14} />
      </div>
      <Skeleton width={360} height={28} />
      <div className={s.tileSkeletons}>
        {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={74} />)}
      </div>
      <Skeleton height={96} />
      <div className={s.rowSkeletons}>
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <Skeleton key={i} height={52} />)}
      </div>
    </div>
  )
}
