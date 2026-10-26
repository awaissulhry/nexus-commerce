// /marketing/reviews — Reviews › Overview (build spec §3.1). The page is OverviewClient: it reads the address on the
// client (period, the Needs-you filter, the pressed rating bar) and renders its own PageHeader inside the Reviews shell.
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { OverviewClient } from './_overview/OverviewClient'
import ReviewsOverviewLoading from './loading'

export const metadata: Metadata = { title: 'Reviews · Overview' }

export default function ReviewsOverviewPage() {
  return (
    <Suspense fallback={<ReviewsOverviewLoading />}>
      <OverviewClient />
    </Suspense>
  )
}
