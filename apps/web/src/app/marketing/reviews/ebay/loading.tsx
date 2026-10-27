// /marketing/reviews/ebay (and each market) — while the page loads: the header line and a skeleton per section.
import { Skeleton } from '@/design-system/primitives'
import s from '../_channel/channel.module.css'

export default function ChannelLoading() {
  return (
    <div className={s.page} aria-busy="true" aria-label="Loading the channel page">
      <div className={s.stackGap}>
        <Skeleton width={220} height={12} />
        <Skeleton width={160} height={26} />
        <Skeleton width={360} height={14} />
      </div>
      <div className={s.tileSkeletons}>
        {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={74} />)}
      </div>
      <Skeleton height={280} />
      <Skeleton height={240} />
    </div>
  )
}
