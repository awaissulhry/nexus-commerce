import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportsPrint } from '../../../../../../../areas/sales/reports/print/ReportsPrint'

export const metadata: Metadata = { title: 'Sales reports print view · Nexus Factory' }

/** Sales › Reports › the print view (SCR-427, a new tab, design tab:print): `?from=`, `?to=`, `?by=`, `?split=`, `?backlog=` and the top bar's company. */
export default function SalesReportsPrintPage() {
  return (
    <Suspense>
      <ReportsPrint />
    </Suspense>
  )
}
