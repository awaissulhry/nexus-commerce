import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportPrint } from '../../../../../../../areas/production/reports/print/ReportPrint'

export const metadata: Metadata = { title: 'Daily production report · Nexus Factory' }

/** Production › Reports › Print (opened in a new tab from Production reports' ⋯; the print stylesheet hides the frame). */
export default function ProductionReportPrintPage() {
  return (
    <Suspense>
      <ReportPrint />
    </Suspense>
  )
}
