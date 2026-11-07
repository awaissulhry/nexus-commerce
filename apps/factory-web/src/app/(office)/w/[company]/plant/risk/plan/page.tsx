import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PlanPrint } from '../../../../../../../areas/plant/risk/plan/PlanPrint'

export const metadata: Metadata = { title: 'Improvement plan · Nexus Factory' }

/** Plant › Risk assessment › Improvement plan (print) (a new tab): `?assessment=&id=&view=`. */
export default function PlanPrintRoute() {
  return (
    <Suspense>
      <PlanPrint />
    </Suspense>
  )
}
