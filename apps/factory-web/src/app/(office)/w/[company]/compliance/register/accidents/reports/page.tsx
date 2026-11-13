import { Suspense } from 'react'
import type { Metadata } from 'next'
import { ReportsPage } from '../../../../../../../../areas/compliance/register/accidents/reports/ReportsPage'

export const metadata: Metadata = { title: 'Product-safety reports · Nexus Factory' }

/** Compliance › PPE register › product-safety reports (SCR-421, B-W2b-357; B-W2b-351's reports in the office). */
export default function SafetyReportsRoute() {
  return (
    <Suspense>
      <ReportsPage />
    </Suspense>
  )
}
