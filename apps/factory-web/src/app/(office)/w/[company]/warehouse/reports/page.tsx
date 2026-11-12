import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportsPage } from '../../../../../../areas/warehouse/reports/ReportsPage'

export const metadata: Metadata = { title: 'Warehouse reports · Nexus Factory' }

/**
 * Warehouse › Reports › Warehouse reports (SCR-257; areas/warehouse/nav.ts, permission inventory.reports.view): stock ageing by
 * material type and leather use by article and supplier lot. The client container reads `?from=`, `?to=` and the top bar's site.
 */
export default function WarehouseReportsPage() {
  return (
    <Suspense>
      <ReportsPage />
    </Suspense>
  )
}
