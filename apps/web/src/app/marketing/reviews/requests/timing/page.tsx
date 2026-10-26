// /marketing/reviews/requests/timing — Reviews › Requests › Timing (build spec §3.3d): the first try by product type and
// the send hour by weekday, inside the Reviews shell. `?section=send-hours` scrolls to the send hours.
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Skeleton } from '@/design-system/primitives'
import { TimingClient } from './_timing/TimingClient'
import s from './_timing/timing.module.css'

export const metadata: Metadata = { title: 'Reviews · Request timing' }

function TimingLoading() {
  return (
    <div className={s.page} aria-busy="true" aria-label="Loading the request timing">
      <div className={s.stack}>
        <Skeleton width={220} height={12} />
        <Skeleton width={120} height={26} />
        <Skeleton width={360} height={14} />
      </div>
      <Skeleton height={320} />
      <Skeleton height={360} />
    </div>
  )
}

export default function RequestTimingPage() {
  return (
    <Suspense fallback={<TimingLoading />}>
      <TimingClient />
    </Suspense>
  )
}
