// /marketing/reviews/insights/themes — Reviews › Insights › Themes (build spec §3.4): what buyers talk about, per theme,
// with star impact, change, quotes and when themes come up. ThemesClient reads the address on the client (scope, sort,
// heatmap mode) and renders its own PageHeader inside the Reviews shell.
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { InsightsSkeleton } from '../_shared/InsightsSkeleton'
import { ThemesClient } from './ThemesClient'

export const metadata: Metadata = { title: 'Reviews · Insights · Themes' }

export default function ReviewsInsightsThemesPage() {
  return (
    <Suspense fallback={<InsightsSkeleton label="Loading the themes" />}>
      <ThemesClient />
    </Suspense>
  )
}
