// /marketing/reviews — while the Overview loads: the header line and one skeleton per section (tiles, chart and
// spread, Needs you, channels), in the page's own layout.
import { Skeleton } from '@/design-system/primitives'
import s from './_overview/overview.module.css'

export default function ReviewsOverviewLoading() {
  return (
    <div className={s.page} aria-busy="true" aria-label="Loading the Reviews overview">
      <div className={s.skeletonBlock}>
        <Skeleton width={180} height={12} />
        <Skeleton width={140} height={26} />
        <Skeleton width={320} height={14} />
      </div>
      <div className={s.tileSkeletons}>
        {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={74} />)}
      </div>
      <div className={s.row}>
        <div className={s.trend}><Skeleton height={300} /></div>
        <div className={s.spread}><Skeleton height={300} /></div>
      </div>
      <Skeleton height={220} />
      <Skeleton height={320} />
    </div>
  )
}
