import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportsPage } from '../../../../../../areas/home/reports/ReportsPage'

export const metadata: Metadata = { title: 'Reports · Nexus Factory' }

/**
 * Home › Insights › Reports (SCR-104; areas/home/nav.ts, permission home.reports.view): the report library. The company
 * layout above loaded the session and draws the Office shell; the page is the client container.
 */
export default function HomeReportsPage() {
  return (
    <Suspense>
      <ReportsPage />
    </Suspense>
  )
}
