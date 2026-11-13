import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportsPage } from '../../../../../../areas/sales/reports/ReportsPage'

export const metadata: Metadata = { title: 'Sales reports · Nexus Factory' }

/**
 * Sales › Reports › Sales reports (SCR-250; areas/sales/nav.ts, permission sales.reports.view): the headline in five numbers, the
 * order intake by week or month split by customer, style or season, the backlog by promise week and the return reasons. The client
 * container reads `?from=`, `?to=`, `?by=`, `?split=`, `?backlog=`, `?also=` and the top bar's company.
 */
export default function SalesReportsPage() {
  return (
    <Suspense>
      <ReportsPage />
    </Suspense>
  )
}
