import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportPrint } from '../../../../../../../../areas/home/reports/print/ReportPrint'

export const metadata: Metadata = { title: 'Report print · Nexus Factory' }

/** Home › Insights › Reports › a report as PDF (opened in a new tab; the print stylesheet hides the frame). */
export default function HomeReportPrintPage() {
  return (
    <Suspense>
      <ReportPrint />
    </Suspense>
  )
}
