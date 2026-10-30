import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportsPage } from '../../../../../../areas/production/reports/ReportsPage'

export const metadata: Metadata = { title: 'Production reports · Nexus Factory' }

/**
 * Production › Reports › Production reports (SCR-240; areas/production/nav.ts, permission production.reports.view). The
 * company layout above loaded the session and draws the Office shell; the page is the client container, which loads the
 * day's report through the API.
 */
export default function ProductionReportsPage() {
  return (
    <Suspense>
      <ReportsPage />
    </Suspense>
  )
}
