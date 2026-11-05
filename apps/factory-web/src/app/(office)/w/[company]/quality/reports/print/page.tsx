import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportsPrint } from '../../../../../../../areas/quality/reports/print/ReportsPrint'

export const metadata: Metadata = { title: 'Quality report · Nexus Factory' }

/** Quality › Reports › Quality report (PDF) (a new tab, design tab:qr-pdf): the filters written at the top, groups only. */
export default function QualityReportsPrintPage() {
  return (
    <Suspense>
      <ReportsPrint />
    </Suspense>
  )
}
