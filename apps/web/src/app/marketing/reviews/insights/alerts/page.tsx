// /marketing/reviews/insights/alerts — Reviews › Insights › Alerts (build spec §3.4 + ruling 7): themes that suddenly
// come up more often for one product in one market; acknowledge, resolve, reopen, ask the AI for fixes, one or many.
// AlertsClient reads the address on the client and renders its own PageHeader inside the Reviews shell.
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { InsightsSkeleton } from '../_shared/InsightsSkeleton'
import { AlertsClient } from './AlertsClient'

export const metadata: Metadata = { title: 'Reviews · Insights · Alerts' }

export default function ReviewsInsightsAlertsPage() {
  return (
    <Suspense fallback={<InsightsSkeleton label="Loading the alerts" />}>
      <AlertsClient />
    </Suspense>
  )
}
