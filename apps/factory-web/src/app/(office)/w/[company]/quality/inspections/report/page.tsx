import { Suspense } from 'react'
import type { Metadata } from 'next'
import { InspectionReport } from '../../../../../../../areas/quality/inspections/report/InspectionReport'

export const metadata: Metadata = { title: 'Inspection report · Nexus Factory' }

/** Quality › Inspections › an inspection's report (SCR-076-report, a new tab: `?id=<inspection>&language=it|en&share=1`). B-W2b-127. */
export default function InspectionReportRoute() {
  return (
    <Suspense>
      <InspectionReport />
    </Suspense>
  )
}
