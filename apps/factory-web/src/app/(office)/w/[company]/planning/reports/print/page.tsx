import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReportsPrint } from '../../../../../../../areas/planning/reports/print/ReportsPrint'

export const metadata: Metadata = { title: 'Planning reports print view · Nexus Factory' }

/** Planning › Reports › the print view (SCR-409, a new tab, design tab:print): `?from=`, `?to=`, `?ahead=`, `?weeks=` and the top bar's site. */
export default function PlanningReportsPrintPage() {
  return (
    <Suspense>
      <ReportsPrint />
    </Suspense>
  )
}
