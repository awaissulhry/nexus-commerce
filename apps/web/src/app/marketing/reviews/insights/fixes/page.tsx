// /marketing/reviews/insights/fixes — Reviews › Insights › Fixes (build spec §3.4 + ruling 7): bullets, A+ content, recall
// checks and tasks proposed from what buyers say; sent as ONE change plan a person approves, never applied directly.
// FixesClient reads the address on the client and renders its own PageHeader inside the Reviews shell.
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { InsightsSkeleton } from '../_shared/InsightsSkeleton'
import { FixesClient } from './FixesClient'

export const metadata: Metadata = { title: 'Reviews · Insights · Fixes' }

export default function ReviewsInsightsFixesPage() {
  return (
    <Suspense fallback={<InsightsSkeleton label="Loading the fixes" tiles={0} />}>
      <FixesClient />
    </Suspense>
  )
}
