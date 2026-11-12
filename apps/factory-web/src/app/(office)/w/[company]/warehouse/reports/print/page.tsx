import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportsPrint } from '../../../../../../../areas/warehouse/reports/print/ReportsPrint'

export const metadata: Metadata = { title: 'Warehouse reports print view · Nexus Factory' }

/** Warehouse › Reports › the print view (SCR-353, a new tab, design tab:wr-tab-print): `?from=`, `?to=` and the top bar's site. */
export default function WarehouseReportsPrintPage() {
  return (
    <Suspense>
      <ReportsPrint />
    </Suspense>
  )
}
