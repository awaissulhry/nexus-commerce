import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportsPrint } from '../../../../../../../areas/purchasing/reports/print/ReportsPrint'

export const metadata: Metadata = { title: 'Purchasing reports print view · Nexus Factory' }

/** Purchasing › Reports › the print view (SCR-372, a new tab, design tab:print): `?from=`, `?to=`, `?by=` and the top bar's site. */
export default function PurchasingReportsPrintPage() {
  return (
    <Suspense>
      <ReportsPrint />
    </Suspense>
  )
}
