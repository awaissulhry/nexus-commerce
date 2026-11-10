import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportsPrint } from '../../../../../../../areas/compliance/reports/print/ReportsPrint'

export const metadata: Metadata = { title: 'Annual compliance review · Nexus Factory' }

/** Compliance › Reports › Annual compliance review (PDF) (SCR-307, a new tab, design tab:cr-pdf): `?year=`, `?brand=`. */
export default function ComplianceReviewPrintPage() {
  return (
    <Suspense>
      <ReportsPrint />
    </Suspense>
  )
}
