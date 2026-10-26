// /marketing/reviews/settings — while Settings loads: the header line, the section strip and one skeleton per section,
// in the page's own layout.
import { Skeleton } from '@/design-system/primitives'
import s from './_settings/settings.module.css'

export default function ReviewsSettingsLoading() {
  return (
    <div className={s.page} aria-busy="true" aria-label="Loading Reviews settings">
      <div className={s.skeletonHead}>
        <Skeleton width={180} height={12} />
        <Skeleton width={120} height={26} />
        <Skeleton width={360} height={14} />
      </div>
      <Skeleton width={620} height={32} />
      {[0, 1, 2].map((i) => <Skeleton key={i} height={220} />)}
    </div>
  )
}
