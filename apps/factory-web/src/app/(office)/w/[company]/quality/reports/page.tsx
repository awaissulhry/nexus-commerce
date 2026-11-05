import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportsPage } from '../../../../../../areas/quality/reports/ReportsPage'

export const metadata: Metadata = { title: 'Quality reports · Nexus Factory' }

/**
 * Quality › Reports › Quality reports (SCR-147; areas/quality/nav.ts, permission quality.reports.view): the quality KPIs, the
 * trend, the comparison by line, operation, supplier and style, and incoming quality. The client container reads `?from=`,
 * `?to=`, `?compare=0`, `?by=`, `?line=`.
 */
export default function QualityReportsPage() {
  return (
    <Suspense>
      <ReportsPage />
    </Suspense>
  )
}
