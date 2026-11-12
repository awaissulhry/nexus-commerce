import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportsPage } from '../../../../../../areas/purchasing/reports/ReportsPage'

export const metadata: Metadata = { title: 'Purchasing reports · Nexus Factory' }

/**
 * Purchasing › Reports › Purchasing reports (SCR-255; areas/purchasing/nav.ts, permission purchasing.reports.view): the spend by
 * supplier, category, material, company or month with sample orders apart, and the late lines with what they block. The client
 * container reads `?from=`, `?to=`, `?by=`, `?reason=` and the top bar's site.
 */
export default function PurchasingReportsPage() {
  return (
    <Suspense>
      <ReportsPage />
    </Suspense>
  )
}
