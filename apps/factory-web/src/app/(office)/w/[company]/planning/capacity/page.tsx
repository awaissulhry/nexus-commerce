import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CapacityPage } from '../../../../../../areas/planning/capacity/CapacityPage'

export const metadata: Metadata = { title: 'Capacity & load · Nexus Factory' }

/**
 * Planning › Capacity & load (SCR-123; areas/planning/nav.ts, permission planning.view): the load against capacity per
 * line and work centre of a site. The company layout above loaded the session and draws the Office shell; the page is
 * the client container (`?site=` `?from=` `?to=` `?bucket=` `?tile=` `?cell=`).
 */
export default function PlanningCapacityPage() {
  return (
    <Suspense>
      <CapacityPage />
    </Suspense>
  )
}
