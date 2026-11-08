import { Suspense } from 'react'
import type { Metadata } from 'next'
import { InspectionReports } from '../../../../../../../areas/quality/inspections/report/InspectionReports'

export const metadata: Metadata = { title: 'Inspection reports · Nexus Factory' }

/** Quality › Inspections › Print N reports (SCR-076-reports, a new tab: `?ids=<id>[,<id>…]&language=`). B-W2b-127. */
export default function InspectionReportsRoute() {
  return (
    <Suspense>
      <InspectionReports />
    </Suspense>
  )
}
