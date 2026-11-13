import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportsPage } from '../../../../../../areas/planning/reports/ReportsPage'

export const metadata: Metadata = { title: 'Planning reports · Nexus Factory' }

/**
 * Planning › Reports › Planning reports (SCR-254; areas/planning/nav.ts, permission planning.reports.view): schedule adherence,
 * the utilisation trend and the material cover with projected stock-outs. The client container reads `?from=`, `?to=`, `?lane=`,
 * `?ahead=`, `?weeks=` and the top bar's site.
 */
export default function PlanningReportsPage() {
  return (
    <Suspense>
      <ReportsPage />
    </Suspense>
  )
}
