// Reviews › Insights — while a page loads: the header lines, a row of tiles and skeleton rows, in the pages' own layout.
import { Skeleton } from '@/design-system/primitives'
import s from './insights.module.css'

export function InsightsSkeleton({ label, tiles = 4 }: { label: string; tiles?: number }) {
  return (
    <div className={s.page} aria-busy="true" aria-label={label}>
      <div className={s.skeleton}>
        <Skeleton width={220} height={12} />
        <Skeleton width={120} height={26} />
        <Skeleton width={340} height={14} />
      </div>
      {tiles > 0 && (
        <div className={s.skeletonRow}>
          {Array.from({ length: tiles }, (_, i) => <Skeleton key={i} height={74} />)}
        </div>
      )}
      <div className={s.skeleton}>
        {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={52} />)}
      </div>
    </div>
  )
}
