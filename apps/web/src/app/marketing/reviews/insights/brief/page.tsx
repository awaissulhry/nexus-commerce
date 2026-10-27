// /marketing/reviews/insights/brief — Reviews › Insights › Brief (build spec §3.4): what buyers tell you, written as a
// brief per channel and market, with its evidence; earlier briefs read-only. BriefClient reads the address on the client
// and renders its own PageHeader inside the Reviews shell.
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { InsightsSkeleton } from '../_shared/InsightsSkeleton'
import { BriefClient } from './BriefClient'

export const metadata: Metadata = { title: 'Reviews · Insights · Brief' }

export default function ReviewsInsightsBriefPage() {
  return (
    <Suspense fallback={<InsightsSkeleton label="Loading the brief" tiles={0} />}>
      <BriefClient />
    </Suspense>
  )
}
