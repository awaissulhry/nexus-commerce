import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportPage } from '../../../../../../../areas/home/reports/ReportPage'

export const metadata: Metadata = { title: 'Report · Nexus Factory' }

/** Home › Insights › Reports › a report (SCR-104 rec:Report: Results, Schedule, About). */
export default function HomeReportPage() {
  return (
    <Suspense>
      <ReportPage />
    </Suspense>
  )
}
