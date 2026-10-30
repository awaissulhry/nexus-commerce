import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AllocationPage } from '../../../../../../areas/planning/allocation/AllocationPage'

export const metadata: Metadata = { title: 'Lines & subcontractors · Nexus Factory' }

/**
 * Planning › Lines & subcontractors (SCR-126; areas/planning/nav.ts, permission planning.view): the allocation board of
 * a site (`?site=`, `?wo=` the card's detail). The company layout above loaded the session and draws the Office shell.
 */
export default function PlanningAllocationPage() {
  return (
    <Suspense>
      <AllocationPage />
    </Suspense>
  )
}
