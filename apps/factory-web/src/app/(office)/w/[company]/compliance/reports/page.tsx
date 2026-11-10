import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportsPage } from '../../../../../../areas/compliance/reports/ReportsPage'

export const metadata: Metadata = { title: 'Compliance reports · Nexus Factory' }

/**
 * Compliance › Reports › Compliance reports (SCR-261; areas/compliance/nav.ts, permission compliance.reports.view): certificate
 * coverage (ANA-025) and the main gaps, the gaps by type, the expiry calendar, chromium VI per supplier, the register summary.
 * The client container reads `?from=`, `?to=`, `?brand=`.
 */
export default function ComplianceReportsPage() {
  return (
    <Suspense>
      <ReportsPage />
    </Suspense>
  )
}
