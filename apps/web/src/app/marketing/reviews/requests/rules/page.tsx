// /marketing/reviews/requests/rules — Reviews › Requests › Rules (build spec §3.3b): the review-request rules, with
// their tick boxes and bulk bar, inside the Reviews shell. The page renders its own PageHeader.
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Skeleton } from '@/design-system/primitives'
import { RulesClient } from './_rules/RulesClient'
import s from './_rules/rules.module.css'

export const metadata: Metadata = { title: 'Reviews · Request rules' }

function RulesLoading() {
  return (
    <div className={s.page} aria-busy="true" aria-label="Loading the request rules">
      <div className={s.headerSkeleton}>
        <Skeleton width={220} height={12} />
        <Skeleton width={120} height={26} />
        <Skeleton width={300} height={14} />
      </div>
      <Skeleton height={74} />
      <Skeleton height={320} />
    </div>
  )
}

export default function RequestRulesPage() {
  return (
    <Suspense fallback={<RulesLoading />}>
      <RulesClient />
    </Suspense>
  )
}
