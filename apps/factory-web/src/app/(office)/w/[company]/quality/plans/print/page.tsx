import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PlanPrint } from '../../../../../../../areas/quality/plans/print/PlanPrint'

export const metadata: Metadata = { title: 'Inspection checklist · Nexus Factory' }

/** Quality › Inspection plans & AQL › the printable checklist (SCR-077-print, a new tab: `?plans=<id>[,<id>]&version=&language=`). */
export default function InspectionPlanPrintRoute() {
  return (
    <Suspense>
      <PlanPrint />
    </Suspense>
  )
}
